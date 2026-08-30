// Nothing recorded about a family is ever destroyed.
//
// A person can be SET ASIDE — taken out of the tree everybody sees — but the
// record stays, forever, and anyone can bring it back. These assert that
// there is genuinely no path through this API that loses a record, including
// the one that used to: merging two records for the same person.
//
// They also assert the two things a set-aside owes the person who entered it:
// a reason, and a way to find out.

const { check, eq, rejects, section, freshPool, newTree, report } = require('./helpers');
const { applyOps } = require('../db/ops');
const { bootstrap, search, setAsideList } = require('../db/reads');
const { findDuplicates } = require('../db/duplicates');

(async () => {
  const pool = await freshPool();
  const tree = await newTree(pool, 'set-aside');
  const ops = (o, actor) => applyOps(pool, tree, o, actor);
  const rowOf = async id =>
    (await pool.query('SELECT * FROM people WHERE id = $1', [id])).rows[0];

  // Rudo enters her father and her two brothers.
  const built = await ops([
    { op:'addPerson', ref:'$dad',  name:'Rufaro Moyo', sex:'m', born:'1940', addedBy:'Rudo' },
    { op:'addPerson', ref:'$kid1', name:'Garikai',     sex:'m', born:'1968', addedBy:'Rudo' },
    { op:'addPerson', ref:'$kid2', name:'Tendai',      sex:'m', born:'1971', addedBy:'Rudo' },
    { op:'addUnion',  ref:'$u' },
    { op:'addPartner', unionId:'$u', personId:'$dad' },
    { op:'addChild',   unionId:'$u', personId:'$kid1' },
    { op:'addChild',   unionId:'$u', personId:'$kid2' }
  ], 'Rudo');
  const id = k => built.refs['$' + k];

  section('a reason is not optional');
  await rejects('setting aside with no reason is refused',
    () => ops([{ op:'setAside', id:id('kid2') }], 'Tapiwa'), /reason is required/i);
  await rejects('and neither is a reason of only spaces',
    () => ops([{ op:'setAside', id:id('kid2'), why:'   ' }], 'Tapiwa'), /reason is required/i);
  eq('so the person is still in the tree', (await rowOf(id('kid2'))).aside_at, null);

  section('setting somebody aside');
  const set = await ops([{ op:'setAside', id:id('kid2'),
                           why:'Entered twice — this is the same Tendai as above.' }], 'Tapiwa');
  const aside = await rowOf(id('kid2'));
  check('the record still exists', !!aside);
  eq('with the name untouched',            aside.name, 'Tendai');
  eq('and the date untouched',             aside.born, '1971');
  eq('and whoever entered them untouched', aside.added_by, 'Rudo');
  check('marked aside',                    !!aside.aside_at);
  eq('by whoever did it',                  aside.aside_by, 'Tapiwa');
  eq('with the reason kept verbatim',      aside.aside_why,
     'Entered twice — this is the same Tendai as above.');
  eq('and the op names who must be told',  set.results[0].notify, 'Rudo');

  section('and they leave the tree everybody sees');
  const boot = await bootstrap(pool, tree, { focus: id('dad'), depth: 3 });
  eq('bootstrap does not return them',
     boot.people.some(p => p.id === id('kid2')), false);
  eq('but does return the brother who is still there',
     boot.people.some(p => p.id === id('kid1')), true);
  eq('the count does not include them', boot.total, 2);
  eq('search does not find them',
     (await search(pool, tree, 'Tendai')).results.length, 0);
  eq('search still finds the others',
     (await search(pool, tree, 'Garikai')).results.length, 1);

  section('the notice: an entry of mine that somebody took out');
  const mine = await setAsideList(pool, tree, { recordedBy:'Rudo' });
  eq('Rudo has one', mine.total, 1);
  eq('it names the person',   mine.people[0].name, 'Tendai');
  eq('it names who did it',   mine.people[0].asideBy, 'Tapiwa');
  eq('and it says why',       mine.people[0].asideWhy,
     'Entered twice — this is the same Tendai as above.');
  eq('somebody who recorded nothing has no notices',
     (await setAsideList(pool, tree, { recordedBy:'Nobody' })).total, 0);
  eq('and the full list is visible to anyone',
     (await setAsideList(pool, tree)).total, 1);

  section('anyone can bring them back');
  await ops([{ op:'restore', id:id('kid2') }], 'Chenai');
  const back = await rowOf(id('kid2'));
  eq('no longer aside',        back.aside_at, null);
  eq('the reason is cleared',  back.aside_why, '');
  eq('they are in the tree again',
     (await bootstrap(pool, tree, { focus:id('dad'), depth:3 }))
       .people.some(p => p.id === id('kid2')), true);
  eq('and the notice is gone, with nothing to mark as seen',
     (await setAsideList(pool, tree, { recordedBy:'Rudo' })).total, 0);

  section('the history survives both');
  const log = (await pool.query(
    `SELECT op, by, payload FROM changes WHERE tree_id = $1 AND entity_id = $2
      ORDER BY seq`, [tree, id('kid2')])).rows;
  eq('the set-aside is in the log', log.some(r => r.op === 'setAside'), true);
  eq('so is the restore',           log.some(r => r.op === 'restore'), true);
  eq('the reason is recoverable from the log even after the restore',
     log.find(r => r.op === 'setAside').payload.why,
     'Entered twice — this is the same Tendai as above.');

  section('merging a duplicate no longer destroys the record');
  const dup = await ops([
    { op:'addPerson', ref:'$again', name:'Sekuru Rufaro Moyo', sex:'m', born:'1940',
      addedBy:'Chenai' }
  ], 'Chenai');
  const dupId = dup.refs['$again'];
  await ops([{ op:'mergePeople', keepId:id('dad'), mergeId:dupId }], 'Tapiwa');
  const folded = await rowOf(dupId);
  check('the folded record still exists', !!folded);
  eq('with its name',       folded.name, 'Sekuru Rufaro Moyo');
  eq('and its author',      folded.added_by, 'Chenai');
  check('set aside rather than deleted', !!folded.aside_at);
  eq('pointing at what it was folded into', folded.merged_into, id('dad'));
  check('and saying so in the reason', /Folded into/.test(folded.aside_why));
  eq('the survivor is still in the tree',
     (await bootstrap(pool, tree, { focus:id('dad'), depth:3 }))
       .people.some(p => p.id === id('dad')), true);
  eq('the folded record is not',
     (await bootstrap(pool, tree, { focus:id('dad'), depth:3 }))
       .people.some(p => p.id === dupId), false);

  section('and Chenai is told what happened to hers');
  const hers = await setAsideList(pool, tree, { recordedBy:'Chenai' });
  eq('one notice',                    hers.total, 1);
  eq('naming where it went',          hers.people[0].mergedIntoName, 'Rufaro Moyo');

  section('a folded record does not come back as a duplicate of its survivor');
  const dupes = await findDuplicates(pool, tree);
  eq('nothing is flagged',
     dupes.pairs.filter(p => p.a.id === dupId || p.b.id === dupId).length, 0);

  section('the database itself refuses a set-aside with no reason');
  await rejects('even written straight to the table',
    () => pool.query(
      `UPDATE people SET aside_at = clock_timestamp(), aside_why = '' WHERE id = $1`,
      [id('kid1')]),
    /people_aside_needs_reason/);

  section('setting aside twice does not overwrite the first notice');
  await ops([{ op:'setAside', id:id('kid1'), why:'First reason.' }], 'Tapiwa');
  await ops([{ op:'setAside', id:id('kid1'), why:'Second reason.' }], 'Someone');
  const twice = await rowOf(id('kid1'));
  eq('the reason its author was told still stands', twice.aside_why, 'First reason.');
  eq('and so does who told them',                   twice.aside_by, 'Tapiwa');

  report();
})();
