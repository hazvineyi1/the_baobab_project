-- 011: the other name somebody answers to.
--
-- THE PROBLEM, in one sentence: a woman recorded under her father's surname
-- cannot find herself under the one she has been called for thirty years.
--
-- This family records women under their own house's name, which is right and
-- is what the mutupo says — a woman keeps her own totem after marrying, so
-- Evelyn Mandaba stays a Mandaba in a tree full of Musonis. But she is also
-- Mai Musoni to half the people who know her, her children's school knows her
-- as Mrs Musoni, and when she signs in and is asked who she is, "Musoni" is
-- what she will type.
--
-- So one field, and deliberately ONE. Not `maiden_name` and `married_name` —
-- that pair assumes which of the two is the real one, and different families
-- answer that differently. Not a list either. It is the other name this person
-- answers to, whatever made it: a married name, a church name, an English name
-- somebody took at school, the name on a passport that a clerk spelt his own
-- way.
--
-- NOTHING IS DERIVED FROM IT AND NOTHING IS ENFORCED BY IT. It does not change
-- anybody's mutupo, which comes down the father's line and is not touched by a
-- marriage. It does not make two records the same person. It is a name to be
-- found by, and that is the whole of it.
--
-- It is not filled in for anybody. The app can already find a woman by the
-- surname of the man she married without being told anything — see the roster
-- in routes/tree.js — so this is for the cases that guess cannot reach, and
-- an empty column is the correct state for most people in most families.

ALTER TABLE people
  ADD COLUMN IF NOT EXISTS also_known_as TEXT NOT NULL DEFAULT '';

-- Searched the same way names are searched, so a married name finds her as
-- readily as a birth name does. Same trigram index as `name`, for the same
-- reason: people spell each other's names from memory.
CREATE INDEX IF NOT EXISTS people_also_trgm_idx
  ON people USING gin (lower(also_known_as) gin_trgm_ops)
  WHERE also_known_as <> '';
