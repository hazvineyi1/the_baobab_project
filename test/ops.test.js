// Ops engine: transactions, guards, birth order, merge, concurrency.

const { check, eq, rejects, section, freshPool, newTree, report } = require('./helpers');
const { applyOps } = require('../db/ops');
const graph = require('../db/graph');

(async () => {
  const pool = await freshPool();
  const tree = await newTree(pool, 'ops');
  const ops = (o, actor) => applyOps(pool, tree, o, actor);

  section('batches and local refs');
  const r1 = await ops([
    { op: 'addPerson', ref: '$dad',  name: 'Rufaro',  sex: 'm', born: '1940' },
    { op: 'addPerson', ref: '$mum',  name: 'Chipo',   sex: 'f', born: '1945' },
    { op: 'addUnion',  ref: '$u' },
    { op: 'addPartner', unionId: '$u', personId: '$dad' },
    { op: 'addPartner', unionId: '$u', personId: '$mum' },
    { op: 'addPerson', ref: '$kid1', name: 'Garikai', sex: 'm', born: '1968' },
    { op: 'addPerson', ref: '$kid2', name: 'Tendai',  sex: 'm', born: '1971' },
    { op: 'addChild', unionId: '$u', personId: '$kid1' },
    { op: 'addChild', unionId: '$u', personId: '$kid2' }
  ], 'tester');
  const id = k => r1.refs['$' + k];
  check('a batch creating and linking people in one go succeeds', !!r1.seq);
  check('local refs resolve to minted ids', !!id('dad') && !!id('kid1'));

  const c = await pool.connect();
  eq('children come back eldest-first', await graph.childrenOf(c, id('u')), [id('kid1'), id('kid2')]);
  eq('parentUnionOf finds the one parent union', await graph.parentUnionOf(c, id('kid1')), id('u'));
  eq('birthRank reflects position', await graph.birthRank(c, id('kid2')), 1);

  section('the tree stays consistent under bad links');
  await rejects('a person cannot be their own parent', () =>
    ops([{ op: 'addChild', unionId: id('u'), personId: id('dad') }]), { status: 422 });
  await rejects('a person cannot be a child of their own descendants', async () => {
    const g = await ops([{ op: 'addUnion', ref: '$gu' },
                         { op: 'addPartner', unionId: '$gu', personId: id('kid1') }]);
    return ops([{ op: 'addChild', unionId: g.refs['$gu'], personId: id('dad') }]);
  }, { status: 422 });
  await rejects('a second set of parents is refused', async () => {
    const g = await ops([{ op: 'addUnion', ref: '$u2' }]);
    return ops([{ op: 'addChild', unionId: g.refs['$u2'], personId: id('kid1') }]);
  }, { status: 422 });
  await rejects('a child cannot become a partner in their own parent union', () =>
    ops([{ op: 'addPartner', unionId: id('u'), personId: id('kid1') }]), { status: 422 });

  section('a failed batch leaves nothing behind');
  const before = (await pool.query('SELECT count(*)::int n FROM people WHERE tree_id=$1', [tree])).rows[0].n;
  await rejects('the batch is rejected', () => ops([
    { op: 'addPerson', ref: '$ghost', name: 'Never Saved' },
    { op: 'addChild', unionId: id('u'), personId: id('dad') }   // fails
  ]), { status: 422 });
  const after = (await pool.query('SELECT count(*)::int n FROM people WHERE tree_id=$1', [tree])).rows[0].n;
  eq('the person created earlier in the batch was rolled back', after, before);

  section('birth order is hand-settable');
  await ops([{ op: 'addPerson', ref: '$kid0', name: 'Nyasha', sex: 'f', born: '1965' },
             { op: 'addChild', unionId: id('u'), personId: '$kid0', birthOrder: 0 }]);
  const kids = await graph.childrenOf(c, id('u'));
  eq('inserting at birthOrder 0 makes them eldest', kids.length, 3);
  const names = (await pool.query(
    `SELECT p.name FROM union_children uc JOIN people p ON p.id=uc.person_id
      WHERE uc.union_id=$1 ORDER BY uc.birth_order`, [id('u')])).rows.map(r => r.name);
  eq('siblings are ordered Nyasha, Garikai, Tendai', names, ['Nyasha', 'Garikai', 'Tendai']);

  await ops([{ op: 'reorderChildren', unionId: id('u'), orderedIds: [id('kid2'), id('kid1'), kids[0]] }]);
  const names2 = (await pool.query(
    `SELECT p.name FROM union_children uc JOIN people p ON p.id=uc.person_id
      WHERE uc.union_id=$1 ORDER BY uc.birth_order`, [id('u')])).rows.map(r => r.name);
  eq('a hand reorder sticks', names2, ['Tendai', 'Garikai', 'Nyasha']);
  await rejects('reordering a stale sibling list is refused', () =>
    ops([{ op: 'reorderChildren', unionId: id('u'), orderedIds: [id('kid1'), id('kid2')] }]),
    { status: 409 });

  section('remarriage: one person, several unions');
  const r2 = await ops([
    { op: 'addPerson', ref: '$w2', name: 'Shamiso', sex: 'f' },
    { op: 'addUnion', ref: '$u2' },
    { op: 'addPartner', unionId: '$u2', personId: id('dad') },
    { op: 'addPartner', unionId: '$u2', personId: '$w2' },
    { op: 'addPerson', ref: '$k3', name: 'Farai', sex: 'f' },
    { op: 'addChild', unionId: '$u2', personId: '$k3' }
  ]);
  eq('the father is a partner in two unions', (await graph.unionsOf(c, id('dad'))).length, 2);
  eq('each union keeps its own children',
     (await graph.childrenOf(c, r2.refs['$u2'])).length, 1);

  section('a union may have one partner, or none');
  const r3 = await ops([
    { op: 'addUnion', ref: '$solo' },
    { op: 'addPerson', ref: '$lone', name: 'Mbuya Sarah', sex: 'f' },
    { op: 'addPartner', unionId: '$solo', personId: '$lone' },
    { op: 'addPerson', ref: '$sk', name: 'Tapiwa' },
    { op: 'addChild', unionId: '$solo', personId: '$sk' }
  ]);
  check('a one-partner union (spouse unknown) is accepted', !!r3.seq);
  const r4 = await ops([
    { op: 'addUnion', ref: '$none' },
    { op: 'addPerson', ref: '$s1', name: 'Sibling One' },
    { op: 'addPerson', ref: '$s2', name: 'Sibling Two' },
    { op: 'addChild', unionId: '$none', personId: '$s1' },
    { op: 'addChild', unionId: '$none', personId: '$s2' }
  ]);
  check('a no-partner union (siblings, parents unrecorded) is accepted', !!r4.seq);

  section('titles are stripped for matching but the name is kept intact');
  const nk = (await pool.query(
    `SELECT name, name_key FROM people WHERE id=$1`, [r3.refs['$lone']])).rows[0];
  eq('the displayed name is untouched', nk.name, 'Mbuya Sarah');
  eq('the match key drops the honorific', nk.name_key, 'sarah');

  section('every op is logged for incremental sync');
  const log = (await pool.query(
    'SELECT op, by FROM changes WHERE tree_id=$1 ORDER BY seq LIMIT 3', [tree])).rows;
  eq('the log records ops in order', log.map(r => r.op), ['addPerson', 'addPerson', 'addUnion']);
  eq('the log records who made the change', log[0].by, 'tester');

  c.release();
  await pool.end();
  report();
})().catch(e => { console.error('\nHARNESS ERROR:', e); process.exit(1); });
