-- 010: who is viewing.
--
-- THE FAULT THIS FIXES, stated plainly. Every Shona term this app produces is
-- reckoned FROM somebody. Amaiguru and Amainini depend on whose mother is
-- older; Tete and Sekuru depend on which side of the family you stand on;
-- "my sister's children are my children" depends on whether the person asking
-- is a woman. There is no such thing as a term without a viewer.
--
-- And until now the viewer was a line in localStorage. A per-device
-- preference. Not part of getting in, not carried between phones, unset by
-- default and unset by clearing a browser — so the app would trace a
-- relationship between two people and explain it as "your sister Evelyn's
-- child" to somebody who had never said who they were. The rule was right and
-- the sentence was about nobody.
--
-- So the viewer moves onto the SESSION, where getting in already lives.
--
-- WHAT THIS IS, AND IS NOT. A family passcode is shared — that is the whole
-- point of it, one secret for a family — so a session saying "I am Agnes" is
-- a CLAIM, exactly like the `actor` on every audit line in this project. It is
-- not authentication of a person and nothing here should be read as if it
-- were. What makes it more than a claim is an invitation made FOR a named
-- relative: the binding then comes from whoever sent it, not from the person
-- accepting it, and a link sent to Agnes cannot make its holder anybody else.
--
-- ON DELETE SET NULL throughout, never CASCADE. Setting somebody aside, or
-- merging two records of the same person, must not sign anyone out — the
-- session outlives the row it points at, and the app asks again.

-- ---------------------------------------------------------------------------
-- 1. Who a session says it is.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS person_id     UUID REFERENCES people (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS person_set_at TIMESTAMPTZ,
  -- HOW that person came to be on this session, which is the difference
  -- between a claim and an attestation and must not be inferable only by
  -- comparing timestamps:
  --   'self'   the session said so, having got in with the shared passcode
  --   'invite' whoever made the link said so, and this session was never asked
  -- An attested session cannot re-answer. That is the whole value of it: a
  -- link Bertha sent to Agnes opens as Agnes or not at all.
  ADD COLUMN IF NOT EXISTS person_via    TEXT NOT NULL DEFAULT ''
    CONSTRAINT sessions_person_via_known CHECK (person_via IN ('', 'self', 'invite'));

-- Read when a person is merged away, so their session moves to the record
-- that kept them, and by the keeper's dashboard to say who is signed in.
CREATE INDEX IF NOT EXISTS sessions_person_idx ON sessions (person_id)
  WHERE person_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. An invitation made FOR a named relative.
--
-- The family already invites people with a link. Naming who a link is for
-- costs the sender one tap and buys the thing a shared passcode can never
-- buy: the person who arrives is who somebody else said they would be.

ALTER TABLE invites
  ADD COLUMN IF NOT EXISTS for_person_id UUID REFERENCES people (id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 3. Existing sessions.
--
-- Deliberately left NULL rather than guessed at. Nobody currently signed in is
-- signed out by this migration; they are asked once, the next time they open
-- the app, and their answer is theirs rather than one this file invented for
-- them. A migration that filled these in would be a migration that decided who
-- forty people are.
