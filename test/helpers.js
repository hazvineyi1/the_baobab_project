// Minimal test harness. No framework — the app has two runtime dependencies
// and it is worth keeping it that way.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createPool } = require('../db/pool');
const { migrate } = require('../db/migrate');

const TEST_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

let passed = 0, failed = 0;
const failures = [];

function check(label, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok    ${label}`); }
  else { failed++; failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`); }
  return cond;
}

const eq = (label, actual, expected) =>
  check(label, JSON.stringify(actual) === JSON.stringify(expected),
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

// Assert that a call fails, and how.
async function rejects(label, fn, { status, code } = {}) {
  try {
    await fn();
    return check(label, false, 'expected a rejection, but it succeeded');
  } catch (e) {
    if (status && e.status !== status) return check(label, false, `expected status ${status}, got ${e.status ?? '(none)'}: ${e.message}`);
    if (code && e.code !== code) return check(label, false, `expected code ${code}, got ${e.code ?? '(none)'}: ${e.message}`);
    return check(label, true);
  }
}

function section(name) { console.log(`\n${name}`); }

async function freshPool() {
  if (!TEST_URL) {
    console.error('TEST_DATABASE_URL (or DATABASE_URL) must be set to run the tests.');
    process.exit(2);
  }
  const pool = createPool(TEST_URL);
  await migrate(pool, () => {});
  return pool;
}

async function newTree(pool, name = 'test') {
  const { rows } = await pool.query('INSERT INTO trees (name) VALUES ($1) RETURNING id', [name]);
  return rows[0].id;
}

function report() {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('failures:'); failures.forEach(f => console.log(`  - ${f}`)); }
  process.exit(failed ? 1 : 0);
}

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
    // The page reads the family key out of the address; under test there is
    // no address, so this is what it reads instead.
    location: { protocol:'https:', origin:'https://example.test',
                pathname:'/', hash:'', reload(){} },
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
      relationship, kinTerms, kinPath, overlaps, grow, addPerson, addUnion,
      teachTerm, forgetTerm, affirmTerm, lexicon, shapeLabel, kinVerdict,
      frontier, isOpenEnd, descendantsOf, toggleRoot,
      parentageOptions, parentageOf, setParentage, unionForShare, unionsOf, reorder,
      olderThan, seniorityConflicts, birthYear,
      setAside, restore, noticesFor, asidePeople, present, mergePeople, meName,
      knownTotem, totemKey, totemsHere, totemSuggestions, MITUPO,
      PALETTES, THEMES,
      diffOps, remapId, familyLink,
      setMe(id){ meId = id; },
      setState(s){ state = s; }, getState(){ return state; }
    };`, sandbox);
  if (typeof sandbox.api.sameness !== 'function'){
    throw new Error('the frontend script did not expose sameness()');
  }
  return sandbox.api;
}


module.exports = { check, eq, rejects, section, freshPool, newTree, report, loadFrontend };
