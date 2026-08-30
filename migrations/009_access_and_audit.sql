-- 009_access_and_audit.sql — a passcode per family, an admin who can answer
-- for it, and a record of who did what, when and from where.
--
-- WHAT CHANGES, AND WHY IT HAD TO.
--
-- Until now there was one passphrase for the whole deployment. Everybody who
-- had it could open every family's page, and the only thing separating one
-- family from another was a link nobody was obliged to keep. That is fine for
-- one family and wrong for a hundred thousand: privacy between families was
-- resting on nobody pasting a link into the wrong group chat.
--
-- Now each family has its own passcode. Holding it opens that family and
-- nothing else. The family passes it on — by invitation, so the passcode
-- itself need not travel — and when it is lost or has gone somewhere it
-- should not, the admin issues a new one and every session on the old one
-- ends.
--
-- WHY THE PASSCODE IS NOT STORED.
--
-- passcode_hash is scrypt with a per-family salt. Nobody can read a family's
-- passcode out of this database, the admin included. That is deliberate and it
-- is the honest form of "known only to the family and the admin": the admin
-- knows it at the moment of issue, because the admin generated it, and never
-- again. A table the admin could read back is a table anybody who reaches the
-- database can read back, and it would turn one breach into every family's
-- records at once.
--
-- The consequence is stated plainly rather than hidden: a lost passcode cannot
-- be recovered, only replaced. That is what the reset path is for.
--
-- WHY THE PASSCODE CARRIES A HANDLE.
--
-- A hashed secret cannot be looked up — you can only check it against a row
-- you already have. With one passphrase that was fine; with a million families
-- it would mean hashing the guess against every family in the table on every
-- sign-in, which is not a slow lookup but an impossible one.
--
-- So the passcode is issued as   <handle>-<secret>-<secret>   and the handle
-- is stored in the clear and indexed. The handle says WHICH family to check;
-- the rest is the secret and is never stored. One field for the family to
-- type, one index lookup for the server, and the entropy that matters is
-- untouched.

-- ---------------------------------------------------------------------------
-- 1. The family's own passcode.

ALTER TABLE trees
  -- The public half of the passcode: which family a sign-in is for. Not a
  -- secret, and not usable on its own for anything.
  ADD COLUMN IF NOT EXISTS handle            TEXT,
  -- scrypt$N$r$p$<salt-hex>$<hash-hex> — see db/access.js. Never plaintext,
  -- never reversible, never logged.
  ADD COLUMN IF NOT EXISTS passcode_hash     TEXT,
  ADD COLUMN IF NOT EXISTS passcode_set_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS passcode_set_by   TEXT NOT NULL DEFAULT '',
  -- Rising each time the passcode is reset. Sessions record the generation
  -- they were opened under, so a reset ends every existing session by
  -- arithmetic rather than by a DELETE that could half-finish.
  ADD COLUMN IF NOT EXISTS passcode_gen      INT NOT NULL DEFAULT 0,
  -- An admin can close a family without touching a single record of theirs.
  -- Nothing is deleted here either — suspension is a door, not a bonfire.
  ADD COLUMN IF NOT EXISTS suspended_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suspended_by      TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS suspended_reason  TEXT NOT NULL DEFAULT '';

-- The handle alphabet is the tree key's: no 0/O and no 1/I/l, because these
-- get read down a phone line and copied off a screen by people who did not
-- choose them.
CREATE OR REPLACE FUNCTION mw_code_group(n INT)
RETURNS TEXT
LANGUAGE sql
VOLATILE
AS $$
  SELECT string_agg(
           substr('abcdefghjkmnpqrstuvwxyz23456789',
                  1 + floor(random() * 31)::int, 1), '')
    FROM generate_series(1, n);
$$;

