// Port parity.
//
// db/duplicates.js claims to be a faithful port of sameness() in
// public/index.html. This is the test that makes the claim checkable rather
// than aspirational: it lifts the real functions straight out of the shipped
// frontend, runs them and the server's on the same trees, and fails on any
// disagreement about which pairs are candidates or what they score.
//
// If the browser and the server ever start giving the family different
// answers about whether two records are one person, this goes red.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { check, eq, section, freshPool, newTree, report } = require('./helpers');
const { applyOps } = require('../db/ops');
const server = require('../db/duplicates');

// ── run the frontend's own code, whole, in a stubbed DOM ──────────────────
//
// Not an extract of it: the entire <script> from the shipped page, evaluated
// against a stand-in for the browser. Testing a copied fragment would only
// prove the fragment agrees with itself, and any drift in index.html would go
// unnoticed. This way the functions under test are literally the ones the
// family's browsers run.
function loadFrontend(){
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  let src = html.split('<script>')[1].split('</script>')[0];

  // The page kicks itself off by loading the shared tree and painting it.
  // Everything after that is what we want to call directly, so the boot line
  // is the one statement that has to go.
  src = src.replace(/\nload\(\);\s*$/, '\n/* boot skipped under test */\n');
  if (/\nload\(\);/.test(src)) throw new Error('frontend boot call was not neutralised');

  // A DOM stand-in that absorbs whatever the page does to it. It is never
  // inspected — the tests only call the pure model and scoring functions —
  // so it just has to be permissive enough that top-level wiring runs.
  const node = () => new Proxy(function(){}, {
    get(t, k){
      if (k === 'style' || k === 'classList' || k === 'dataset') return node();
      if (k === 'children' || k === 'rows') return [];
      if (k === Symbol.toPrimitive || k === 'toString') return () => '';
      if (k === 'length') return 0;
      return node();
    },
    set(){ return true; },
    apply(){ return node(); }
  });

  const sandbox = {
    console,
    document: { getElementById: node, createElement: node, querySelector: node,
                querySelectorAll: () => [], body: node(),
                documentElement: { dataset: {} } },
    addEventListener(){}, removeEventListener(){},
    innerWidth: 1280, innerHeight: 800,
    setTimeout, clearTimeout, Math, JSON, Date, Set, Map, Object, Array, String, Number,
    localStorage: { getItem: () => null, setItem(){}, removeItem(){} },
    fetch: () => Promise.reject(new Error('offline under test')),
    confirm: () => false
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + `
    this.api = {
      sameness, duplicatePairs, likelyDuplicates, generations, nameTokens,
      nameSimilarity, mustBeDifferent, birthYear, parentUnionOf, partnersOf,
      setState(s){ state = s; }
    };`, sandbox);
  if (typeof sandbox.api.sameness !== 'function'){
    throw new Error('the frontend script did not expose sameness()');
  }
  return sandbox.api;
}

// ── turn a database tree back into the shape the frontend holds ────────────
async function asFrontendState(pool, treeId){
  const [p, up, uc, nd] = await Promise.all([
    pool.query(`SELECT id, name, sex, totem, born, died, is_root FROM people WHERE tree_id=$1`, [treeId]),
    pool.query(`SELECT up.union_id, up.person_id FROM union_partners up JOIN unions u ON u.id=up.union_id
                 WHERE u.tree_id=$1 ORDER BY up.position`, [treeId]),
    pool.query(`SELECT uc.union_id, uc.person_id FROM union_children uc JOIN unions u ON u.id=uc.union_id
                 WHERE u.tree_id=$1 ORDER BY uc.birth_order`, [treeId]),
    pool.query(`SELECT a_id, b_id FROM not_duplicates WHERE tree_id=$1`, [treeId])
  ]);
  const people = {}, unions = {};
  for (const r of p.rows){
    people[r.id] = { id:r.id, name:r.name, sex:r.sex, totem:r.totem,
                     born:r.born, died:r.died, root:r.is_root };
  }
  const touch = id => (unions[id] = unions[id] || { id, partners:[], children:[] });
  for (const r of up.rows) touch(r.union_id).partners.push(r.person_id);
  for (const r of uc.rows) touch(r.union_id).children.push(r.person_id);
  const root = p.rows.find(x => x.is_root);
  return {
    people, unions, seq:1,
    rootId: root ? root.id : null,
    notDuplicates: nd.rows.map(r => [r.a_id, r.b_id].sort().join('|'))
  };
}

