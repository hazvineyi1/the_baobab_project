-- 006_cross_tree.sql — where two families meet.
--
-- The point of this project, stated by the family who asked for it: every
-- Zimbabwean records their own people, and the lines keep going back until two
-- of them arrive at the same ancestor. Until now a tree could only ever find
-- duplicates inside itself, so two families who both trace to the same Sekuru
-- would each mark him as their own root and never learn about each other.
--
-- WHAT IS AND IS NOT STORED HERE.
--
-- A match is a SUGGESTION, computed on demand, never written down: it is
-- derived from names, totems and dates that change as families record more, so
-- storing one would be storing an answer that goes stale — the same reason no
-- kinship term is ever stored. What IS written down is a human's decision
-- about a suggestion, which does not go stale, and which nobody else can
-- recompute.
--
-- AND MERGING IS NOT WHAT HAPPENS. Two families finding a shared ancestor does
-- not make them one record under one owner. Each keeps their own tree, their
-- own version of that person, and their own memory of him. The link says "your
-- Rufaro and our Rufaro are the same man" and nothing more. Anything stronger
-- would mean one family's records being absorbed into another's on the
-- strength of a name and a date.

-- Whether this family's frontier may be compared against others'.
--
-- Default true, because connecting families is the entire purpose of the
-- project and a default of false would make it a feature nobody discovers.
-- Settable, because a family that would rather not be found should not have to
-- argue for it — and what is exposed even when true is deliberately thin (see
-- db/crosstree.js): a name, a year, a totem, and how much hangs below. Never
-- the tree.
ALTER TABLE trees
  ADD COLUMN IF NOT EXISTS shares_frontier BOOLEAN NOT NULL DEFAULT true;

-- A human's decision about a suggested match.
CREATE TABLE IF NOT EXISTS tree_links (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Ordered so that one pair is one row whichever family proposes it. Without
  -- this, both families confirming the same ancestor independently produces
  -- two rows that can disagree with each other.
  a_person   UUID NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  b_person   UUID NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  a_tree     UUID NOT NULL REFERENCES trees (id) ON DELETE CASCADE,
  b_tree     UUID NOT NULL REFERENCES trees (id) ON DELETE CASCADE,

  -- 'proposed'  one family says these are the same person
  -- 'confirmed' both families agree
  -- 'rejected'  somebody has looked and said no. Kept, not deleted: without
  --             it the same suggestion returns on every scan for ever, and
  --             the work of judging it is thrown away each time.
  status     TEXT NOT NULL DEFAULT 'proposed'
             CHECK (status IN ('proposed', 'confirmed', 'rejected')),

  score      REAL,               -- what the matcher thought, when proposed
  why        TEXT NOT NULL DEFAULT '',
  proposed_by TEXT NOT NULL DEFAULT '',
  proposed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  decided_by  TEXT NOT NULL DEFAULT '',
  decided_at  TIMESTAMPTZ,

  CONSTRAINT tree_links_canonical CHECK (a_person < b_person),
  CONSTRAINT tree_links_not_self  CHECK (a_tree <> b_tree),
  CONSTRAINT tree_links_pair_unique UNIQUE (a_person, b_person)
);

CREATE INDEX IF NOT EXISTS tree_links_a_idx ON tree_links (a_tree, status);
CREATE INDEX IF NOT EXISTS tree_links_b_idx ON tree_links (b_tree, status);
CREATE INDEX IF NOT EXISTS tree_links_a_person_idx ON tree_links (a_person);
CREATE INDEX IF NOT EXISTS tree_links_b_person_idx ON tree_links (b_person);

-- The cross-tree bucketing index.
--
-- Within one tree, candidates are found through people (tree_id, name_key).
-- Across trees the tree_id is exactly what must NOT be in the key, or every
-- lookup degrades to a scan — which is how "find shared ancestors" becomes
-- O(n^2) over every family in the country. Partial, because set-aside records
-- are never matched against.
CREATE INDEX IF NOT EXISTS people_name_key_global_idx
  ON people (name_key) WHERE aside_at IS NULL;
