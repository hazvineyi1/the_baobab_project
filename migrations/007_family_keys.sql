-- 007_family_keys.sql — one deployment, many families.
--
-- Until now this served one tree to everyone: whoever opened the address was
-- editing the same family. That made the cross-tree matcher pointless, because
-- there was never a second family for it to find.
--
-- HOW A FAMILY IS IDENTIFIED, AND WHAT THAT IS WORTH.
--
-- Each tree gets a key: 100 bits of randomness in the address. Hold the key
-- and you can read and edit that family's tree; don't and you cannot find it,
-- because there is no listing and no way to enumerate one. That is capability
-- access, and it is the honest description — it is NOT an account system and
-- must not be described as one:
--
--   * anyone the key is passed to has the same access as the person who
--     passed it, and there is no way to tell them apart afterwards;
--   * a key cannot be taken back from one person without changing it for
--     everybody (which is why rotating it is a deliberate act, below);
--   * "who did this" is still self-claimed, exactly as before.
--
-- What it buys is real all the same: a family's records stop being visible to
-- every other family on the deployment, links become shareable, and none of it
-- needs an email address, a password to forget, or a sign-up before somebody
-- can start recording their grandmother. When identity needs to be provable
-- rather than merely held, accounts go on top of this — the key stays as the
-- invitation, which is a thing accounts still need.
--
-- The key is deliberately NOT the primary key. Ids are what everything else
-- references; the key is a credential, and a credential must be changeable
-- without rewriting every row that points at the thing it opens.

ALTER TABLE trees
  ADD COLUMN IF NOT EXISTS key        TEXT,
  ADD COLUMN IF NOT EXISTS created_by TEXT NOT NULL DEFAULT '',
  -- Rotating the key locks out everyone holding the old one. Recording when
  -- it last happened is what lets the app say "this link stopped working
  -- because the family changed it", rather than leaving people with a link
  -- that silently 404s.
  ADD COLUMN IF NOT EXISTS key_set_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp();

-- Existing trees need a key before the column can be made NOT NULL. Generated
-- here rather than in the application so that no tree can ever exist without
-- one, including trees created by a future code path that forgets.
--
-- The alphabet leaves out the characters people confuse when reading a link
-- aloud or copying it off a screen: 0/O, 1/I/l.
CREATE OR REPLACE FUNCTION mw_new_tree_key()
RETURNS TEXT
LANGUAGE sql
VOLATILE
AS $$
  SELECT string_agg(
           substr('abcdefghjkmnpqrstuvwxyz23456789',
                  1 + floor(random() * 31)::int, 1), '')
    FROM generate_series(1, 20);
$$;

UPDATE trees SET key = mw_new_tree_key() WHERE key IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trees_key_unique') THEN
    ALTER TABLE trees ADD CONSTRAINT trees_key_unique UNIQUE (key);
  END IF;
END $$;

ALTER TABLE trees ALTER COLUMN key SET NOT NULL;
ALTER TABLE trees ALTER COLUMN key SET DEFAULT mw_new_tree_key();

-- A key that is short enough to guess is not a credential. Enforced here so
-- that a future caller supplying its own key cannot weaken this by accident.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trees_key_long_enough') THEN
    ALTER TABLE trees ADD CONSTRAINT trees_key_long_enough CHECK (length(key) >= 16);
  END IF;
END $$;

-- The lookup on every page load.
CREATE INDEX IF NOT EXISTS trees_key_idx ON trees (key);
