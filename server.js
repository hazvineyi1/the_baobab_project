// The Baobab Project — server
//
// Serves the static frontend and a tiny key/value API that backs the
// "shared" family-tree data. Personal preferences (who you are, layout
// orientation, folded branches) never touch this server at all — the
// frontend keeps those in the visitor's own browser (localStorage).
//
// Storage: uses Postgres when DATABASE_URL is set (this is how the real,
// persistent deployment on Railway works). If DATABASE_URL is missing,
// it falls back to an in-memory store so `npm start` still works for a
// quick local look — but a restart will lose everything in that mode.

const express = require('express');
const path = require('path');
const { createPool } = require('./db/pool');
const { migrate } = require('./db/migrate');
const treeRoutes = require('./routes/tree');
const { trigramAvailable } = require('./db/reads');
const { ensureHomeTree } = require('./db/home');
const { gate } = require('./auth');

const app = express();
app.use(express.json({ limit: '2mb' }));
// The gate's own form posts as a form, not as JSON.
app.use(express.urlencoded({ extended: false, limit: '4kb' }));

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;

// Railway terminates TLS in front of this process, so req.secure is only true
// if Express is told to believe the proxy's header. Without this the session
// cookie never gets its Secure flag in production.
app.set('trust proxy', 1);

// Whether the public record is actually reachable by the public.
//
// OFF by default, and deliberately a separate switch from everything else:
// turning it on is the moment this deployment starts publishing to the world,
// and that should be an act somebody performs on purpose rather than a side
// effect of deploying. Until then the visibility rules are enforced and
// testable, but nothing is served outside the gate.
const PUBLIC_READ = (process.env.MW_PUBLIC_READ || 'off').toLowerCase() === 'on';

/* The public record, mounted BEFORE the gate — the only thing that is.
 
   It has to be first, because a public record behind a passphrase is not a
   public record. The router is created empty here and filled in once there is
   a database; while it is empty every request falls straight through to the
   gate below, which is exactly what should happen when publishing is off.
 
   What makes this safe is not the mounting order but what is mounted: the
   handlers call publicTree/publicPerson, which have no parameter that could
   return a private person. Ordering decides whether the world can reach them;
   the functions decide what the world gets. */
const publicRouter = express.Router();
app.use('/public', publicRouter);

/* Everything else is behind the passphrase, including the static page and the
   whole family API. Mounted here, before any of it, so a route added later
   cannot accidentally sit outside it — the ordering is the guarantee, and a
   gate you have to remember to apply is one that eventually is not.
 
   The passphrase itself comes from the environment and appears nowhere else:
   not in this repository, not in a log line, not in an error message. */
app.use(gate({
  passphrase: process.env.APP_PASSPHRASE,
  hasDatabase: !!DATABASE_URL
}));

// The old whole-tree blob API (/api/shared/:key). OFF by default now that the
// page speaks /api/tree/:id/ops.
//
// Leaving it on is a genuine hazard rather than a harmless fallback: anything
// still writing through it puts the whole tree into kv_store while the real
// data lives in the tables, and the two diverge silently with nobody being
// told which one is right. A page from before the switch that finds it gone
// gets a 410, which that page reads as "stalled" and refuses to write — so
// the worst case is a stale tab that saves nothing, not one that saves into
// the wrong place.
//
// MW_BLOB_API=on brings it back, for reading the old copy after the move.
const BLOB_API = (process.env.MW_BLOB_API || 'off').toLowerCase() !== 'off';

let db; // { get(key), set(key,value), del(key), list(prefix) }

async function setupDatabase() {
  if (DATABASE_URL) {
    const pool = createPool(DATABASE_URL);

    // Bring the real relational schema up to date on every boot. The blob
    // key/value API below still runs on kv_store and is untouched by this —
    // the two coexist until the tree has actually been migrated across.
    await migrate(pool);

    // Settle which tree this deployment serves before the API is mounted,
    // carrying the old blob across on the first boot that finds one. This
    // throws rather than returning if the carry-over fails, so a broken move
    // stops the deploy instead of serving the family an empty page.
    const home = await ensureHomeTree(pool);

    // The relational API. Only available with a real database — the in-memory
    // fallback below exists so `npm start` works for a quick look, and it
    // cannot support transactions, constraints or incremental sync.
    app.use('/api', treeRoutes(pool, home.treeId));

    if (PUBLIC_READ) {
      publicRouter.use(treeRoutes.publicRoutes(pool));
      console.log('Public record is ON — ancestors are readable without the passphrase.');
    } else {
      console.log('Public record is off (set MW_PUBLIC_READ=on to publish ancestors).');
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMPTZ DEFAULT now()
      );
    `);

    console.log('Connected to Postgres — shared family-tree data will persist.');
    await reportSearchMode(pool);
    await warnIfBlobApiIsNowDangerous(pool);

    db = {
      async get(key) {
        const r = await pool.query('SELECT value FROM kv_store WHERE key = $1', [key]);
        return r.rows.length ? r.rows[0].value : null;
      },
      async set(key, value) {
        await pool.query(
          `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
          [key, value]
        );
      },
      async del(key) {
        await pool.query('DELETE FROM kv_store WHERE key = $1', [key]);
      },
      async list(prefix) {
        const r = prefix
          ? await pool.query('SELECT key FROM kv_store WHERE key LIKE $1', [prefix + '%'])
          : await pool.query('SELECT key FROM kv_store');
        return r.rows.map(row => row.key);
      }
    };
  } else {
    console.warn(
      'No DATABASE_URL found — running on in-memory storage.\n' +
      'The tree will work, but everything resets on the next restart or deploy.\n' +
      'Add a PostgreSQL database in Railway and reference its DATABASE_URL on this ' +
      'service to make the tree actually persist.'
    );
    const mem = new Map();
    db = {
      async get(key) { return mem.has(key) ? mem.get(key) : null; },
      async set(key, value) { mem.set(key, value); },
      async del(key) { mem.delete(key); },
      async list(prefix) {
        return [...mem.keys()].filter(k => !prefix || k.startsWith(prefix));
      }
    };
  }
}

