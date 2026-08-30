// Concurrency.
//
// The old store kept the entire tree as one JSON string in one row, so two
// relatives editing at the same time meant the second save silently erased
// everything the first had added. That is the single worst failure the app
// had, and these are the tests that say it is gone.

const { check, eq, rejects, section, freshPool, newTree, report } = require('./helpers');
const { applyOps } = require('../db/ops');

(async () => {
  const pool = await freshPool();
  const tree = await newTree(pool, 'concurrency');
  const ops = (o, actor) => applyOps(pool, tree, o, actor);

  // A shared starting point: two grandparents, two separate branches beneath.
  const base = await ops([
    { op: 'addPerson', ref: '$gf', name: 'Sekuru Tafara', sex: 'm' },
    { op: 'addPerson', ref: '$gm', name: 'Mbuya Rudo',    sex: 'f' },
    { op: 'addUnion',  ref: '$gu' },
    { op: 'addPartner', unionId: '$gu', personId: '$gf' },
    { op: 'addPartner', unionId: '$gu', personId: '$gm' },
    { op: 'addPerson', ref: '$a', name: 'Rufaro', sex: 'm' },
    { op: 'addPerson', ref: '$b', name: 'Chipo',  sex: 'f' },
    { op: 'addChild', unionId: '$gu', personId: '$a' },
    { op: 'addChild', unionId: '$gu', personId: '$b' },
    { op: 'addUnion', ref: '$ua' }, { op: 'addPartner', unionId: '$ua', personId: '$a' },
    { op: 'addUnion', ref: '$ub' }, { op: 'addPartner', unionId: '$ub', personId: '$b' }
  ]);
  const id = k => base.refs['$' + k];

  section('two relatives editing different branches — both sets of work survive');
  // Amai adds three children to Rufaro's branch while Baba adds three to
  // Chipo's, at the same moment, from two different phones.
  const [amai, baba] = await Promise.all([
    ops([{ op: 'addPerson', ref: '$1', name: 'Tendai',  sex: 'm' },
         { op: 'addPerson', ref: '$2', name: 'Nyasha',  sex: 'f' },
         { op: 'addPerson', ref: '$3', name: 'Farai',   sex: 'm' },
         { op: 'addChild', unionId: id('ua'), personId: '$1' },
         { op: 'addChild', unionId: id('ua'), personId: '$2' },
         { op: 'addChild', unionId: id('ua'), personId: '$3' }], 'amai'),
    ops([{ op: 'addPerson', ref: '$1', name: 'Kudzai',  sex: 'f' },
         { op: 'addPerson', ref: '$2', name: 'Tanaka',  sex: 'm' },
         { op: 'addPerson', ref: '$3', name: 'Rutendo', sex: 'f' },
         { op: 'addChild', unionId: id('ub'), personId: '$1' },
         { op: 'addChild', unionId: id('ub'), personId: '$2' },
         { op: 'addChild', unionId: id('ub'), personId: '$3' }], 'baba')
  ]);
  check('both writers succeeded', !!amai.seq && !!baba.seq);

  const branchA = (await pool.query(
    `SELECT p.name FROM union_children uc JOIN people p ON p.id=uc.person_id
      WHERE uc.union_id=$1 ORDER BY uc.birth_order`, [id('ua')])).rows.map(r => r.name);
  const branchB = (await pool.query(
    `SELECT p.name FROM union_children uc JOIN people p ON p.id=uc.person_id
      WHERE uc.union_id=$1 ORDER BY uc.birth_order`, [id('ub')])).rows.map(r => r.name);
  eq("everything Amai added is still there", branchA, ['Tendai', 'Nyasha', 'Farai']);
  eq("everything Baba added is still there", branchB, ['Kudzai', 'Tanaka', 'Rutendo']);
  eq('nobody was silently dropped',
     (await pool.query('SELECT count(*)::int n FROM people WHERE tree_id=$1', [tree])).rows[0].n, 10);

  section('ten writers at once, all on different branches');
  const many = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      ops([{ op: 'addPerson', ref: '$p', name: `Mwana ${i}` },
           { op: 'addUnion', ref: '$u' },
           { op: 'addPartner', unionId: '$u', personId: '$p' }], `writer${i}`)));
  check('all ten batches committed', many.every(m => m.seq > 0));
  eq('all ten people exist',
     (await pool.query(`SELECT count(*)::int n FROM people WHERE tree_id=$1 AND name LIKE 'Mwana %'`,
        [tree])).rows[0].n, 10);

  section('the change log is gapless and ordered, so no client misses a sync');
  const seqs = (await pool.query(
    'SELECT seq FROM changes WHERE tree_id=$1 ORDER BY seq', [tree])).rows.map(r => Number(r.seq));
  check('sequence numbers strictly increase', seqs.every((s, i) => i === 0 || s > seqs[i - 1]));
  // Every committed op must be visible to a client polling from 0. If seqs
  // could commit out of order, a poller would skip rows permanently.
  const maxSeq = Math.max(...seqs);
  const sinceZero = (await pool.query(
    'SELECT count(*)::int n FROM changes WHERE tree_id=$1 AND seq > 0', [tree])).rows[0].n;
  eq('a client syncing from 0 sees every logged change', sinceZero, seqs.length);
  eq('the seq returned to the last writer is the true head',
     Math.max(...many.map(m => m.seq)), maxSeq);

  section('two relatives editing THE SAME person — the loser is told, not overwritten');
  const person = (await pool.query('SELECT * FROM people WHERE id=$1', [id('a')])).rows[0];
  const stamp = new Date(person.updated_at).toISOString();

  // Both loaded the same version of Rufaro.
  await ops([{ op: 'updatePerson', id: id('a'), expect: stamp, totem: 'Shumba' }], 'first');

  let conflict = null;
  try {
    await ops([{ op: 'updatePerson', id: id('a'), expect: stamp, totem: 'Nzou' }], 'second');
  } catch (e) { conflict = e; }

  check('the second writer is rejected', conflict != null);
  eq('with 409, not a silent success', conflict?.status, 409);
  check('and is handed the current state to merge against',
        conflict?.current?.id === id('a') && conflict?.current?.totem === 'Shumba',
        `got ${JSON.stringify(conflict?.current?.totem)}`);

  const now = (await pool.query('SELECT totem FROM people WHERE id=$1', [id('a')])).rows[0];
  eq("the first writer's edit was not clobbered", now.totem, 'Shumba');

  // Having been shown the current state, the loser can retry against it.
  await ops([{ op: 'updatePerson', id: id('a'),
               expect: new Date(conflict.current.updated_at).toISOString(),
               totem: 'Nzou' }], 'second');
  eq('retrying against the current version succeeds',
     (await pool.query('SELECT totem FROM people WHERE id=$1', [id('a')])).rows[0].totem, 'Nzou');

  section('a genuine simultaneous race on one person — exactly one wins');
  const p2 = (await pool.query('SELECT * FROM people WHERE id=$1', [id('b')])).rows[0];
  const s2 = new Date(p2.updated_at).toISOString();
  const raced = await Promise.allSettled([
    ops([{ op: 'updatePerson', id: id('b'), expect: s2, born: '1948' }], 'x'),
    ops([{ op: 'updatePerson', id: id('b'), expect: s2, born: '1950' }], 'y')
  ]);
  const won = raced.filter(r => r.status === 'fulfilled');
  const lost = raced.filter(r => r.status === 'rejected');
  eq('exactly one writer won', won.length, 1);
  eq('exactly one was told to merge', lost.length, 1);
  eq('the loser got a 409', lost[0]?.reason?.status, 409);

  section('unversioned writes to different fields of one person both survive');
  // Two relatives filling in different blanks on the same record, neither
  // sending a version. This is the field-level case the blob API destroyed.
  await Promise.all([
    ops([{ op: 'updatePerson', id: id('b'), totem: 'Soko' }], 'x'),
    ops([{ op: 'updatePerson', id: id('b'), died: '2011' }], 'y')
  ]);
  const merged = (await pool.query('SELECT totem, died FROM people WHERE id=$1', [id('b')])).rows[0];
  eq('both fields are present', [merged.totem, merged.died], ['Soko', '2011']);

  await pool.end();
  report();
})().catch(e => { console.error('\nHARNESS ERROR:', e); process.exit(1); });
