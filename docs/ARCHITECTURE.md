# The Baobab Project — storage architecture

## What changed, and why

The tree used to live as one JSON string in one row of `kv_store`. Four things
were wrong with that, in order of how much damage they did:

1. **Last write wins.** Two relatives editing at once, and the second save
   silently erased everything the first had added. For an app whose whole
   purpose is a family filling a tree in together, this was the worst of them.
2. **Duplicate detection was O(n²) and ran inside `render()`.** At 3,000
   people that is ~4.5 million comparisons per frame.
3. **The client loaded the whole tree to show one corner of it**, and rebuilt
   layout and DOM for every person on every render.
4. **`snapshot()` stringified the entire state on every change** for undo, and
   there was no search at all.

The database now addresses 1, 2 and the loading half of 3, and adds search.
Rendering is still the client's business.

## The data model

Everything is people and unions. Nothing else is stored.

```
person = { id, name, sex, totem, born, died, is_root }
union  = { id, partners: [person], children: [person] }   -- children eldest-first
```

Siblings, grandparents, in-laws and every kinship term are **derived** from
those two shapes. The invariants:

| rule | how it is guaranteed |
|---|---|
| a person has at most one set of parents | `union_children.person_id` is the PRIMARY KEY — a second parent union is unrepresentable, not merely rejected |
| a person may be a partner in several unions (remarriage) | nothing prevents it; each union carries its own children |
| a union may have two partners, one, or none | no constraint requires two |
| `union.children` order is birth order, hand-settable | stored explicitly as `birth_order`, deferrable-unique per union |
| a dismissed duplicate pair stays dismissed | `not_duplicates` has `CHECK (a_id < b_id)`, so one row covers the pair in either direction |

### What is deliberately NOT in the database

**Kinship terms.** Adding one person changes what hundreds of others are called
relative to each other, so a stored term is a stale term. Derived on read,
always.

**Generation numbers.** Same reason. The duplicate scan computes them fresh in
one pass and throws them away.

**`meId`, zoom, pan, folded branches, and day/night.** The tree is shared; the
viewpoint is personal. These stay in `localStorage` and never reach the server.
Which theme somebody wants is not a property of the family tree — it is a
property of the person looking and the room they are sitting in, so the same
tree can be read at noon on a phone and at midnight on a laptop, and each is
right. The control has three states: Auto follows the device (the default and
what the page did before), Day and Night override it.

## API

### Writes

`POST /api/tree/:id/ops` — an array of operations, one transaction, all or
nothing. Returns the new `seq` and a map of local refs to minted ids.

```
addPerson  updatePerson  addUnion  addPartner  removePartner
addChild   removeChild   reorderChildren  setRoot  mergePeople  dismissDuplicate
```

New rows are named with **local refs** so a batch can create and link in one
go:

```json
[ {"op":"addPerson","ref":"$gran","name":"Mbuya Rudo","sex":"f"},
  {"op":"addPartner","unionId":"$u","personId":"$gran"} ]
```

Clients do **not** mint ids. Two relatives editing at once would both mint
`p47`; client-side sequential ids collide under exactly the concurrency this
design exists to fix.

### Concurrency

An op may carry `expect`: the `updated_at` it was composed against. A stale
write returns **409 with the current row**, so the client merges rather than
clobbers. Omitting `expect` is a deliberate last-write-wins for callers that
genuinely do not care.

Each batch takes a per-tree advisory lock. That does three jobs:

- makes the cycle guard sound (two concurrent `addChild` calls could otherwise
  each verify "no cycle" independently and together create one);
- makes `changes.seq` gapless per tree — a bare `BIGSERIAL` does not, since
  values can be assigned in one order and committed in another, and a client
  polling `?since=N` would permanently miss a late-committing row;
- removes read-modify-write races inside a batch.

### Reads

| endpoint | purpose |
|---|---|
| `GET /tree/:id/bootstrap?focus=&depth=3` | the neighbourhood around one person, not the whole tree |
| `GET /tree/:id/changes?since=` | incremental sync |
| `GET /tree/:id/search?q=` | prefix + fuzzy on `name_key`, with family context |
| `GET /tree/:id/duplicates` | bucketed scan, server-side, never in a render |

