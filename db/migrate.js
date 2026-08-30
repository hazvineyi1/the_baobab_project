// Migration runner.
//
// Reads migrations/*.sql in filename order, applies whatever has not been
// applied yet, records each in schema_migrations. Runs on boot.
//
// No ORM and no migration framework — plain pg and plain SQL, so the schema
// can be read on its own without decoding anyone's DSL.
//
// Two properties this has to have, because it runs unattended on every deploy:
//
//   * Idempotent. Applying twice is a no-op. The SQL files are themselves
//     written with IF NOT EXISTS / CREATE OR REPLACE so that even a file
//     re-run by hand does no damage.
//
//   * Safe against concurrent boots. Railway can start a new instance while
//     the old one is still up, and two processes racing to CREATE the same
//     table is a crash loop. A session-level advisory lock serialises them:
//     the second waits, then finds nothing left to do.

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

// Arbitrary constant, unique to this app. Any two processes running these
// migrations against the same database will contend on it.
const MIGRATION_LOCK_KEY = 0x6d757469; // "muti"

async function migrate(pool, log = console.log) {
  const client = await pool.connect();
  try {
    // Fail loudly rather than hang. A migration that alters a table needs an
    // ACCESS EXCLUSIVE lock, and Railway starts the new container while the
    // old one is still serving — so the ALTER can queue behind a connection
    // that is still reading. With no timeout that wait is unbounded: the boot
    // produces no output, no error and no listening port, and the deploy looks
    // indistinguishable from a crash while the schema sits half-applied.
    //
    // These are set on this session only, before the advisory lock, so they
    // cover the wait for the lock as well as the statements after it. A
    // migration that cannot get its lock inside 15s throws, the transaction
    // rolls back whole, and the next boot retries it — which is the same
    // recovery the runner already relies on.
    await client.query(`SET lock_timeout = '15s'`);
    await client.query(`SET statement_timeout = '120s'`);

    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      );
    `);

    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const done = new Set(rows.map(r => r.version));

    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort();

    let applied = 0;
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (done.has(version)) continue;

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

      // Each migration is its own transaction: a failure rolls that file back
      // whole and leaves schema_migrations untouched, so the next boot retries
      // it rather than skipping past a half-applied change.
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version) VALUES ($1)', [version]
        );
        await client.query('COMMIT');
        log(`  applied ${version}`);
        applied++;
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${version} failed: ${e.message}`);
      }
    }

    log(applied ? `Migrations: ${applied} applied.` : 'Migrations: up to date.');
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
      .catch(() => {});
    client.release();
  }
}

module.exports = { migrate };