-- Six characters over a 31-character alphabet is ~887 million handles. It
-- identifies, it does not protect: the secret does that.
CREATE OR REPLACE FUNCTION mw_new_handle()
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  candidate TEXT;
BEGIN
  LOOP
    candidate := mw_code_group(6);
    EXIT WHEN NOT EXISTS (SELECT 1 FROM trees WHERE handle = candidate);
  END LOOP;
  RETURN candidate;
END $$;

UPDATE trees SET handle = mw_new_handle() WHERE handle IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trees_handle_unique') THEN
    ALTER TABLE trees ADD CONSTRAINT trees_handle_unique UNIQUE (handle);
  END IF;
END $$;

ALTER TABLE trees ALTER COLUMN handle SET NOT NULL;
ALTER TABLE trees ALTER COLUMN handle SET DEFAULT mw_new_handle();

CREATE INDEX IF NOT EXISTS trees_handle_idx ON trees (handle);
-- The admin's list of families in trouble: suspended ones, and ones that have
-- never been issued a passcode.
CREATE INDEX IF NOT EXISTS trees_suspended_idx ON trees (suspended_at)
  WHERE suspended_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS trees_no_passcode_idx ON trees (created_at)
  WHERE passcode_hash IS NULL;

-- ---------------------------------------------------------------------------
-- 2. Sessions.
--
-- The old gate had none: the cookie was a signature over an expiry, and the
-- server kept nothing. That cannot answer "who is signed in", cannot be
-- revoked, and cannot say which family a visitor is in — all three of which
-- are now the point.
--
-- The cookie holds <session id>.<token>. Only the token's HASH is here, so
-- reading this table gives nobody a way in; the id is the lookup and the token
-- is the proof.

CREATE TABLE IF NOT EXISTS sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   TEXT NOT NULL,
  scope        TEXT NOT NULL CHECK (scope IN ('family', 'admin')),
  -- An admin session belongs to no family; a family session must name one.
  tree_id      UUID REFERENCES trees (id) ON DELETE CASCADE,
  -- Which passcode generation this was opened under. A reset raises the
  -- family's generation and every older session stops matching.
  passcode_gen INT NOT NULL DEFAULT 0,

  -- How they got in: 'passcode', 'invite', 'admin', or 'legacy' for the one
  -- deployment-wide passphrase that predates all of this.
  via          TEXT NOT NULL DEFAULT '',
  invite_id    UUID,

  -- Self-claimed, exactly as everywhere else in this project. It is a label on
  -- an audit line, not a proof of anything, and it is not treated as one.
  actor        TEXT NOT NULL DEFAULT '',

  created_at   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at   TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  created_ip   INET,
  last_ip      INET,
  user_agent   TEXT NOT NULL DEFAULT '',

  revoked_at   TIMESTAMPTZ,
  revoked_by   TEXT NOT NULL DEFAULT '',

  CONSTRAINT sessions_scope_tree CHECK (
    (scope = 'admin'  AND tree_id IS NULL) OR
    (scope = 'family' AND tree_id IS NOT NULL))
);

