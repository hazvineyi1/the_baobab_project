// Which tree the deployment serves, and the one-time move off the blob store.
//
// This is the step that was never taken: the relational schema was deployed
// and the ops API was tested, but every real edit still went into the old
// single-JSON blob, and the tables sat empty. Nobody could take that step by
// hand — the data is on the deployed database and the family is using it — so
// the server takes it, once, on the first boot that finds a blob and no tree.
//
// The risk being tested is not "does it copy rows". It is: does it refuse to
// do anything dangerous. Starting an empty tree beside a full blob, or
// re-running over live edits, would both lose a family's work.

const { check, eq, rejects, section, freshPool, report } = require('./helpers');
const { ensureHomeTree } = require('../db/home');
const { fullTree } = require('../db/reads');
const { applyOps } = require('../db/ops');

const BLOB = JSON.stringify({
  people: {
    p1:{ id:'p1', name:'Rufaro Moyo', sex:'m', born:'1940', by:'Rudo', root:true },
    p2:{ id:'p2', name:'Chipo Moyo',  sex:'f', born:'1945', by:'Rudo' },
    p3:{ id:'p3', name:'Garikai',     sex:'m', born:'1968', by:'Rudo' },
    p4:{ id:'p4', name:'Tendai',      sex:'m', born:'1971', by:'Rudo' }
  },
  unions: { u1:{ id:'u1', partners:['p1','p2'], children:['p3','p4'] } },
  rootId:'p1', seq:9, notDuplicates:[['p3','p4']],
  lexicon:{ 'inlaw:through-my-husband:their-sibling:man': { term:'Tsano', by:'Rudo' } }
});

(async () => {
  const pool = await freshPool();
  const quiet = () => {};

  /* Back to a database that has never been booted against.
     Order matters: union_children.union_id is RESTRICT precisely so a union
     with children recorded under it cannot vanish beneath them, which means
     the links have to go before the trees they hang from. */
  const wipe = async () => {
    await pool.query('DELETE FROM union_children');
    await pool.query('DELETE FROM union_partners');
    await pool.query('DELETE FROM not_duplicates');
    await pool.query('DELETE FROM kin_terms');
    await pool.query('DELETE FROM changes');
    await pool.query('DELETE FROM unions');
    await pool.query('DELETE FROM people');
    await pool.query('DELETE FROM trees');
    await pool.query(`CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ DEFAULT now())`);
    await pool.query('DELETE FROM kv_store');
  };
  await wipe();

  section('a fresh deployment starts one empty tree');
  const fresh = await ensureHomeTree(pool, quiet);
  check('a tree id comes back', !!fresh.treeId);
  eq('nothing was migrated', fresh.migrated, false);
  eq('and it is empty', (await fullTree(pool, fresh.treeId)).people.length, 0);

  section('and asking again gives the same tree, not another one');
  const again = await ensureHomeTree(pool, quiet);
  eq('same id', again.treeId, fresh.treeId);
  eq('and only one tree exists',
     (await pool.query('SELECT count(*)::int n FROM trees')).rows[0].n, 1);

  // ---- a deployment that already has a family in the old blob ----
  await wipe();
  const pool2 = pool;
  await pool2.query('INSERT INTO kv_store (key, value) VALUES ($1,$2)',
                    ['muti-baobab-v1', BLOB]);

  section('a deployment with a family in the blob carries it across');
  const moved = await ensureHomeTree(pool2, quiet);
  eq('it says so', moved.migrated, true);
  const tree = await fullTree(pool2, moved.treeId);
  eq('every person arrived',      tree.people.length, 4);
  eq('the marriage arrived',      tree.unions.length, 1);
  eq('with both partners',        tree.unions[0].partners.length, 2);
  eq('and both children',         tree.unions[0].children.length, 2);
  eq('the dismissal arrived',     tree.notDuplicates.length, 1);
  eq('the taught word arrived',   Object.keys(tree.lexicon).length, 1);
  eq('the root came with it',
     tree.people.find(p => p.id === tree.rootId).name, 'Rufaro Moyo');
  eq('and so did who recorded them',
     tree.people.every(p => p.added_by === 'Rudo'), true);

  section('children keep the order the family put them in');
  const kids = tree.unions[0].children.map(id => tree.people.find(p => p.id === id).name);
  eq('eldest first', kids, ['Garikai', 'Tendai']);

  section('the blob was backed up before anything was touched');
  const backup = await pool2.query(
    `SELECT value FROM kv_store WHERE key LIKE 'kv_store_backup%' OR key LIKE '%backup%'`);
  check('a backup copy exists', backup.rowCount > 0);
  // Stored in an envelope that records when it was taken and which key it came
  // from, so a restore does not depend on remembering either.
  const envelope = JSON.parse(backup.rows[0].value);
  eq('holding the original, byte for byte', envelope.value, BLOB);
  eq('and naming where it came from',       envelope.key, 'muti-baobab-v1');
  check('and when it was taken',            !!envelope.backedUpAt);

  section('a second boot does not copy the family twice');
  const second = await ensureHomeTree(pool2, quiet);
  eq('same tree', second.treeId, moved.treeId);
  eq('nothing re-migrated', second.migrated, false);
  eq('still four people', (await fullTree(pool2, moved.treeId)).people.length, 4);

  section('and it never resets edits made since the move');
  // Somebody adds a relative through the app, then the server restarts.
  await applyOps(pool2, moved.treeId,
    [{ op:'addPerson', name:'Ruvarashe', sex:'f', born:'1995' }], 'Garikai');
  const third = await ensureHomeTree(pool2, quiet);
  eq('the tree is unchanged', third.treeId, moved.treeId);
  const after = await fullTree(pool2, moved.treeId);
  eq('the new relative is still there', after.people.length, 5);
  check('and by name', after.people.some(p => p.name === 'Ruvarashe'));

  section('a blob that cannot be read stops the boot rather than emptying the tree');
  await wipe();
  const pool3 = pool;
  await pool3.query('INSERT INTO kv_store (key, value) VALUES ($1,$2)',
                    ['muti-baobab-v1', '{ this is not json']);
  await rejects('it refuses to start',
    () => ensureHomeTree(pool3, quiet), /not starting rather than serving an empty tree/);
  eq('and no empty tree was left behind',
     (await pool3.query('SELECT count(*)::int n FROM trees')).rows[0].n, 0);

  report();
})();
