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

5. **Get a public URL.**
   Open your app service → **Settings → Networking → Public Networking**
   → **Generate Domain**. That's the link you share with family.

6. **Open it and try it.** Add a person, refresh the page — it should
   still be there. That confirms Postgres is wired up correctly.

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
server.js          Express server: the gate, then the API, then the page
auth.js            The passphrase gate
db/                pool, migrations runner, ops, reads, duplicates, crosstree
migrations/        numbered SQL, applied on boot, recorded in schema_migrations
routes/tree.js     the HTTP surface for one tree
public/index.html  The entire frontend — tree UI, kinship-term engine, styling
test/              suites; test/browser/ needs Chromium and a live server
package.json
.env.example
```

## If you want to extend it later

- **Accounts**: identity is self-claimed — you tap your own name in the tree,
  and that name is stamped on what you record. Good enough to say who entered
  a relative and who to tell before setting one aside; not enough to *prove*
  anybody is who they say. Real accounts would sit on top of the family keys
  below, which stay as the invitation either way.
- **Backups**: Railway's Postgres has automatic backups, but it's worth
  knowing where to find them before you need them.

## Access, and exactly what it is worth

Two layers, and it is worth being precise about both, because neither is an
account system.

**The passphrase gate** (`APP_PASSPHRASE`) answers "may this person use this
deployment at all". Everyone types it once; the browser then holds a signed,
expiring cookie. It stops crawlers, scrapers and anybody who is merely sent
the address. It does not stop somebody who was given the passphrase and should
not have been — a shared secret is only as private as the people sharing it.

Set it in the deployment's environment variables and nowhere else. It is never
committed: this repository is public. **Without it, a deployment that has a
database refuses to serve the tree** rather than serving it openly — running
locally with no database, the gate stays out of the way.

**A family key** answers "which family's tree is this". Each tree has one, and
it lives in the address: `…/#/f/<key>`. Hold the key and you can read and add
to that family's tree; without it you cannot even find it, because nothing
lists keys and they are too long to guess. That is capability access:

- anyone the link is passed to has exactly the access of whoever passed it,
  and there is no way to tell them apart afterwards;
- it cannot be taken back from one person without changing it for everybody
  (which the app offers, saying plainly what it costs).

What it buys is that one family's records stop being visible to every other
family on the deployment — and that a relative can start recording their
grandmother without an email address, a password, or a sign-up first.
