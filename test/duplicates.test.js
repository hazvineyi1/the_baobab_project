// Duplicate detection.
//
// The central claim being tested: duplicate detection judges family POSITION,
// not name. Three living Garikais in one family is ordinary, because children
// are named after their grandparents.

const { check, eq, section, freshPool, newTree, report } = require('./helpers');
const { applyOps } = require('../db/ops');
const { findDuplicates, nameSimilarity, WEIGHTS } = require('../db/duplicates');

(async () => {
  const pool = await freshPool();
  const tree = await newTree(pool, 'dupes');
  const ops = o => applyOps(pool, tree, o, 'tester');

  // Grandfather Garikai -> son Rufaro -> grandson Garikai -> great-grandson
  // Garikai. Three Garikais in one direct line, which is how families work.
  const r = await ops([
    { op: 'addPerson', ref: '$g1',  name: 'Garikai Moyo', sex: 'm', born: '1920' },
    { op: 'addPerson', ref: '$gw',  name: 'Rudo Moyo',    sex: 'f', born: '1925' },
    { op: 'addUnion', ref: '$u1' },
    { op: 'addPartner', unionId: '$u1', personId: '$g1' },
    { op: 'addPartner', unionId: '$u1', personId: '$gw' },

    { op: 'addPerson', ref: '$dad', name: 'Rufaro Moyo', sex: 'm', born: '1950' },
    { op: 'addChild', unionId: '$u1', personId: '$dad' },
    { op: 'addPerson', ref: '$mum', name: 'Chipo Dube', sex: 'f', born: '1955' },
    { op: 'addUnion', ref: '$u2' },
    { op: 'addPartner', unionId: '$u2', personId: '$dad' },
    { op: 'addPartner', unionId: '$u2', personId: '$mum' },

    { op: 'addPerson', ref: '$g2', name: 'Garikai Moyo', sex: 'm', born: '1980' },
    { op: 'addChild', unionId: '$u2', personId: '$g2' },
    { op: 'addPerson', ref: '$w2', name: 'Rutendo Ncube', sex: 'f', born: '1982' },
    { op: 'addUnion', ref: '$u3' },
    { op: 'addPartner', unionId: '$u3', personId: '$g2' },
    { op: 'addPartner', unionId: '$u3', personId: '$w2' },

    { op: 'addPerson', ref: '$g3', name: 'Garikai Moyo', sex: 'm', born: '2008' },
    { op: 'addChild', unionId: '$u3', personId: '$g3' }
  ]);
  const id = k => r.refs['$' + k];

  section('three Garikais in one family are not duplicates');
  let scan = await findDuplicates(pool, tree);
  const flagged = scan.pairs.map(p => [p.a.name, p.b.name].join(' / '));
  eq('no pair is flagged', scan.pairs.length, 0, flagged.join('; '));
  check('and the scan really did compare them', scan.comparisons >= 3,
        `comparisons=${scan.comparisons}`);

  section('a real duplicate — two records married to the same man');
  // Rufaro's wife entered twice, once with a title, by two different relatives.
  const d = await ops([
    { op: 'addPerson', ref: '$dup', name: 'Mai Chipo Dube', sex: 'f', born: '1955' },
    { op: 'addPartner', unionId: id('u2'), personId: '$dup' }
  ]);
  scan = await findDuplicates(pool, tree);
  const pair = scan.pairs.find(p =>
    [p.a.id, p.b.id].includes(id('mum')) && [p.a.id, p.b.id].includes(d.refs['$dup']));
  check('the pair is flagged', !!pair, scan.pairs.map(p => `${p.a.name}/${p.b.name}=${p.score}`).join('; '));
  check('because of the shared spouse, not the name',
        pair?.why.some(w => w.signal === 'shared spouse'),
        JSON.stringify(pair?.why));
  check('and the title did not stop them matching',
        pair?.score > WEIGHTS.NAME_CAP, `score=${pair?.score}`);

  section('a name on its own can never flag a pair');
  const far = await ops([
    { op: 'addPerson', ref: '$x', name: 'Tapiwa Nyathi', sex: 'm' },
    { op: 'addPerson', ref: '$y', name: 'Tapiwa Nyathi', sex: 'm' }
  ]);
  scan = await findDuplicates(pool, tree);
  const namePair = scan.pairs.find(p =>
    [p.a.id, p.b.id].includes(far.refs['$x']) && [p.a.id, p.b.id].includes(far.refs['$y']));
  check('two unconnected people with identical names are not flagged', !namePair);
  check('the name signal alone cannot reach the threshold',
        WEIGHTS.NAME_CAP < scan.threshold,
        `cap=${WEIGHTS.NAME_CAP} threshold=${scan.threshold}`);

  section('a dismissal survives, and survives a reload');
  await ops([{ op: 'dismissDuplicate', aId: id('mum'), bId: d.refs['$dup'] }]);
  scan = await findDuplicates(pool, tree);
  check('the dismissed pair no longer appears',
        !scan.pairs.some(p => [p.a.id, p.b.id].includes(d.refs['$dup'])));

  // Recorded the other way round, it must still be suppressed — this is what
  // the CHECK (a_id < b_id) canonical ordering exists for.
  const reversed = await pool.query(
    'SELECT count(*)::int n FROM not_duplicates WHERE tree_id=$1', [tree]);
  eq('exactly one dismissal row was written, not two', reversed.rows[0].n, 1);
  await ops([{ op: 'dismissDuplicate', aId: d.refs['$dup'], bId: id('mum') }]);
  eq('dismissing the same pair the other way round adds nothing',
     (await pool.query('SELECT count(*)::int n FROM not_duplicates WHERE tree_id=$1', [tree])).rows[0].n, 1);

  // A fresh scan is a reload as far as this is concerned: nothing is cached.
  scan = await findDuplicates(pool, tree);
  check('still suppressed on a fresh scan',
        !scan.pairs.some(p => [p.a.id, p.b.id].includes(d.refs['$dup'])));

  section('merging two records into one');
  // Undo the dismissal case: make a genuine duplicate and merge it.
  const m = await ops([
    { op: 'addPerson', ref: '$dup2', name: 'Rufaro Moyo', sex: 'm', born: '1950' },
    { op: 'addChild', unionId: id('u1'), personId: '$dup2' }
  ]);
  scan = await findDuplicates(pool, tree);
  const mergePair = scan.pairs.find(p =>
    [p.a.id, p.b.id].includes(id('dad')) && [p.a.id, p.b.id].includes(m.refs['$dup2']));
  check('two records as children of the same couple are flagged', !!mergePair,
        `score=${mergePair?.score}`);
  check('because they share a parent union',
        mergePair?.why.some(w => w.signal === 'same parents'));

  const beforeCount = (await pool.query('SELECT count(*)::int n FROM people WHERE tree_id=$1', [tree])).rows[0].n;
  await ops([{ op: 'mergePeople', keepId: id('dad'), mergeId: m.refs['$dup2'] }]);
  const afterCount = (await pool.query('SELECT count(*)::int n FROM people WHERE tree_id=$1', [tree])).rows[0].n;
  eq('the merged record is gone', afterCount, beforeCount - 1);
  check('the survivor is still there',
        (await pool.query('SELECT 1 FROM people WHERE id=$1', [id('dad')])).rowCount === 1);
  eq('the survivor kept their children',
     (await pool.query('SELECT count(*)::int n FROM union_children WHERE union_id=$1', [id('u2')])).rows[0].n, 1);
  scan = await findDuplicates(pool, tree);
  check('and the pair no longer shows up', !scan.pairs.some(p =>
    [p.a.id, p.b.id].includes(m.refs['$dup2'])));

  section('merge fills blanks from the absorbed record');
  const f = await ops([
    { op: 'addPerson', ref: '$a', name: 'Tafara Sibanda', sex: 'm' },
    { op: 'addPerson', ref: '$b', name: 'Tafara Sibanda', sex: 'm', totem: 'Shumba', born: '1944' }
  ]);
  await ops([{ op: 'mergePeople', keepId: f.refs['$a'], mergeId: f.refs['$b'] }]);
  const kept = (await pool.query('SELECT totem, born FROM people WHERE id=$1', [f.refs['$a']])).rows[0];
  eq('the survivor gained the detail it was missing', [kept.totem, kept.born], ['Shumba', '1944']);

  section('scoring signals');
  eq('an identical name scores 1', nameSimilarity('garikai', 'garikai'), 1);
  check('a near-miss spelling still scores high',
        nameSimilarity('garikai', 'garikayi') > 0.6,
        String(nameSimilarity('garikai', 'garikayi')));
  check('unrelated names score low',
        nameSimilarity('garikai', 'chipo') < 0.2);
  eq('weights are the ported values, unchanged',
     [WEIGHTS.SHARED_SPOUSE, WEIGHTS.SHARED_CHILD, WEIGHTS.SAME_PARENT_UNION,
      WEIGHTS.GENERATION_APART, WEIGHTS.DIFFERENT_PARENTS, WEIGHTS.DIFFERENT_SEX,
      WEIGHTS.NAME_CAP],
     [0.5, 0.5, 0.4, -0.45, -0.4, -0.6, 0.34]);

  section('the scan does not compare everyone to everyone');
  check('far fewer comparisons than the naive scan',
        scan.comparisons < scan.naiveComparisons,
        `${scan.comparisons} vs ${scan.naiveComparisons}`);

  await pool.end();
  report();
})().catch(e => { console.error('\nHARNESS ERROR:', e); process.exit(1); });