// Compare the two implementations over every pair in a tree.
async function comparePair(fe, pool, treeId, label){
  const st = await asFrontendState(pool, treeId);
  fe.setState(st);

  const g = await server.loadTree(pool, treeId);
  const gen = server.generations(g);
  const feGen = fe.generations();

  const ids = Object.keys(st.people).sort();
  let compared = 0, scoreMismatch = [], candMismatch = [], genMismatch = [];

  for (const id of ids){
    // Generations only ever matter as a difference, so compare differences.
    for (const other of ids){
      if (id >= other) continue;
      const dFe = Math.abs(feGen[id] - feGen[other]);
      const dSv = Math.abs(gen[id] - gen[other]);
      if (dFe !== dSv && genMismatch.length < 4){
        genMismatch.push(`${st.people[id].name}/${st.people[other].name}: front ${dFe}, server ${dSv}`);
      }
    }
  }

  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++){
    const a = ids[i], b = ids[j];
    compared++;
    const f = fe.sameness(a, b);
    const s = server.sameness(g, gen, a, b);
    if (!!f !== !!s){
      if (candMismatch.length < 5){
        candMismatch.push(`${st.people[a].name}/${st.people[b].name}: ` +
          `front ${f ? f.score.toFixed(3) : 'null'}, server ${s ? s.score.toFixed(3) : 'null'}`);
      }
      continue;
    }
    if (!f) continue;
    if (Math.abs(f.score - s.score) > 1e-9 && scoreMismatch.length < 5){
      scoreMismatch.push(`${st.people[a].name}/${st.people[b].name}: ` +
        `front ${f.score.toFixed(3)}, server ${s.score.toFixed(3)}`);
    }
    // Compared as booleans on purpose. The frontend builds `strong` as
    //   sharedMate.length > 0 || sharedKid.length > 0 || (pa && pb && pa.id === pb.id)
    // which yields `null` rather than `false` when a person has no recorded
    // parents. It is only ever read in a boolean context — `d.strong ||
    // d.score >= 0.75` — so null and false mean the same thing to every
    // caller. What must match is which pairs are treated as strong.
    if (!!f.strong !== !!s.strong && scoreMismatch.length < 5){
      scoreMismatch.push(`${st.people[a].name}/${st.people[b].name}: ` +
        `strong differs — front ${JSON.stringify(f.strong)}, server ${JSON.stringify(s.strong)}`);
    }
  }

  eq(`${label}: generation distances agree`, genMismatch, []);
  eq(`${label}: the same pairs are candidates`, candMismatch, []);
  eq(`${label}: every candidate scores identically`, scoreMismatch, []);
  check(`${label}: the comparison actually ran (${compared} pairs)`, compared > 0);
  return { st, g, gen };
}

