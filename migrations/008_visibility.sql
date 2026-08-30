-- 008_visibility.sql — who is published, and who decides.
--
-- This project is meant to be the most public record the Shona people have:
-- ancestors searchable by anyone, anywhere, so that two families who have
-- never met can find the man they both descend from. Nothing here narrows
-- that. What it adds is the one distinction that publication actually turns
-- on — the living are not the dead.
--
-- WHY THE LIVING ARE DIFFERENT, IN ONE SENTENCE: the person entering a record
-- is almost never the person the record is about, so publishing a living
-- relative is a decision made about somebody by somebody else. The dead are
-- shared heritage and the whole point of the project. The living are people
-- who can be found, and who might not want to be.
--
-- THE RULE:
--
--   visibility = 'public'   published, whoever they are
--   visibility = 'private'  never published; the family still sees them
--   visibility IS NULL      nobody has chosen, so: the dead are public,
--                           the living are private
--
-- An explicit choice always wins, in either direction. A family that wants a
-- recently buried relative kept out of the public record can say so; a person
-- who wants to be findable can say that.
--
-- PRIVATE IS NOT HIDDEN FROM THE FAMILY. It means "not published". Relatives
-- working on the tree see every person in it exactly as before. The boundary
-- is between the family and the world, not between relatives.

-- Living or dead, worked out rather than stored.
--
-- STABLE, not IMMUTABLE, and that is the point: it depends on today's date, so
-- somebody born in 1930 with no death recorded stops being presumed living as
-- the years pass, without anyone editing a row. A stored flag would need a job
-- to keep it true, and would be wrong in between.
--
-- The unknown case leans the safe way: no death recorded and no birth year
-- means presumed LIVING, so an unknown person is private by default rather
-- than published by default.
CREATE OR REPLACE FUNCTION mw_is_living(died TEXT, born_year INT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN btrim(COALESCE(died, '')) <> '' THEN false
    WHEN born_year IS NOT NULL
     AND born_year < EXTRACT(YEAR FROM now())::INT - 100 THEN false
    ELSE true
  END;
$$;

ALTER TABLE people
  ADD COLUMN IF NOT EXISTS visibility    TEXT,
  ADD COLUMN IF NOT EXISTS visibility_by TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS visibility_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'people_visibility_valid') THEN
    ALTER TABLE people ADD CONSTRAINT people_visibility_valid
      CHECK (visibility IS NULL OR visibility IN ('public', 'private'));
  END IF;
END $$;

-- The one question every public read asks. Kept here so that no caller can
-- get it subtly wrong: a read that forgets a clause publishes somebody, and
-- unlike most bugs that one cannot be taken back.
CREATE OR REPLACE FUNCTION mw_is_public(visibility TEXT, died TEXT, born_year INT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN visibility = 'public'  THEN true
    WHEN visibility = 'private' THEN false
    ELSE NOT mw_is_living(died, born_year)
  END;
$$;

-- Explicit choices are the rare case and the interesting one, so they get the
-- partial index. The common case — nobody has chosen — is answered from
-- born_year and died, which people_born_year_idx already covers.
CREATE INDEX IF NOT EXISTS people_visibility_idx
  ON people (tree_id, visibility) WHERE visibility IS NOT NULL;
