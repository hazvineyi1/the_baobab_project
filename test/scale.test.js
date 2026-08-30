// Scale.
//
// Seeds 5,000 people across 10 generations and measures the three calls that
// have to stay fast as a family fills the tree in. Targets come from the brief:
// bootstrap under 200 ms, search under 100 ms, the duplicate scan in seconds
// rather than minutes.
//
// Times are medians over repeated runs against a warm cache — which is the
// state a live server is actually in. Set MW_SCALE_PEOPLE to change the size.

const { check, eq, section, freshPool, report } = require('./helpers');
const { seed } = require('../scripts/seed');
const { bootstrap, search, changesSince } = require('../db/reads');
const { findDuplicates } = require('../db/duplicates');
const { applyOps } = require('../db/ops');

const TARGET_PEOPLE = Number(process.env.MW_SCALE_PEOPLE || 5000);
const GENERATIONS = 10;

async function median(fn, runs = 20) {
  await fn(); await fn();                       // warm
  const ts = [];
  for (let i = 0; i < runs; i++) {
    const t = process.hrtime.bigint();
    await fn();
    ts.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  ts.sort((a, b) => a - b);
  return { med: ts[Math.floor(runs / 2)], p95: ts[Math.floor(runs * 0.95)], max: ts[runs - 1] };
}

const under = (label, t, limit) =>
  check(`${label} — ${t.med.toFixed(1)} ms median, ${t.p95.toFixed(1)} ms p95 (limit ${limit} ms)`,
        t.med < limit, t.med >= limit ? `TOO SLOW: ${t.med.toFixed(1)} ms` : '');

(async () => {
  const pool = await freshPool();

  section(`seeding ${TARGET_PEOPLE} people across ${GENERATIONS} generations`);
  const t0 = Date.now();
  const s = await seed(pool, { people: TARGET_PEOPLE, generations: GENERATIONS });
  console.log(`  seeded in ${Date.now() - t0} ms: ${s.people} people, ${s.unions} unions, ` +
              `${s.partners} partnerships, ${s.children} child links, ${s.generations} generations`);
  await pool.query('ANALYZE');
  const tree = s.treeId;

  check(`the tree really holds ${TARGET_PEOPLE} people`, s.people >= TARGET_PEOPLE,
        `got ${s.people}`);
  check(`and really is ${GENERATIONS} generations deep`, s.generations >= GENERATIONS,
        `got ${s.generations}`);

  const { rows: sample } = await pool.query(
    'SELECT id FROM people WHERE tree_id=$1 ORDER BY random() LIMIT 50', [tree]);
  let i = 0;
  const nextId = () => sample[i++ % sample.length].id;
  const { rows: [root] } = await pool.query(
    'SELECT id FROM people WHERE tree_id=$1 AND is_root', [tree]);

  section('bootstrap stays fast (target: under 200 ms)');
  under('depth=1', await median(() => bootstrap(pool, tree, { focus: nextId(), depth: 1 })), 200);
  under('depth=2', await median(() => bootstrap(pool, tree, { focus: nextId(), depth: 2 })), 200);
  under('depth=3', await median(() => bootstrap(pool, tree, { focus: nextId(), depth: 3 })), 200);
  under('depth=3 from the root (densest neighbourhood)',
        await median(() => bootstrap(pool, tree, { focus: root.id, depth: 3 })), 200);
  under('depth=4', await median(() => bootstrap(pool, tree, { focus: nextId(), depth: 4 })), 200);

  const b = await bootstrap(pool, tree, { focus: nextId(), depth: 3 });
  check(`depth=3 sends a slice, not the tree — ${b.people.length} of ${b.total} people`,
        b.people.length < b.total / 2);

  section('search stays fast (target: under 100 ms)');
  under("prefix 'gari'",       await median(() => search(pool, tree, 'gari')), 100);
  under("full name 'Garikai'", await median(() => search(pool, tree, 'Garikai')), 100);
  under("with honorific 'Sekuru Garikai'",
        await median(() => search(pool, tree, 'Sekuru Garikai')), 100);
  under("misspelling 'Garikayi'", await median(() => search(pool, tree, 'Garikayi')), 100);
  under("single letter 'a' (worst case)", await median(() => search(pool, tree, 'a')), 100);

  section('the duplicate scan finishes in seconds, not minutes');
  const scans = [];
  for (let k = 0; k < 3; k++) scans.push(await findDuplicates(pool, tree));
  const times = scans.map(x => x.ms).sort((a, b) => a - b);
  const d = scans[0];
  console.log(`  ${d.scanned} people, ${d.comparisons.toLocaleString()} comparisons ` +
              `(naive would be ${d.naiveComparisons.toLocaleString()})`);
  check(`scan completes in ${(times[1] / 1000).toFixed(2)} s (limit 30 s)`, times[1] < 30_000);
  check(`bucketing avoids the quadratic scan — ` +
        `${(d.naiveComparisons / Math.max(1, d.comparisons)).toFixed(0)}x fewer comparisons`,
        d.comparisons < d.naiveComparisons / 5);

  section('writes stay fast on a large tree');
  under('a single-op batch', await median(() =>
    applyOps(pool, tree, [{ op: 'addPerson', name: 'Load Test' }], 'scale'), 10), 200);
  under('changes since=0', await median(() => changesSince(pool, tree, 0)), 200);

  section('the guarantees still hold at this size');
  eq('nobody has two sets of parents',
     (await pool.query(`SELECT count(*)::int n FROM
        (SELECT person_id FROM union_children GROUP BY person_id HAVING count(*)>1) x`)).rows[0].n, 0);
  eq('no union has two children claiming the same birth order',
     (await pool.query(`SELECT count(*)::int n FROM
        (SELECT union_id, birth_order FROM union_children
          GROUP BY union_id, birth_order HAVING count(*)>1) x`)).rows[0].n, 0);
  check('remarriage is represented — some people are partners in several unions',
     (await pool.query(`SELECT count(*)::int n FROM
        (SELECT person_id FROM union_partners GROUP BY person_id HAVING count(*)>1) x`)).rows[0].n > 0);
  check('single-partner unions exist and are legitimate',
     (await pool.query(`SELECT count(*)::int n FROM
        (SELECT union_id FROM union_partners GROUP BY union_id HAVING count(*)=1) x`)).rows[0].n > 0);

  await pool.end();
  report();
})().catch(e => { console.error('\nHARNESS ERROR:', e); process.exit(1); });
