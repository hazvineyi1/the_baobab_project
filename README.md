# Muti weMhuri — a collaborative Shona family tree

A shared, editable family tree with a built-in Shona kinship-term engine
(the classificatory system where there's no "aunt," "uncle," or "cousin" —
just Baba, Tete, Sekuru, Mukoma, and so on), totems, and a layout that
grows top-down or left-to-right with foldable branches for big trees.

This is a small Node/Express app with one tiny API for the data everyone
shares, and a static frontend that does all the actual tree logic in the
browser.

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
server.js          Express server + the /api/shared/:key data endpoint
public/index.html  The entire frontend — tree UI, kinship-term engine, styling
package.json
.env.example
```

## If you want to extend it later

- **Real-time sync**: right now, everyone has to click "↻ Refresh" to see
  others' changes. Adding a poll-every-few-seconds or a WebSocket push
  would make it live.
- **A password or invite link**: there's no access control at all today.
  A simple shared passphrase gate would be a small addition if the tree
  ever contains anything you don't want fully public.
- **Backups**: Railway's Postgres has automatic backups, but it's worth
  knowing where to find them before you need them.
