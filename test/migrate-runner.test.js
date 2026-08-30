// The migration runner itself: what happens when it cannot proceed.
//
// Applying migrations is the first thing the server does on boot, before it
// listens. So the runner's failure mode IS the deploy's failure mode, and the
// worst one available to it is not an error — it is a wait with no end, which
// produces no output, no listening port and no explanation, while the schema
// sits half-applied behind it.

const { check, eq, section, freshPool, report } = require('./helpers');
const { migrate } = require('../db/migrate');

(async () => {
  const pool = await freshPool();

  section('a blocked migration fails loudly instead of hanging the deploy');

  // Hold ACCESS EXCLUSIVE on a table a migration alters — which is what an old
  // container still serving during a rolling deploy can do to the new one.
  const blocker = await pool.connect();
  await blocker.query('BEGIN');
  await blocker.query('LOCK TABLE people IN ACCESS EXCLUSIVE MODE');

  // Re-running an applied migration is a no-op, so force a real one.
  await pool.query(`DELETE FROM schema_migrations WHERE version = '005_set_aside'`);

  const started = Date.now();
  let failed = null;
  try { await migrate(pool, () => {}); } catch (e) { failed = e; }
  const took = Date.now() - started;

  // Checked while the lock is still held: the failed attempt must not have
  // recorded itself, or the retry would skip past a change that never landed.
  const recordedAfterFailure = (await pool.query(
    `SELECT 1 FROM schema_migrations WHERE version = '005_set_aside'`)).rowCount;

  await blocker.query('ROLLBACK');
  blocker.release();

  check('it raises an error rather than waiting', !!failed, 'nothing was raised');
  eq('and records nothing, so nothing is half-applied', recordedAfterFailure, 0);
  check('naming the migration that could not proceed',
        failed && /005_set_aside/.test(failed.message), failed && failed.message);
  check(`and gives up in seconds, not never (took ${(took / 1000).toFixed(1)}s)`,
        took < 40000, `${took}ms`);

  section('and the next boot picks it up, which is the whole recovery plan');
  await migrate(pool, () => {});
  eq('the migration is applied',
     (await pool.query(
       `SELECT 1 FROM schema_migrations WHERE version = '005_set_aside'`)).rowCount, 1);
  eq('and the schema is whole',
     (await pool.query(
       `SELECT 1 FROM information_schema.columns
         WHERE table_name = 'people' AND column_name = 'aside_at'`)).rowCount, 1);

  report();
})();
