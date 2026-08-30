-- 005_set_aside.sql — removal becomes a reversible, announced act.
--
-- THE RULE THIS ENCODES: nothing recorded about a family is ever destroyed.
-- A person can be SET ASIDE — taken out of the tree everybody sees — but the
-- record itself stays, forever, and anyone can bring it back. Deletion is not
-- a slower version of this. There is no delete.
--
-- Why it belongs in the database and not only in the app: a family tree is
-- filled in by many people over years, and the ordinary case is one relative
-- doubting another's entry. If a doubt could destroy a record, the cost of
-- being wrong would fall entirely on whoever entered it — usually the person
-- who knew the most. Making removal reversible moves that cost to nobody.
--
-- Two things are then required, and both are enforced here rather than left
-- to the interface:
--
--   1. A REASON. The person who entered the record is owed an explanation,
--      so a set-aside without one is not representable (see the CHECK).
--   2. WHO TO TELL. people.added_by already records who entered each person.
--      It was carried over from the old data and never populated by the new
--      UI; from here on it is the address a notice goes to.
--
-- Note there is no separate requests table and no acknowledgement flag. A
-- notice is simply "your entry is currently set aside", read straight off the
-- rows. That state is self-clearing: restore the person, or agree and leave
-- them aside, and the notice stops being true. A stored acknowledgement would
-- be one more thing that can disagree with reality.

ALTER TABLE people
  ADD COLUMN IF NOT EXISTS aside_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS aside_by  TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS aside_why TEXT NOT NULL DEFAULT '';

-- Where a duplicate was folded into another record. The loser of a merge is
-- set aside rather than deleted, and this says where their details went, so
-- the merge can be explained and undone rather than just discovered.
-- ON DELETE SET NULL is unreachable today (nothing deletes people) and is
-- there so that if some future admin path ever does, it cannot leave a
-- dangling pointer behind.
ALTER TABLE people
  ADD COLUMN IF NOT EXISTS merged_into UUID REFERENCES people (id) ON DELETE SET NULL;

DO $$
BEGIN
  -- "and why" is not advisory. A row cannot be set aside without a reason.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'people_aside_needs_reason') THEN
    ALTER TABLE people ADD CONSTRAINT people_aside_needs_reason
      CHECK (aside_at IS NULL OR btrim(aside_why) <> '');
  END IF;

  -- Being set aside and being merged are different claims. A merge is always
  -- also a set-aside (the folded record leaves the visible tree), but a
  -- set-aside is usually not a merge.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'people_merged_is_aside') THEN
    ALTER TABLE people ADD CONSTRAINT people_merged_is_aside
      CHECK (merged_into IS NULL OR aside_at IS NOT NULL);
  END IF;

  -- A record cannot be folded into itself.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'people_merged_not_self') THEN
    ALTER TABLE people ADD CONSTRAINT people_merged_not_self
      CHECK (merged_into IS NULL OR merged_into <> id);
  END IF;
END $$;

-- Every read of the visible tree filters on this, so it is worth an index even
-- though set-aside people are the rare case. Partial, because the interesting
-- query is "who is set aside" — the complement is most of the table.
CREATE INDEX IF NOT EXISTS people_aside_idx
  ON people (tree_id, aside_at) WHERE aside_at IS NOT NULL;

-- The notice query: "entries I recorded that somebody has set aside".
CREATE INDEX IF NOT EXISTS people_added_by_aside_idx
  ON people (tree_id, added_by) WHERE aside_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS people_merged_into_idx
  ON people (merged_into) WHERE merged_into IS NOT NULL;
