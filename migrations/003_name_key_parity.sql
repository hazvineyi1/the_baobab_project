-- 003_name_key_parity.sql
--
-- Brings name_key into exact agreement with the frontend's nameTokens().
--
-- 001 stripped honorific titles only from the FRONT of a name, on the
-- assumption that is where they go. Now that the frontend is in the
-- repository, its actual rule is visible and it is broader:
--
--   nameTokens(name) = name, lowercased, apostrophes and full stops deleted,
--   every other non-alphanumeric turned into a space, split on whitespace and
--   hyphens, then EVERY token that is a title dropped — wherever it sits.
--
-- So "Garikai Baba" reduces to "garikai", which the leading-only rule missed.
-- The two implementations disagreeing would mean the server and the browser
-- bucketing duplicates differently, which is worse than either rule alone.
--
-- The other change is the empty case. 001 fell back to the plain lowercased
-- name when a record was nothing but a title ("Baba"), to stop every such
-- record bucketing together. The frontend instead returns no tokens, and
-- nameSimilarity() then refuses to compare at all — which reaches the same
-- end by a stricter route. Matching the frontend means name_key can now be
-- empty, so search gains a fallback onto the raw name (see db/reads.js);
-- a person is never unfindable, and is never a duplicate candidate on the
-- strength of a title alone.

CREATE OR REPLACE FUNCTION mw_name_key(raw TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE((
    SELECT string_agg(tok, ' ' ORDER BY ord)
      FROM unnest(
             regexp_split_to_array(
               regexp_replace(
                 -- apostrophes and full stops vanish rather than splitting:
                 -- "Munin'ina" and "Mr." must not become two tokens.
                 regexp_replace(lower(COALESCE(raw, '')), '[''’.]', '', 'g'),
                 '[^a-z0-9[:space:]-]', ' ', 'g'),
               '[[:space:]-]+')
           ) WITH ORDINALITY AS t(tok, ord)
     WHERE tok <> ''
       AND tok <> ALL (ARRAY[
         'sekuru','tateguru','ambuya','mbuya','gogo','baba','babamukuru',
         'babamunini','amai','mai','mainini','maiguru','tete','vatete',
         'mudhara','mukoma','muninina','sisi','bhudhi','va','mr','mrs',
         'ms','dr','the','late'])
  ), '');
$$;

-- The generated column is defined in terms of the function, but Postgres
-- froze the old body into the stored values. Rewriting the column forces
-- every row through the new rule.
ALTER TABLE people DROP COLUMN IF EXISTS name_key;
ALTER TABLE people ADD COLUMN name_key TEXT GENERATED ALWAYS AS (mw_name_key(name)) STORED;

CREATE INDEX IF NOT EXISTS people_name_key_idx    ON people (tree_id, name_key);
CREATE INDEX IF NOT EXISTS people_name_prefix_idx ON people (tree_id, name_key text_pattern_ops);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE INDEX IF NOT EXISTS people_name_key_trgm_idx
      ON people USING gin (name_key gin_trgm_ops);
  END IF;
END $$;