Depth is counted in **union hops**: one reaches parents, partners, siblings and
children; two reaches grandparents and the father's sisters; three reaches the
generation the Shona terms still name directly.

## The Shona rules the data serves

**Names.** `name_key` reproduces the frontend's `nameTokens()` exactly: lowercase,
drop apostrophes and full stops, split on whitespace and hyphens, then remove
every token that is an honorific title — wherever it sits, not just at the front.
So "Sekuru Garikai", "Garikai Baba" and "Garikai" all reduce to `garikai`, while
the bound form "VaMoyo" stays `vamoyo` because it is one token. The displayed
name is never altered. `test/parity.test.js` checks the SQL and the JavaScript
agree name for name.

**Duplicates judge position, not name.** Shona children are named after their
grandparents, so three living Garikais in one family is ordinary. The name is
capped at 0.34 and can only ever open the question; every strong signal is
positional (shared spouse, shared child, same parent union), and being a
generation apart pushes hard the other way — that is the grandfather-and-
grandson case, and it is the common one.

`db/duplicates.js` is a **port of `sameness()` in `public/index.html`**, not a
reimplementation, and `test/parity.test.js` keeps it honest: it runs the whole
real frontend script in a stubbed DOM and compares both implementations
pair-by-pair over several trees, failing on any disagreement about which pairs
are candidates, what they score, or which count as strong. If a weight changes
on one side and not the other, that test goes red.

Two behaviours worth knowing, both inherited from the frontend:

- `mustBeDifferent()` refuses to compare two records the tree already says are
  related — partners in one union, or one an ancestor of the other. So a
  duplicate created as a *co-partner in the same union* is not a candidate;
  real ones arrive as separate unions, which is how two relatives recording
  the same marriage from different sides actually produce them.
- A record whose name is nothing but a title ("Baba") reduces to no tokens, so
  it never matches anything. It stays findable through search, which falls
  back to the raw name when `name_key` is empty.

**Seniority.** `birth_order` is stored because it is real, hand-settable
information, and it is what the seniority terms resolve against when birth
years are missing. Where the app cannot tell, it should keep saying "Mukoma or
Munin'ina" rather than guessing.

## Performance

Measured on Postgres 16, 5,000 people across 10 generations, medians over 20
runs warm. Reproduce with `npm test` (the `scale.test.js` suite asserts these).

| call | measured | target |
|---|---|---|
| `bootstrap` depth=3 | **4.6 ms** | 200 ms |
| `bootstrap` depth=3 from the root | 3.9 ms | 200 ms |
| `bootstrap` depth=4 | 5.4 ms | 200 ms |
| `search` prefix | **7.5 ms** | 100 ms |
| `search` fuzzy misspelling | 8.8 ms | 100 ms |
| duplicate scan (whole tree) | **1.48 s** | "seconds, not minutes" |
| single-op write batch | 2.3 ms | — |
| `changes?since=0` | 0.6 ms | — |

A depth=3 bootstrap sends 45 people out of 5,000. The duplicate scan makes
424,622 comparisons where a naive pass would make 12,497,500 — 29× fewer.
Name tokenisation and similarity are memoised and the edit-distance table is
skipped for pairs that cannot match on length; both are provably answer-
preserving, and together they took the scan from 3.19 s to 1.48 s.

## Migrating off the blob

```bash
node scripts/migrate-data.js              # inspect, write nothing
node scripts/migrate-data.js --apply
```

Handles both source shapes (detected, not assumed): the `people`/`unions`
shape, and the older `fatherId`/`motherId`/`spouseId` shape the deployed app
actually wrote. Backs the blob up to a timestamped `kv_store_backup` row before
touching anything, runs in one transaction, is re-runnable, and verifies counts
**and birth order** on both sides — a migration that loaded everybody but
scrambled who is the eldest would pass a count check and fail this one.

