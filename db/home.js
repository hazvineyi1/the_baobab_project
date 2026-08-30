// Which tree this deployment serves.
//
// The page has to name a tree before it can read or write one, and asking the
// family to configure a UUID would be absurd. So the server settles it once at
// boot and the page just asks.
//
// This is also where the move off the old whole-blob store actually happens.
// The blob and the relational tables coexisted for a while, with the tables
// empty and every real edit still going into kv_store. That could not be
// finished by hand — the data is on Railway and the family is using it — so
// the server does it on the first boot that finds a blob and no tree, using
// the same migration script that has always been there: it backs the blob up
// before touching anything, runs in one transaction, verifies every count and
// every birth-order sequence, and fails loudly rather than half-applying.
//
// Deliberately NOT re-run once a tree exists. Re-running would reset every
// migrated person back to their blob values, and the blob stops being the
// truth the moment the first edit goes through the ops API.

const { run } = require('../scripts/migrate-data');

async function ensureHomeTree(pool, log = console.log) {
  // A tree already chosen: use the oldest, so this is stable across restarts
  // and cannot start silently serving a different family.
  const { rows: existing } = await pool.query(
    'SELECT id, name FROM trees ORDER BY created_at LIMIT 1');
  if (existing.length) return { treeId: existing[0].id, migrated: false };

  // No tree yet. If the old blob is there, this is the deployment's one
  // chance to carry it across rather than starting the family from nothing.
  let summary;
  try {
    summary = await run(pool, { apply: true });
  } catch (e) {
    // A failed migration must not be papered over by quietly creating an empty
    // tree — that would present the family with a blank page and leave their
    // records sitting in kv_store looking lost.
    throw new Error(
      `The tree could not be moved out of the old blob store, so the server is ` +
      `not starting rather than serving an empty tree.\n  ${e.message}`);
  }

  if (summary.found && summary.applied) {
    const c = summary.verification ? summary.verification.actual : summary.counts;
    log(`Moved the family out of the old blob store: ${c.people} people, ` +
        `${c.unions} unions, ${c.dismissals} dismissals, ${c.terms} taught terms.`);
    log(`  the blob was backed up first, as ${summary.backupKey}`);
    return { treeId: summary.treeId, migrated: true, counts: c };
  }

  // Nothing to carry across: a fresh deployment. Start one empty tree.
  const { rows } = await pool.query(
    'INSERT INTO trees (name) VALUES ($1) RETURNING id', ['The Baobab Project']);
  log('No existing family found — started an empty tree.');
  return { treeId: rows[0].id, migrated: false, fresh: true };
}

module.exports = { ensureHomeTree };
