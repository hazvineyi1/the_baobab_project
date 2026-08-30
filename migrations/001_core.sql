-- 001_core.sql — the real family-tree schema.
--
-- Everything in a Shona family tree reduces to two shapes: a person, and a
-- union (a pairing that may have partners, children, or in some legitimate
-- cases only one of the two). Siblings, grandparents, in-laws and every
-- kinship term the app speaks are DERIVED from those two shapes at read time.
-- Nothing here stores a relationship term, and nothing should ever start to:
-- adding one person changes what hundreds of other people are called relative
-- to each other, so a stored term is a stale term the moment it is written.

-- ---------------------------------------------------------------------------
-- name_key: a name reduced to its comparable core, for search and for
-- bucketing duplicate candidates.
--
-- Shona names are habitually spoken and written with an honorific title in
-- front — "Sekuru Garikai", "Mai Chipo", "VaMoyo". Those titles describe the
-- speaker's relationship to the person, not the person's name, so two records
-- for one man can easily read "Garikai" and "Sekuru Garikai". Stripping the
-- title is what lets them land in the same bucket.
--
-- The title list is carried over verbatim from the frontend's TITLES.
--
-- Two details that are easy to get wrong:
--
--   1. Titles must be tried LONGEST FIRST. Sorted any other way, "baba"
--      matches the front of "babamukuru" and leaves the nonsense stem
--      "mukuru"; "va" does the same to "vatete".
--
--   2. ASSUMPTION, flagged for review: titles are stripped only as whole
--      whitespace-delimited words, so "Sekuru Garikai" -> "garikai" but the
--      bound form "VaMoyo" is left as "vamoyo". Shona writes "Va" bound at
--      least as often as free, so this may need to change. It is deliberately
--      the only place that decision lives — correcting it is a one-line edit
--      to the regex below, and the generated column rebuilds itself.
CREATE OR REPLACE FUNCTION mw_name_key(raw TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(
    -- If a name is nothing BUT a title ("Baba", "Mai"), stripping would leave
    -- an empty key and every such record would bucket together as a possible
    -- duplicate of every other. Fall back to the plain lowercased name.
    NULLIF(
      btrim(regexp_replace(
        regexp_replace(
          lower(btrim(COALESCE(raw, ''))),
          '^((babamukuru|babamunini|tateguru|muninina|mudhara|mainini|maiguru|' ||
          'sekuru|ambuya|mukoma|vatete|bhudhi|mbuya|gogo|baba|amai|tete|sisi|' ||
          'late|mai|mrs|the|va|mr|ms|dr)[\s.]+)+',
          '', 'g'),
        '\s+', ' ', 'g')),
      ''),
    lower(btrim(COALESCE(raw, '')))
  );
$$;

-- born_year: a sortable year pulled out of the free-text `born` field.
-- People record birth dates as "1943", "c. 1943", "12 March 1943", or
-- "1940s" — all of which should yield a year, and none of which should be
-- forced into a date column the family cannot fill in honestly.
-- Takes the first plausible 4-digit run (1000-2999), so "1940s" -> 1940.
CREATE OR REPLACE FUNCTION mw_born_year(raw TEXT)
RETURNS INT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT substring(COALESCE(raw, '') from '[12][0-9]{3}')::INT;
$$;

-- Version token for optimistic concurrency. clock_timestamp() rather than
-- now(), because now() is the transaction start time: under any future change
-- that lets two writers overlap on one tree, a later transaction that started
-- earlier could stamp a version that moves backwards.
CREATE OR REPLACE FUNCTION mw_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = clock_timestamp();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS trees (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS people (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tree_id    UUID NOT NULL REFERENCES trees (id) ON DELETE CASCADE,

  -- The id this person had in the old single-JSON-blob store ("p1", "p2").
  -- Kept so the data migration can be re-run safely (it upserts on
  -- (tree_id, legacy_id)) and so a migrated tree can be audited against the
  -- backed-up blob. NULL for anyone created after the move to Postgres.
  legacy_id  TEXT,

  name       TEXT NOT NULL DEFAULT '',
  name_key   TEXT GENERATED ALWAYS AS (mw_name_key(name)) STORED,

  -- '' is a legitimate, common value: plenty of ancestors are recorded before
  -- anyone living is sure. It is not the same as "not yet asked".
  sex        TEXT NOT NULL DEFAULT '' CHECK (sex IN ('m', 'f', '')),

  totem      TEXT NOT NULL DEFAULT '',
  born       TEXT NOT NULL DEFAULT '',
  born_year  INT GENERATED ALWAYS AS (mw_born_year(born)) STORED,
  died       TEXT NOT NULL DEFAULT '',
  is_root    BOOLEAN NOT NULL DEFAULT false,

  -- Who recorded this person. Present in the old data; dropping it would
  -- quietly lose the provenance of every relative already entered.
  added_by   TEXT NOT NULL DEFAULT '',

  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT people_legacy_unique UNIQUE (tree_id, legacy_id)
);

CREATE TABLE IF NOT EXISTS unions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tree_id    UUID NOT NULL REFERENCES trees (id) ON DELETE CASCADE,
  legacy_id  TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  -- Union-level ops (addPartner, addChild, reorderChildren) need something to
  -- be optimistic against, the same way person-level ops use people.updated_at.
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT unions_legacy_unique UNIQUE (tree_id, legacy_id)
);

-- A union may legitimately have two partners, one (a parent whose spouse is
-- unknown or unrecorded), or none at all (a sibling pair whose parents were
-- never recorded, but who are known to share them). Nothing here requires two.
CREATE TABLE IF NOT EXISTS union_partners (
  union_id  UUID NOT NULL REFERENCES unions (id) ON DELETE CASCADE,
  person_id UUID NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  position  SMALLINT NOT NULL,
  PRIMARY KEY (union_id, person_id),
  -- DEFERRABLE so a reorder can permute positions inside one transaction
  -- without needing a temporary sentinel value to dodge a mid-statement clash.
  CONSTRAINT union_partners_position_unique
    UNIQUE (union_id, position) DEFERRABLE INITIALLY DEFERRED
);

-- THE ONE-SET-OF-PARENTS RULE, as a structural guarantee.
--
-- person_id is the PRIMARY KEY of this table, not half of a composite one.
-- A person therefore cannot appear as a child twice, so a second parent union
-- is not merely rejected — it is unrepresentable. This is the database-level
-- form of the frontend's canLink() refusal, and it holds no matter what any
-- future caller does.
--
-- union_id is RESTRICT, not CASCADE: deleting a union that still has children
-- recorded under it genuinely orphans those children (they lose their only
-- recorded parents), which is exactly the case the brief asks to protect.
-- Note the consequence: deleting a whole tree must clear union_children first,
-- because trees -> unions cascades into this restriction.
CREATE TABLE IF NOT EXISTS union_children (
  person_id   UUID PRIMARY KEY REFERENCES people (id) ON DELETE CASCADE,
  union_id    UUID NOT NULL REFERENCES unions (id) ON DELETE RESTRICT,
  -- Birth order is real information, hand-settable, and eldest-first. It is
  -- what the seniority terms (Mukoma / Munin'ina) resolve against when birth
  -- years are missing, so it is stored explicitly rather than inferred.
  birth_order SMALLINT NOT NULL,
  CONSTRAINT union_children_order_unique
    UNIQUE (union_id, birth_order) DEFERRABLE INITIALLY DEFERRED
);

-- Pairs a human has looked at and said "these are two different people".
-- Children are named after grandparents, so three living Garikais in one
-- family is ordinary, not an error — these dismissals must survive forever.
--
-- CHECK (a_id < b_id) forces one canonical row per pair. Without it, (a,b) and
-- (b,a) are two different rows and a dismissal made in one direction quietly
-- fails to suppress the pair when it is next scanned in the other.
CREATE TABLE IF NOT EXISTS not_duplicates (
  tree_id UUID NOT NULL REFERENCES trees (id) ON DELETE CASCADE,
  a_id    UUID NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  b_id    UUID NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  by      TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (tree_id, a_id, b_id),
  CONSTRAINT not_duplicates_canonical CHECK (a_id < b_id)
);

-- Append-only log. Every op writes here, and clients sync by asking for
-- everything after the last seq they hold.
CREATE TABLE IF NOT EXISTS changes (
  seq       BIGSERIAL PRIMARY KEY,
  tree_id   UUID NOT NULL REFERENCES trees (id) ON DELETE CASCADE,
  entity    TEXT NOT NULL,
  entity_id UUID,
  op        TEXT NOT NULL,
  payload   JSONB NOT NULL DEFAULT '{}'::jsonb,
  at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  by        TEXT NOT NULL DEFAULT ''
);

-- ---------------------------------------------------------------------------
-- Indexes: every foreign key, plus the lookups the API actually performs.

CREATE INDEX IF NOT EXISTS people_tree_idx          ON people (tree_id);
CREATE INDEX IF NOT EXISTS people_name_key_idx      ON people (tree_id, name_key);
CREATE INDEX IF NOT EXISTS people_born_year_idx     ON people (tree_id, born_year);
-- Prefix search ("gari" -> Garikai) needs text_pattern_ops to use an index
-- under LIKE 'gari%' on a non-C collation. This is also the fallback path when
-- pg_trgm is unavailable (see 002_search.sql).
CREATE INDEX IF NOT EXISTS people_name_prefix_idx   ON people (tree_id, name_key text_pattern_ops);
CREATE INDEX IF NOT EXISTS people_root_idx          ON people (tree_id) WHERE is_root;

CREATE INDEX IF NOT EXISTS unions_tree_idx          ON unions (tree_id);

CREATE INDEX IF NOT EXISTS union_partners_person_idx ON union_partners (person_id);
-- union_partners (union_id, ...) is served by the primary key.

CREATE INDEX IF NOT EXISTS union_children_union_idx  ON union_children (union_id, birth_order);
-- union_children (person_id) is the primary key.

CREATE INDEX IF NOT EXISTS not_duplicates_a_idx      ON not_duplicates (a_id);
CREATE INDEX IF NOT EXISTS not_duplicates_b_idx      ON not_duplicates (b_id);

-- The incremental-sync query: everything in this tree after seq N.
CREATE INDEX IF NOT EXISTS changes_tree_seq_idx      ON changes (tree_id, seq);

-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS people_touch ON people;
CREATE TRIGGER people_touch BEFORE UPDATE ON people
  FOR EACH ROW EXECUTE FUNCTION mw_touch_updated_at();

DROP TRIGGER IF EXISTS unions_touch ON unions;
CREATE TRIGGER unions_touch BEFORE UPDATE ON unions
  FOR EACH ROW EXECUTE FUNCTION mw_touch_updated_at();
