# The Muwuyu Project

A shared, editable Shona family tree with a built-in kinship-term engine —
the classificatory system where there is no "aunt", "uncle" or "cousin", just
Baba, Tete, Sekuru, Mukoma and so on — plus totems, birth order, and a baobab
that grows roots down into the soil and branches up into the canopy.

The whole frontend is one self-contained file with no build step
(`public/index.html`). The server is Node/Express over Postgres.

## Credits

`public/baobab.webp` — the baobab standing behind the family — is derived from
a photograph supplied by the project owner, reduced to a greyscale alpha mask.
Replacing it is one file drop; see **The backdrop** in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Storage

The tree lives in real Postgres tables — people, unions, partner links and
child links, with the "one set of parents" rule enforced by a primary key
rather than a hopeful check in JavaScript. See **[docs/ARCHITECTURE.md]
(docs/ARCHITECTURE.md)** for the schema, the operations API, the concurrency
model and the measured performance numbers.

Two relatives editing at the same time both keep their work: writes are small
named operations applied in one transaction, not a whole-tree overwrite.

```bash
npm start                             # applies schema migrations on boot
node scripts/migrate-data.js          # inspect the old blob, write nothing
node scripts/migrate-data.js --apply  # move it into the real tables
npm test                              # 165 tests; needs TEST_DATABASE_URL
```

## What "shared" means here

There is **no login** on the currently deployed site. Anyone who has the URL
can see and edit the whole tree. Personal settings — who you've picked as "you," which layout
orientation you prefer, which branches you've folded — stay in your own
browser (`localStorage`) and are never sent to the server. Everything
else (names, totems, relationships) is genuinely shared and public to
anyone with the link. Don't put sensitive personal information in it.

## Deploying on Railway

1. **Push this folder to a GitHub repository.** Railway deploys from
   GitHub.

2. **Create the Railway project.**
   In Railway: **New Project → Deploy from GitHub repo** → pick this
   repo. Railway will detect it's a Node app and run `npm install` and
   `npm start` automatically — no config file needed.

3. **Add a database (this is what makes the tree actually persist).**
   In the same Railway project, click **New → Database → Add
   PostgreSQL**. Railway spins one up in about 30 seconds.

4. **Connect the database to the app.**
   Open your app service → **Variables** tab → **New Variable**. Name it
   `DATABASE_URL` and, for the value, type `${{Postgres.DATABASE_URL}}`
   (Railway should offer this as an autocomplete suggestion — it's a
   *reference* to the Postgres service's own connection string, not a
   value you type out by hand). Save it; Railway will redeploy
   automatically.

   Without this step the app still runs, but it falls back to in-memory
   storage and the whole tree resets every time it restarts or redeploys
   — check the deploy logs and you'll see a warning if that's happening.

5. **Set the keeper's passphrase.**
   Still in **Variables**, add `MW_ADMIN_PASSPHRASE`. This is yours, not
   the family's: it opens the dashboard at `/admin`, where you issue
   families their passcodes, read the record of who did what, and answer
   appeals. It opens **no family's tree** — see *Access* below.

   Pick something long and type it nowhere else. It is never committed:
   this repository is public. Without it the dashboard is off and no
   family passcodes can be issued.

6. **Get a public URL.**
   Open your app service → **Settings → Networking → Public Networking**
   → **Generate Domain**. That's the link you share with family.

7. **Open it and try it.** Add a person, refresh the page — it should
   still be there. That confirms Postgres is wired up correctly.

8. **Issue the first family its passcode.** Go to `/admin`, sign in with
   `MW_ADMIN_PASSPHRASE`, find the family in the list and press *Issue a
   new passcode*. It is shown **once** — write it down before closing
   the box. Nobody can read it back afterwards, you included; a lost
   passcode is replaced, never recovered.

## Local development

```bash
npm install
npm start
```

Then open `http://localhost:3000`. Without a `DATABASE_URL` set, it'll
run on in-memory storage (fine for poking around, but restarting the
server clears the tree). To test against a real database locally, copy
`.env.example` to `.env`, fill in `DATABASE_URL`, and load it however you
normally load env files in your setup (e.g. `node -r dotenv/config
server.js`, after `npm install dotenv`).

## Project layout

