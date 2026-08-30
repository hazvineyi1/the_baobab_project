-- 004_kin_terms.sql — the words the family has taught the app.
--
-- This is the one part of kinship that is stored, and the distinction is the
-- whole reason it is safe to store it.
--
-- A term for a PAIR would go stale the moment somebody's parents were added,
-- which is why terms are derived and never written down. What lives here is a
-- term for a SHAPE — "my husband's brother", "the wife of my Sekuru". The
-- shape is recomputed from the tree on every read, so a taught term cannot go
-- stale: it is a rule the family supplied, not an answer cached.
--
-- It exists because the app was built to leave a gap open rather than fill it
-- with a guess. Where Shona has a word the engine knows (Tsano for a wife's
-- brother) it says so. Where it does not, it describes the relationship in
-- plain words and invents nothing — and now it can also ask. This table is
-- where the answer goes.

CREATE TABLE IF NOT EXISTS kin_terms (
  tree_id UUID NOT NULL REFERENCES trees (id) ON DELETE CASCADE,
  -- The structural signature of the relationship, produced by the frontend's
  -- kinship engine. Opaque here on purpose: the database stores what the
  -- family said, and the engine decides what it applies to.
  shape   TEXT NOT NULL,
  term    TEXT NOT NULL,
  note    TEXT NOT NULL DEFAULT '',
  by      TEXT NOT NULL DEFAULT '',
  at      TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tree_id, shape),
  CONSTRAINT kin_terms_term_not_blank CHECK (btrim(term) <> '')
);

CREATE INDEX IF NOT EXISTS kin_terms_tree_idx ON kin_terms (tree_id);