One caveat: the older shape's single `spouseId` cannot represent remarriage, so
a legacy tree converts forward cleanly but does not round-trip back.

### After migrating: retiring the blob API

Once a tree is in the tables, the old `/api/shared/:key` blob API becomes a
hazard rather than merely redundant. The old UI would keep writing the whole
tree into `kv_store` while the real data lives in the tables, and the two would
diverge silently with nobody being told which is right.

The server detects this and warns loudly at boot. It does **not** switch itself
off, because that is a deployment decision:

```bash
MW_BLOB_API=off      # blob endpoints return 410 with an explanation
```

Turn it off at the point the frontend speaks `/api/tree/:id/ops`. Until then,
leave it on — the deployed frontend still needs it.

## Tests

```bash
TEST_DATABASE_URL=postgres://... npm test           # 206 tests, seven suites
node test/external.js                               # the out-of-repo harnesses
```

Each suite runs in its own freshly created database.

`test/external.js` runs `kin.js`, `dupes.js`, `buds.js`, `drive2.js` and
`test_gate.sh` — which are **not in this repository**, because they test the
baobab frontend and the passphrase gate, neither of which is committed. It
looks in `$MW_HARNESS_DIR`, then `./harness/`, then `/tmp`, boots a server,
passes the base URL and a Chromium path, and reports absent suites as
**SKIPPED rather than passed**. A suite that reported nothing when its file was
missing would turn an untested build green, which is worse than no suite.

## The backdrop

`public/baobab.webp` is the tree standing behind the family. If it is absent a
generated one is drawn instead, so the app never depends on it.

It is not a picture pasted onto the page. It is a **mask**: a greyscale image
whose brightness becomes the alpha, with the colour coming from the palette.
That matters for three reasons.

- **One file, both themes.** A brown photograph looks wrong against the night
  sky. A mask filled with `--bark` is correct in either.
- **A quarter of the weight.** Alpha-only at 1100px is 155 KB where the same
  tree in colour at 860px was 274 KB — smaller *and* sharper, because at 13%
  opacity the colour contributes almost nothing and the branch shape carries
  everything. The original upload was 4.2 MB; this is 28× smaller, which is
  the difference between a page that opens on rural mobile data and one that
  does not.
- **No rectangle.** Drawn directly, a photograph brings its own sky and ground
  and lands as a block of someone else's weather over the page.

The loader inspects the image rather than trusting its filename: a prepared
mask (light subject, dark ground) is used as it is, and a photograph (dark
subject, bright sky) is inverted into one first. A photograph cut out on a
plain background also has its horizon measured from the foot of the subject,
so it plants itself on the ground line without anyone typing in a fraction.

Below the horizon the same image is mirrored — a baobab is called the
upside-down tree because its crown looks like a root system — in three layers,
each reaching further down and drawing in narrower, revealed one after another
as the view descends through the ancestors. One reflection would only be as
deep as the crown is tall, and travelling further back would be rewarded with
empty ground.

### Proportion

The image is stretched horizontally by `BG_PHOTO.fatten`. A baobab is squat —
the thing everyone recognises is a trunk far too fat for the tree standing on
it — and a photograph taken from a distance flattens exactly that. Widening
thickens the trunk and broadens the crown together, which is the proportion
the tree has in life rather than the one a lens gives it. The width target
accounts for the stretch, so the two settings do not fight.

### Sizing

The backdrop is sized by **width**, not height. Sizing by height keeps it
small: only the sky above the horizon is available, and that is a little over
half the screen. A baobab's presence is in its spread, so the crown is allowed
to run past the top of the frame the way it does in every photograph of one.
`BG_PHOTO.width` is the fraction of the viewport it spans; `BG_PHOTO.crown`
caps how much may be lost off the top, so a short wide window does not end up
showing nothing but trunk.

### Replacing it

Drop any baobab image into `public/` as `baobab.webp`, `.jpg` or `.png`. A
tree cut out on a plain background works best; a dry-season one with bare
branches reads far better than a canopy in full leaf, which at this opacity
becomes an undifferentiated smudge. Only use an image you hold the rights to —
this repository is public.