-- The read on every single request: by id, live only.
CREATE INDEX IF NOT EXISTS sessions_live_idx ON sessions (expires_at)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS sessions_tree_idx ON sessions (tree_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS sessions_scope_idx ON sessions (scope, last_seen_at DESC);

-- ---------------------------------------------------------------------------
-- 3. Invitations.
--
-- How a family grows without the passcode itself being passed around a group
-- chat. An invitation is a link: single-use by default, expiring, revocable,
-- and attributable to whoever made it. The passcode stays where it was given.

CREATE TABLE IF NOT EXISTS invites (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tree_id     UUID NOT NULL REFERENCES trees (id) ON DELETE CASCADE,
  -- The token is in the link and nowhere else. Same reasoning as sessions.
  token_hash  TEXT NOT NULL UNIQUE,
  created_by  TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at  TIMESTAMPTZ NOT NULL,
  max_uses    INT NOT NULL DEFAULT 1 CHECK (max_uses >= 1),
  uses        INT NOT NULL DEFAULT 0 CHECK (uses >= 0),
  -- "For Tete Ratidzo" — so a family can tell their own invitations apart.
  note        TEXT NOT NULL DEFAULT '',
  revoked_at  TIMESTAMPTZ,
  revoked_by  TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS invites_tree_idx ON invites (tree_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 4. The record: who, when, where, what.
--
-- PARTITIONED BY MONTH, which is the one decision here that is about size
-- rather than about meaning. This table takes a row for every sign-in, every
-- failed attempt and every batch of edits on the whole deployment — it
-- outgrows every other table by an order of magnitude and keeps growing after
-- the families stop. Monthly partitions mean the queries the dashboard runs
-- (almost always "recently") touch one small table instead of the whole
-- history, and that dropping a year of history is a DROP TABLE rather than a
-- DELETE that rewrites everything and leaves the space behind.
--
-- There is NO foreign key to trees. The record of what happened to a family
-- has to outlive the family, or it is not a record.

CREATE TABLE IF NOT EXISTS audit_events (
  id         BIGSERIAL,
  at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  -- Dotted, coarse to fine: 'gate.ok', 'gate.fail', 'invite.accepted',
  -- 'passcode.reset', 'tree.ops', 'appeal.raised'. Prefix-matchable so the
  -- dashboard can filter a whole family of events without listing them.
  kind       TEXT NOT NULL,
  ok         BOOLEAN,

  tree_id    UUID,
  session_id UUID,
  actor      TEXT NOT NULL DEFAULT '',

  -- WHERE. The address the request came from, and the browser that made it.
  -- No geography: that would mean sending a family's address to somebody
  -- else's lookup service on every event, which is a worse privacy trade than
  -- the question is worth. The address is here; what it means is a question
  -- for whoever is reading.
  ip         INET,
  user_agent TEXT NOT NULL DEFAULT '',

  -- WHAT. Enough to read the line on its own; for edits, the `changes` table
  -- already holds the full detail and this points at it.
  method     TEXT NOT NULL DEFAULT '',
  path       TEXT NOT NULL DEFAULT '',
  detail     JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- The partition key has to be in the primary key. `at` first because every
  -- read of this table is ordered by time.
  PRIMARY KEY (at, id)
) PARTITION BY RANGE (at);

-- Nothing may ever fail to be recorded because a partition was missing. The
-- default catches anything outside the months that exist, and the boot-time
-- ensure below keeps that from being the normal case.
CREATE TABLE IF NOT EXISTS audit_events_default PARTITION OF audit_events DEFAULT;

-- Declared on the parent so every partition, including ones made later,
-- inherits them.
CREATE INDEX IF NOT EXISTS audit_at_idx     ON audit_events (at DESC);
CREATE INDEX IF NOT EXISTS audit_tree_idx   ON audit_events (tree_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_kind_idx   ON audit_events (kind, at DESC);
CREATE INDEX IF NOT EXISTS audit_ip_idx     ON audit_events (ip, at DESC);
CREATE INDEX IF NOT EXISTS audit_actor_idx  ON audit_events (actor, at DESC);

/* Make sure the month containing `when_ts` has a partition of its own.
   Called at boot for the coming months, and again on the way past midnight on
   the first of a month. Never raises: a failure here must not be able to stop
   a sign-in being recorded, because the default partition will take the row
   regardless. */
CREATE OR REPLACE FUNCTION mw_ensure_audit_partition(when_ts TIMESTAMPTZ)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  -- Bounds fixed in UTC so they do not shift with the session's TimeZone.
  start_ts TIMESTAMPTZ := (date_trunc('month', when_ts AT TIME ZONE 'UTC')) AT TIME ZONE 'UTC';
  end_ts   TIMESTAMPTZ;
  part     TEXT;
BEGIN
  end_ts := (date_trunc('month', when_ts AT TIME ZONE 'UTC') + INTERVAL '1 month') AT TIME ZONE 'UTC';
  part   := 'audit_events_' || to_char(start_ts AT TIME ZONE 'UTC', 'YYYYMM');

  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = part) THEN
    RETURN part;
  END IF;

  EXECUTE format('CREATE TABLE %I PARTITION OF audit_events FOR VALUES FROM (%L) TO (%L)',
                 part, start_ts, end_ts);
  RETURN part;
EXCEPTION WHEN OTHERS THEN
  -- Two boots racing, or rows for this month already sitting in the default
  -- partition (which makes the attach illegal). Either way the default keeps
  -- taking the writes and nothing is lost.
  RETURN NULL;
END $$;

/* Retention, as a whole-partition drop rather than a DELETE.
   Deliberately not called by anything: how long a record of who signed in
   should be kept is a decision for whoever runs this deployment, not a default
   this migration gets to make on their behalf. */
CREATE OR REPLACE FUNCTION mw_drop_audit_before(cutoff TIMESTAMPTZ)
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  part   TEXT;
  keep   TEXT := to_char(date_trunc('month', cutoff AT TIME ZONE 'UTC'), 'YYYYMM');
BEGIN
  FOR part IN
    SELECT c.relname FROM pg_class c
      JOIN pg_inherits i ON i.inhrelid = c.oid
      JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname = 'audit_events'
       AND c.relname ~ '^audit_events_[0-9]{6}$'
  LOOP
    -- Never the default partition: it is the safety net, and it may hold rows
    -- from any month at all.
    IF substr(part, length('audit_events_') + 1) < keep THEN
      EXECUTE format('DROP TABLE %I', part);
      RETURN NEXT part;
    END IF;
  END LOOP;
END $$;

SELECT mw_ensure_audit_partition(clock_timestamp());
SELECT mw_ensure_audit_partition(clock_timestamp() + INTERVAL '1 month');

-- ---------------------------------------------------------------------------
-- 5. Appeals.
--
-- The way somebody reaches the admin from inside the app. Two things bring
-- people here, and they are not the same:
--
--   'passcode' — we have lost our way in, or our passcode has gone somewhere
--                it should not have. Issue us another.
--   'erasure'  — somebody set my grandmother aside and I do not agree.
--
-- The second is the older promise in this project made reachable: erasure is
-- never automatic, the person who recorded it is told, and now they have
-- somewhere to go if being told is not enough.

CREATE TABLE IF NOT EXISTS appeals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- SET NULL rather than CASCADE: an appeal about a family that has since gone
  -- is exactly the appeal you would most want to still be able to read.
  tree_id     UUID REFERENCES trees (id) ON DELETE SET NULL,
  -- Kept as text as well, so the appeal still says who it was about after the
  -- reference above has been nulled.
  tree_label  TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL CHECK (kind IN ('passcode', 'erasure', 'access', 'other')),
  -- The record being appealed about, when there is one. No FK for the same
  -- reason: the appeal outlives what it is about.
  person_id   UUID,
  person_name TEXT NOT NULL DEFAULT '',

  body        TEXT NOT NULL,
  -- How to answer. Whatever they choose to give — a phone number, a name to
  -- ask for. Nothing is required, because requiring an email address here
  -- would exclude exactly the relatives this project exists to include.
  contact     TEXT NOT NULL DEFAULT '',
  raised_by   TEXT NOT NULL DEFAULT '',
  raised_at   TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  raised_ip   INET,

  status      TEXT NOT NULL DEFAULT 'open'
              CHECK (status IN ('open', 'answered', 'closed')),
  answer      TEXT NOT NULL DEFAULT '',
  answered_by TEXT NOT NULL DEFAULT '',
  answered_at TIMESTAMPTZ
);

-- The admin's queue: open ones first, oldest first, which is the order they
-- should be answered in.
CREATE INDEX IF NOT EXISTS appeals_open_idx ON appeals (raised_at)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS appeals_tree_idx ON appeals (tree_id, raised_at DESC);
CREATE INDEX IF NOT EXISTS appeals_status_idx ON appeals (status, raised_at DESC);