```
server.js            Express server: the gate, then the API, then the page
auth.js              The gate: family passcodes, invitations, the admin door
db/access.js         passcodes, sessions, invitations
db/audit.js          the record of who did what, when and from where
db/admin.js          what the keeper can see; db/appeals.js what they answer
db/                  pool, migrations runner, ops, reads, duplicates, crosstree
migrations/          numbered SQL, applied on boot, recorded in schema_migrations
routes/tree.js       the HTTP surface for one tree
routes/family.js     a family's own invitations, appeals and sign-out
routes/admin.js      the keeper's surface
admin/dashboard.html The keeper's page. NOT in public/ — see the note in it
public/index.html    The entire frontend — tree UI, kinship-term engine, styling
test/                suites; test/browser/ needs Chromium and a live server
package.json
.env.example
```

## If you want to extend it later

- **Accounts**: identity is self-claimed — you tap your own name in the tree,
  and that name is stamped on what you record. Good enough to say who entered
  a relative and who to tell before setting one aside; not enough to *prove*
  anybody is who they say. Real accounts would sit on top of the passcodes and
  invitations below, which stay as the way a family lets somebody in either way.
- **More than one keeper**: `MW_ADMIN_PASSPHRASE` is one shared secret, so two
  people using it are told apart only by the session and address beside each
  line in the record. A keepers table would be the next step; the audit trail
  is already shaped for it.
- **Backups**: Railway's Postgres has automatic backups, but it's worth
  knowing where to find them before you need them.

## Access, and exactly what it is worth

Three doors, and it is worth being precise about all three.

**A family passcode** answers "which family is this, and do you belong to it".
It looks like `handle-xxxxxx-xxxxxx`. The first group is the family's handle,
stored in the clear so the server knows which family to check; the rest is the
secret, about 59 bits of it, and it is stored **only as a scrypt hash**.

That last part has a consequence stated here rather than discovered later:
**nobody can read a passcode back — the keeper included.** A lost passcode is
replaced, never recovered. The alternative would be a table of every family's
passcode in plaintext, which turns one breach into every family's records at
once.

Holding a family's passcode opens that family and nothing else. It does not
list the other families, and it cannot read or write one — every route that
names a tree is checked against the session's own.

**An invitation** is how a family brings a relative in without the passcode
travelling through a group chat. It is a link, single-use and expiring by
default, withdrawable on its own, and attributable to whoever made it. The
relative who is let in cannot pass on the family's own way in.

Note what an invitation is *not*: a family key (`…/#/f/<key>`) is no longer a
way in. It used to be — hold the link, hold the tree — and that is precisely
what the passcodes replace. A key is now a label a family uses for its own
tree, and a key belonging to somebody else's family opens nothing.

**The keeper's passphrase** (`MW_ADMIN_PASSPHRASE`) opens `/admin` and **no
family's tree**. The keeper can issue a family a new passcode, close a family
without deleting a single record of theirs, end a session, and answer appeals.
The keeper cannot read anybody's records — there is no endpoint that would
allow it, and a test asserts there is none, because "we don't" is only true
until somebody adds one.

The old deployment-wide `APP_PASSPHRASE` still opens the *home* family, so
nobody was signed out by this change. New families use passcodes.

### What is recorded

Every sign-in, every refusal, every invitation made or taken up, every
passcode issued, every family closed or reopened, every appeal, and every
batch of edits — each with the time, the address it came from, the browser,
and who the person said they were. The keeper reads it at `/admin → Activity`,
filtered by family, kind, address or date.

Two deliberate absences. It does **not** look up where an address is in the
world: that would mean sending a family's IP to somebody else's service on
every event. And it does **not** record what was typed — a wrong passcode is
recorded as a wrong passcode, and what an edit changed is in the family's own
change log, which the record points at rather than copies.

The record is partitioned by month, so a deployment running for years still
answers "what happened this week" by reading this week, and dropping old
history is `mw_drop_audit_before(...)` — dropping whole tables rather than
deleting rows. Nothing calls it: how long to keep a record of who signed in is
a decision for whoever runs the deployment.

### Appeals

There are two ways to reach the keeper, and both exist for the same reason:
the commonest thing that goes wrong is a family that cannot get in.

From inside the app, a family raises one from the family panel, and it carries
which family it is from. From **outside** the gate, at `/appeal`, anybody can —
which is the one writable thing a stranger can reach on this deployment, so it
is rate-limited far harder than the door is, and it writes to a table nothing
else reads.

The appeal kinds are *lost passcode*, *cannot get in*, *somebody has been taken
out of our tree*, and *something else*. The third is this project's older
promise finally given somewhere to go: nothing in a tree is deleted, it is set
aside with a reason and the person who recorded it is told — and being told is
not the same as being heard.
