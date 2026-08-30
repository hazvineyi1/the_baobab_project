// Where two families meet.
//
// Two households record their own people. Neither knows about the other. Both
// trace back to one man. The question these ask is whether the system can find
// him — and, much more importantly, whether it can be trusted not to find him
// where he is not.
//
// The asymmetry is the whole design. Inside one family a false match costs a
// moment. Across families it claims two unrelated households descend from one
// man, which in a system where lineage carries totem and marriage rules is not
// a small thing to be wrong about.

const { check, eq, rejects, section, freshPool, newTree, report } = require('./helpers');
const { applyOps } = require('../db/ops');
const { findRelatives, linksFor, match, WEIGHTS, THRESHOLD } = require('../db/crosstree');

(async () => {
  const pool = await freshPool();

  // ---- The Moyo household, recorded by Rudo -----------------------------
  const moyo = await newTree(pool, 'Moyo');
  const m = await applyOps(pool, moyo, [
    { op:'addPerson', ref:'$old',  name:'Rufaro Moyo', sex:'m', totem:'Shumba', born:'1912' },
    { op:'addPerson', ref:'$wife', name:'Nyarai Moyo', sex:'f', totem:'Soko',   born:'1918' },
    { op:'addPerson', ref:'$son',  name:'Garikai',     sex:'m', totem:'Shumba', born:'1945' },
    { op:'addUnion',  ref:'$u' },
    { op:'addPartner', unionId:'$u', personId:'$old' },
    { op:'addPartner', unionId:'$u', personId:'$wife' },
    { op:'addChild',   unionId:'$u', personId:'$son' }
  ], 'Rudo');
  const M = k => m.refs['$' + k];

  // ---- The Ncube household, recorded by Tapiwa, who has never met Rudo ---
  // They know the same old man — through a different son.
  const ncube = await newTree(pool, 'Ncube');
  const n = await applyOps(pool, ncube, [
    { op:'addPerson', ref:'$old',  name:'Sekuru Rufaro Moyo', sex:'m', totem:'Shumba', born:'1912' },
    { op:'addPerson', ref:'$wife', name:'Nyarai',             sex:'f', totem:'Soko',   born:'1919' },
    { op:'addPerson', ref:'$son',  name:'Tendai',             sex:'m', totem:'Shumba', born:'1949' },
    { op:'addUnion',  ref:'$u' },
    { op:'addPartner', unionId:'$u', personId:'$old' },
    { op:'addPartner', unionId:'$u', personId:'$wife' },
    { op:'addChild',   unionId:'$u', personId:'$son' }
  ], 'Tapiwa');
  const N = k => n.refs['$' + k];

  section('two families who have never met find their shared ancestor');
  let found = await findRelatives(pool, moyo);
  const old = found.matches.find(x => x.mine.id === M('old'));
  check('the old man is matched', !!old,
        found.matches.map(x => `${x.mine.name}/${x.theirs.name}=${x.score}`).join('; '));
  eq('to the right record in the other tree', old && old.theirs.id, N('old'));
  eq('and it names which family',             old && old.theirs.treeName, 'Ncube');
  check('the title did not stop it — Sekuru Rufaro Moyo is Rufaro Moyo',
        old && old.why.some(w => /both recorded as/.test(w)));
  check('the totem is part of why',  old && old.why.some(w => /same totem/.test(w)));
  check('and so is the shared wife', old && old.why.some(w => /married to the same name/.test(w)));

  section('and it reads the same from the other family’s side');
  const back = await findRelatives(pool, ncube);
  check('the Ncube tree finds the Moyo one',
        back.matches.some(x => x.mine.id === N('old') && x.theirs.id === M('old')));

  section('a name on its own is never enough');
  // Garikai is a name half the district carries. Nothing else about these two
  // agrees: different totem, born a generation apart, no relative in common.
  const other = await newTree(pool, 'Dube');
  await applyOps(pool, other, [
    { op:'addPerson', name:'Garikai', sex:'m', totem:'Nzou', born:'1978' }
  ], 'Someone');
  found = await findRelatives(pool, moyo);
  eq('the two Garikais are not matched',
     found.matches.filter(x => x.mine.id === M('son')).length, 0);
  check('though the scan did compare them', found.compared > 0);

  section('a shared name and totem alone is a house, not a person');
  // Same name, same mutupo, nothing else known. That is the ordinary case in
  // a country where children are named for their grandparents.
  const thin = await newTree(pool, 'Thin');
  await applyOps(pool, thin, [
    { op:'addPerson', name:'Rufaro Moyo', sex:'m', totem:'Shumba' }
  ], 'Someone');
  found = await findRelatives(pool, moyo);
  eq('not offered as a match',
     found.matches.filter(x => x.theirs.treeName === 'Thin').length, 0);

  section('a different totem argues hard against a match');
  const wrong = await newTree(pool, 'Wrong');
  const w = await applyOps(pool, wrong, [
    { op:'addPerson', ref:'$x', name:'Rufaro Moyo', sex:'m', totem:'Nzou', born:'1912' },
    { op:'addPerson', ref:'$y', name:'Nyarai', sex:'f', born:'1918' },
    { op:'addUnion', ref:'$u' },
    { op:'addPartner', unionId:'$u', personId:'$x' },
    { op:'addPartner', unionId:'$u', personId:'$y' }
  ], 'Someone');
  found = await findRelatives(pool, moyo);
  const wrongOne = found.matches.find(x => x.theirs.id === w.refs['$x']);
  check('same name, same year, same wife’s name — but a different mutupo, so not offered',
        !wrongOne,
        wrongOne ? `offered anyway at ${wrongOne.score}` : '');

  section('a family can ask not to be compared');
  await pool.query('UPDATE trees SET shares_frontier = false WHERE id = $1', [ncube]);
  found = await findRelatives(pool, moyo);
  eq('they stop appearing in anyone else’s matches',
     found.matches.filter(x => x.theirs.treeId === ncube).length, 0);
  const theirs = await findRelatives(pool, ncube);
  eq('and they are told why they see nothing', theirs.shared, false);
  check('in words', /asked not to be compared/.test(theirs.note || ''));
  await pool.query('UPDATE trees SET shares_frontier = true WHERE id = $1', [ncube]);

  section('saying yes records a link, and does not merge anything');
  const link = await applyOps(pool, moyo, [
    { op:'proposeLink', personId:M('old'), otherPersonId:N('old'),
      score:0.9, why:'Same man — my great-grandfather.' }
  ], 'Rudo');
  const linkId = link.results[0].linkId;
  check('a link was recorded', !!linkId);
  eq('both records still exist and are still theirs',
     (await pool.query('SELECT tree_id FROM people WHERE id = $1', [N('old')])).rows[0].tree_id,
     ncube);
  eq('the Moyo record is untouched too',
     (await pool.query('SELECT tree_id FROM people WHERE id = $1', [M('old')])).rows[0].tree_id,
     moyo);
  eq('neither tree lost anybody',
     (await pool.query('SELECT count(*)::int n FROM people WHERE tree_id = $1', [ncube])).rows[0].n, 3);

  section('the other family sees it from their own side');
  const seen = await linksFor(pool, ncube);
  eq('one link',            seen.length, 1);
  eq('"mine" is theirs',    seen[0].mine.id, N('old'));
  eq('and "theirs" is ours', seen[0].theirs.id, M('old'));
  eq('named as the Moyo family', seen[0].theirs.treeName, 'Moyo');
  eq('still awaiting their answer', seen[0].status, 'proposed');

  section('and a proposed pair is not offered again');
  found = await findRelatives(pool, moyo);
  eq('it has left the suggestions',
     found.matches.filter(x => x.theirs.id === N('old')).length, 0);

  section('either family can confirm it');
  await applyOps(pool, ncube, [{ op:'decideLink', linkId, status:'confirmed' }], 'Tapiwa');
  eq('confirmed', (await linksFor(pool, moyo))[0].status, 'confirmed');
  eq('and it says who agreed', (await linksFor(pool, moyo))[0].decidedBy, 'Tapiwa');

  section('a rejection is kept, so the same suggestion does not return for ever');
  const l2 = await applyOps(pool, moyo, [
    { op:'proposeLink', personId:M('wife'), otherPersonId:N('wife') }
  ], 'Rudo');
  await applyOps(pool, moyo,
    [{ op:'decideLink', linkId:l2.results[0].linkId, status:'rejected' }], 'Rudo');
  found = await findRelatives(pool, moyo);
  eq('the rejected pair stays out of the suggestions',
     found.matches.filter(x => x.theirs.id === N('wife')).length, 0);
  eq('but the decision is on record',
     (await linksFor(pool, moyo, 'rejected')).length, 1);

  section('a third family cannot answer for two others');
  await rejects('they are refused',
    () => applyOps(pool, other, [{ op:'decideLink', linkId, status:'rejected' }], 'Nosy'),
    /between two other families/);

  section('and a link is never a way to merge inside one tree');
  await rejects('two people in the same tree are refused',
    () => applyOps(pool, moyo,
      [{ op:'proposeLink', personId:M('old'), otherPersonId:M('son') }], 'Rudo'),
    /duplicate to merge, not a link/);

  section('the scan stays cheap: names are buckets, not a cross-product');
  const big = await newTree(pool, 'Big');
  const rows = [];
  for (let i = 0; i < 300; i++) {
    rows.push({ op:'addPerson', name:`Unrelated Person ${i}`, sex:'m', born:String(1900 + i % 80) });
  }
  await applyOps(pool, big, rows, 'bulk');
  const t0 = Date.now();
  const scan = await findRelatives(pool, moyo);
  const ms = Date.now() - t0;
  check(`300 unrelated people add nothing to compare (${scan.compared} comparisons, ${ms}ms)`,
        scan.compared < 50, `compared=${scan.compared}`);
  check('and the scan is fast', ms < 3000, `${ms}ms`);

  report();
})();