// 002_search degrades to prefix-only matching if the host forbids CREATE
// EXTENSION. That is the right behaviour — a search feature is not worth
// refusing to boot over — but it must not be SILENT: without this line, a
// deployment where "Garikayi" stops finding Garikai looks like a bug in the
// data rather than a missing extension.
async function reportSearchMode(pool) {
  try {
    const fuzzy = await trigramAvailable(pool);
    console.log(fuzzy
      ? 'Search: prefix + fuzzy (pg_trgm active).'
      : 'Search: prefix only — pg_trgm is not available on this host, so ' +
        'misspelled names will not match.');
  } catch { /* never block boot on a diagnostic */ }
}

// Once a tree has been migrated, the blob and the tables are two copies of the
// same family, and only one of them is being kept up to date. Say so loudly at
// boot rather than letting them drift apart quietly.
async function warnIfBlobApiIsNowDangerous(pool) {
  let migrated = false;
  try {
    const { rowCount } = await pool.query(
      `SELECT 1 FROM changes WHERE op = 'migrateFromBlob' LIMIT 1`);
    migrated = rowCount > 0;
  } catch { return; }          // pre-migration schema; nothing to warn about
  if (!migrated) return;

  if (BLOB_API) {
    console.warn(
      '\n  ---------------------------------------------------------------\n' +
      '  WARNING: this tree has been migrated into the relational tables,\n' +
      '  but the old whole-tree blob API (/api/shared/:key) is still on.\n' +
      '\n' +
      '  Anything still writing through it — the old UI — will write to\n' +
      '  kv_store, NOT to the tables, and the two copies will diverge with\n' +
      '  nobody being told which one is right.\n' +
      '\n' +
      '  Set MW_BLOB_API=off once the frontend speaks /api/tree/:id/ops.\n' +
      '  ---------------------------------------------------------------\n');
  } else {
    console.log('Blob API is off (MW_BLOB_API=off) — the tables are the only copy.');
  }
}

// ---- API ----

// Refuses rather than 404s when switched off, so a client still calling it
// gets an explanation instead of looking like a routing mistake.
app.use('/api/shared', (req, res, next) => {
  if (BLOB_API) return next();
  res.status(410).json({
    error: 'blob_api_retired',
    message: 'The whole-tree blob API has been retired on this deployment. ' +
             'Use /api/tree/:id/ops, /bootstrap, /changes and /search.'
  });
});

app.get('/api/shared/:key', async (req, res) => {
  try {
    const value = await db.get(req.params.key);
    res.json({ value });
  } catch (e) {
    console.error('read failed', e);
    res.status(500).json({ error: 'read failed' });
  }
});

app.put('/api/shared/:key', async (req, res) => {
  try {
    const { value } = req.body || {};
    if (typeof value !== 'string') {
      return res.status(400).json({ error: 'value must be a string' });
    }
    await db.set(req.params.key, value);
    res.json({ ok: true });
  } catch (e) {
    console.error('write failed', e);
    res.status(500).json({ error: 'write failed' });
  }
});

app.delete('/api/shared/:key', async (req, res) => {
  try {
    await db.del(req.params.key);
    res.json({ ok: true });
  } catch (e) {
    console.error('delete failed', e);
    res.status(500).json({ error: 'delete failed' });
  }
});

app.get('/api/shared', async (req, res) => {
  try {
    const keys = await db.list(req.query.prefix);
    res.json({ keys });
  } catch (e) {
    console.error('list failed', e);
    res.status(500).json({ error: 'list failed' });
  }
});

app.get('/health', (req, res) => res.send('ok'));

// ---- static frontend ----
app.use(express.static(path.join(__dirname, 'public')));

setupDatabase()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`The Baobab Project listening on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to start up', err);
    process.exit(1);
  });
