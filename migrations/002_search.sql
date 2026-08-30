-- 002_search.sql — fuzzy name matching, if the host allows it.
--
-- Search has to find "Garikayi" when someone types "Garikai", because the
-- family spells names by ear and the same person is entered twice with
-- different vowels. Trigram similarity handles that; a prefix index does not.
--
-- pg_trgm is a stock contrib module and Railway's Postgres provides it, but
-- creating an extension needs privileges the app's role may not have on every
-- host. A search feature is not worth refusing to boot over, so this is
-- written to degrade rather than fail: if the extension cannot be created, the
-- GIN index is skipped and the search endpoint falls back to prefix matching
-- on people_name_prefix_idx (created in 001).
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
EXCEPTION
  WHEN insufficient_privilege OR feature_not_supported OR undefined_file THEN
    RAISE NOTICE
      'pg_trgm unavailable (%) — search will use prefix matching only.',
      SQLERRM;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    CREATE INDEX IF NOT EXISTS people_name_key_trgm_idx
      ON people USING gin (name_key gin_trgm_ops);
  END IF;
END $$;