(async () => {
  const fe = loadFrontend();
  const pool = await freshPool();

  section('the frontend’s own functions were lifted out of the shipped page');
  check('sameness() was found and is callable', typeof fe.sameness === 'function');
  eq('nameTokens agrees on a titled name',
     fe.nameTokens('Sekuru Baba Tapiwa'), server.nameTokens('Sekuru Baba Tapiwa'));
  eq('and on a name with a title at the end',
     fe.nameTokens('Garikai Baba'), server.nameTokens('Garikai Baba'));
  eq('and on a bound prefix',
     fe.nameTokens('VaMoyo'), server.nameTokens('VaMoyo'));
  eq('the threshold matches the frontend’s duplicatePairs() default',
     server.THRESHOLD, 0.5);

  // ── a four-generation family with three Garikais in one line ──────────
  section('three Garikais in one direct line');
  const t1 = await newTree(pool, 'parity-garikai');
  const r1 = await applyOps(pool, t1, [
    { op:'addPerson', ref:'$g1', name:'Garikai Moyo', sex:'m', born:'1920', totem:'Shumba' },
    { op:'addPerson', ref:'$gw', name:'Mbuya Rudo',   sex:'f', born:'1925' },
    { op:'addUnion', ref:'$u1' },
    { op:'addPartner', unionId:'$u1', personId:'$g1' },
    { op:'addPartner', unionId:'$u1', personId:'$gw' },
    { op:'addPerson', ref:'$dad', name:'Rufaro Moyo', sex:'m', born:'1950', totem:'Shumba' },
    { op:'addChild', unionId:'$u1', personId:'$dad' },
    { op:'addPerson', ref:'$mum', name:'Chipo Dube', sex:'f', born:'1955' },
    { op:'addUnion', ref:'$u2' },
    { op:'addPartner', unionId:'$u2', personId:'$dad' },
    { op:'addPartner', unionId:'$u2', personId:'$mum' },
    { op:'addPerson', ref:'$g2', name:'Garikai Moyo', sex:'m', born:'1980', totem:'Shumba' },
    { op:'addChild', unionId:'$u2', personId:'$g2' },
    { op:'addPerson', ref:'$w2', name:'Rutendo Ncube', sex:'f', born:'1982' },
    { op:'addUnion', ref:'$u3' },
    { op:'addPartner', unionId:'$u3', personId:'$g2' },
    { op:'addPartner', unionId:'$u3', personId:'$w2' },
    { op:'addPerson', ref:'$g3', name:'Sekuru Garikai Moyo', sex:'m', born:'2008', totem:'Shumba' },
    { op:'addChild', unionId:'$u3', personId:'$g3' },
    { op:'setRoot', personId:'$g1' }
  ], 'parity');
  await comparePair(fe, pool, t1, 'three Garikais');

  const scan1 = await server.findDuplicates(pool, t1);
  eq('the server flags nothing', scan1.pairs.length, 0);
  fe.setState(await asFrontendState(pool, t1));
  eq('and neither does the frontend', fe.duplicatePairs().length, 0);

  // ── a genuine duplicate: one wife entered twice ───────────────────────
  //
  // This is how it actually happens: two relatives each record Rufaro's
  // marriage from their own side, so the same woman ends up in two separate
  // unions rather than as a second partner in one. Adding her to the SAME
  // union would instead make the two records each other's spouse, and both
  // implementations then refuse to compare them at all — mustBeDifferent()
  // rules out anyone the tree already says is related.
  section('the same wife entered twice, once with a title');
  const d = await applyOps(pool, t1, [
    { op:'addPerson', ref:'$dup', name:'Mai Chipo Dube', sex:'f', born:'1955' },
    { op:'addUnion', ref:'$u2b' },
    { op:'addPartner', unionId:'$u2b', personId:r1.refs['$dad'] },
    { op:'addPartner', unionId:'$u2b', personId:'$dup' }
  ], 'parity');
  await comparePair(fe, pool, t1, 'with a duplicate present');

  const scan2 = await server.findDuplicates(pool, t1);
  fe.setState(await asFrontendState(pool, t1));
  const fePairs = fe.duplicatePairs();
  eq('both find the same number of candidates', scan2.pairs.length, fePairs.length);
  check('the duplicate is flagged', scan2.pairs.length >= 1,
        `server found ${scan2.pairs.length}, frontend ${fePairs.length}`);
  check('on the shared spouse, not the name',
        scan2.pairs[0].why.some(w => /both married to/.test(w)),
        JSON.stringify(scan2.pairs[0].why));
  eq('the top score is identical',
     scan2.pairs[0].score.toFixed(6), fePairs[0].score.toFixed(6));
  eq('and both call it a strong match',
     scan2.pairs[0].likely, fe.likelyDuplicates().length > 0);

  // ── a dismissal must suppress on both sides ───────────────────────────
  section('a dismissal suppresses the pair in both implementations');
  await applyOps(pool, t1, [{ op:'dismissDuplicate',
    aId: scan2.pairs[0].a.id, bId: scan2.pairs[0].b.id }], 'parity');
  const scan3 = await server.findDuplicates(pool, t1);
  fe.setState(await asFrontendState(pool, t1));
  eq('server no longer offers it', scan3.pairs.length, fePairs.length - 1);
  eq('frontend no longer offers it either', fe.duplicatePairs().length, fePairs.length - 1);

  // ── a wider, messier tree ─────────────────────────────────────────────
  section('a wider tree with remarriage, missing data and near-spellings');
  const t2 = await newTree(pool, 'parity-wide');
  await applyOps(pool, t2, [
    { op:'addPerson', ref:'$a', name:'Tafara Ncube', sex:'m', born:'1930' },
    { op:'addPerson', ref:'$b', name:'Rudo Ncube',   sex:'f', born:'1934' },
    { op:'addUnion', ref:'$u' },
    { op:'addPartner', unionId:'$u', personId:'$a' },
    { op:'addPartner', unionId:'$u', personId:'$b' },
    { op:'addPerson', ref:'$c', name:'Tendai Ncube', sex:'m', born:'1958' },
    { op:'addPerson', ref:'$d', name:'Tendayi Ncube', sex:'m', born:'1958' }, // near-spelling
    { op:'addPerson', ref:'$e', name:'Nyasha Ncube', sex:'f' },              // no birth year
    { op:'addChild', unionId:'$u', personId:'$c' },
    { op:'addChild', unionId:'$u', personId:'$d' },
    { op:'addChild', unionId:'$u', personId:'$e' },
    // a remarriage
    { op:'addPerson', ref:'$w1', name:'Chipo Moyo', sex:'f', born:'1960' },
    { op:'addUnion', ref:'$m1' },
    { op:'addPartner', unionId:'$m1', personId:'$c' },
    { op:'addPartner', unionId:'$m1', personId:'$w1' },
    { op:'addPerson', ref:'$w2', name:'Chipo Dube', sex:'f', born:'1966' },
    { op:'addUnion', ref:'$m2' },
    { op:'addPartner', unionId:'$m2', personId:'$c' },
    { op:'addPartner', unionId:'$m2', personId:'$w2' },
    // somebody unconnected, and a title-only record
    { op:'addPerson', ref:'$x', name:'Tendai Ncube', sex:'m' },
    { op:'addPerson', ref:'$y', name:'Baba', sex:'m' },
    { op:'addPerson', ref:'$z', name:'Baba', sex:'m' },
    { op:'setRoot', personId:'$a' }
  ], 'parity');
  await comparePair(fe, pool, t2, 'wider tree');

  const w = await server.findDuplicates(pool, t2);
  fe.setState(await asFrontendState(pool, t2));
  const fw = fe.duplicatePairs();
  eq('the same candidates survive the threshold', w.pairs.length, fw.length);
  eq('scores match pair for pair',
     w.pairs.map(p => p.score.toFixed(6)).sort(),
     fw.map(p => p.score.toFixed(6)).sort());

  section('two records the tree already says are related are never compared');
  const t3 = await newTree(pool, 'parity-related');
  const r3 = await applyOps(pool, t3, [
    { op:'addPerson', ref:'$h', name:'Rufaro Moyo', sex:'m' },
    { op:'addPerson', ref:'$w', name:'Chipo Dube', sex:'f' },
    { op:'addPerson', ref:'$w2', name:'Chipo Dube', sex:'f' },
    { op:'addUnion', ref:'$u' },
    { op:'addPartner', unionId:'$u', personId:'$h' },
    { op:'addPartner', unionId:'$u', personId:'$w' },
    { op:'addPartner', unionId:'$u', personId:'$w2' },   // same union: co-partners
    { op:'setRoot', personId:'$h' }
  ], 'parity');
  const g3 = await server.loadTree(pool, t3);
  fe.setState(await asFrontendState(pool, t3));
  eq('the frontend refuses to compare two partners in one union',
     fe.sameness(r3.refs['$w'], r3.refs['$w2']), null);
  eq('and so does the server',
     server.sameness(g3, server.generations(g3), r3.refs['$w'], r3.refs['$w2']), null);
  await comparePair(fe, pool, t3, 'co-partners');

  section('title-only records are never duplicate candidates');
  // Two people both recorded as "Baba" reduce to no tokens at all, so
  // nameSimilarity refuses to compare them — in both implementations.
  const babas = Object.values((await asFrontendState(pool, t2)).people)
    .filter(p => p.name === 'Baba').map(p => p.id);
  eq('there are two of them', babas.length, 2);
  eq('the frontend will not compare them', fe.sameness(babas[0], babas[1]), null);
  const g2 = await server.loadTree(pool, t2);
  eq('and neither will the server',
     server.sameness(g2, server.generations(g2), babas[0], babas[1]), null);
  check('but they are still findable by search',
     (await require('../db/reads').search(pool, t2, 'Baba')).results.length >= 2);

  await pool.end();
  report();
})().catch(e => { console.error('\nHARNESS ERROR:', e); process.exit(1); });
