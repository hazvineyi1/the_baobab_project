#!/usr/bin/env node
// Seeds a realistically-shaped tree for scale testing.
//
//   node scripts/seed.js --people 5000 --generations 10
//
// "Realistic" matters more than "large" here. A tree that is uniformly wide
// would not exercise what the real one does, so this reproduces the shapes
// that actually cost something:
//
//   * Names drawn from a small pool, because Shona children are named after
//     grandparents — which is exactly why three living Garikais in one family
//     is ordinary and why the duplicate scan cannot just match on names.
//   * Some remarriages, so people hold more than one union.
//   * Some single-parent unions (spouse unknown) and childless couples.
//   * Missing birth years on roughly one person in six, because families do
//     not know them and the app must not pretend otherwise.

const { createPool } = require('../db/pool');
const { migrate } = require('../db/migrate');

const GIVEN_M = ['Garikai','Tendai','Farai','Tapiwa','Tinashe','Munashe','Takudzwa',
                 'Simba','Kudakwashe','Panashe','Anesu','Tafara','Rufaro','Blessing'];
const GIVEN_F = ['Chipo','Rudo','Nyasha','Shamiso','Tsitsi','Rutendo','Kudzai',
                 'Vimbai','Chiedza','Fadzai','Ropafadzo','Nomatter','Tariro','Anesu'];
const TOTEMS  = ['Shumba','Moyo','Soko','Nzou','Shava','Gushungo','Mhofu','Hungwe'];
const SURNAME = ['Moyo','Ncube','Dube','Sibanda','Chirwa','Mutasa','Nyathi','Marufu'];

// How many people each generation should hold. Geometric growth, because
// that is what a family does: each generation is somewhat larger than the one
// above it. Solved by bisection rather than guessed, so that asking for 5,000
// people across 10 generations actually produces 10 generations.
function generationQuotas(target, G) {
  const total = r => {
    if (Math.abs(r - 1) < 1e-9) return G;
    return (Math.pow(r, G) - 1) / (r - 1);
  };
  let lo = 1.0, hi = 4.0;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (total(mid) * 2 < target) lo = mid; else hi = mid;
  }
  const r = (lo + hi) / 2;
  const first = target / total(r);
  return Array.from({ length: G }, (_, g) => Math.max(2, Math.round(first * Math.pow(r, g))));
}

// Deterministic PRNG, so a slow run can be reproduced exactly.
function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

async function seed(pool, { people: target = 5000, generations = 10, seed: sd = 42 } = {}) {
  const rand = rng(sd);
  const pick = a => a[Math.floor(rand() * a.length)];

  const { rows: [tree] } = await pool.query(
    'INSERT INTO trees (name) VALUES ($1) RETURNING id', [`Seeded ${target}`]);
  const treeId = tree.id;

  const peopleRows = [];   // [id, name, sex, totem, born, added_by]
  const unionRows = [];    // ids
  const partnerRows = [];  // [union, person, position]
  const childRows = [];    // [union, person, order]

  const uuid = () => require('crypto').randomUUID();
  const born = gen => {
    // Roughly 25 years a generation, and about one in six unknown.
    if (rand() < 0.16) return '';
    return String(1780 + gen * 25 + Math.floor(rand() * 18));
  };
  const mkPerson = (sex, gen) => {
    const id = uuid();
    const name = `${sex === 'm' ? pick(GIVEN_M) : pick(GIVEN_F)} ${pick(SURNAME)}`;
    peopleRows.push([id, name, sex, pick(TOTEMS), born(gen), 'seed']);
    return id;
  };

  // Generation 0: the founding couple.
  let current = [];
  const founderM = mkPerson('m', 0), founderF = mkPerson('f', 0);
  {
    const u = uuid(); unionRows.push(u);
    partnerRows.push([u, founderM, 0], [u, founderF, 1]);
    current = [{ id: founderM, sex: 'm', gen: 0, unionId: u }];
  }

  // Size each generation geometrically so the tree actually reaches the
  // requested depth instead of spending its whole budget on generation two.
  // Solve for the ratio r where quota_1*(r^G - 1)/(r - 1) == target.
  const quotas = generationQuotas(target, generations);

  let gen = 0;
  let deepest = current;
  for (gen = 1; gen <= generations && peopleRows.length < target; gen++) {
    const next = [];
    let quota = Math.min(quotas[gen - 1], target - peopleRows.length);
    if (!current.length) break;

    // Shuffle so it is not always the first couples that have large families.
    const couples = current.slice().sort(() => rand() - 0.5);
    let ci = 0;
    while (quota > 0 && ci < couples.length) {
      const parent = couples[ci++];
      // Real family sizes, not a uniform fan-out.
      const kids = Math.min(quota, 1 + Math.floor(rand() * 7));
      for (let k = 0; k < kids; k++) {
        const sex = rand() < 0.5 ? 'm' : 'f';
        const child = mkPerson(sex, gen);
        childRows.push([parent.unionId, child, k]);
        quota--;

        if (gen < generations && rand() < 0.82 && peopleRows.length < target) {
          const spouse = mkPerson(sex === 'm' ? 'f' : 'm', gen);
          quota--;
          const u = uuid(); unionRows.push(u);
          partnerRows.push([u, child, 0], [u, spouse, 1]);
          next.push({ id: child, sex, gen, unionId: u });

          if (rand() < 0.07 && peopleRows.length < target) {   // remarriage
            const second = mkPerson(sex === 'm' ? 'f' : 'm', gen);
            quota--;
            const u2 = uuid(); unionRows.push(u2);
            partnerRows.push([u2, child, 0], [u2, second, 1]);
            next.push({ id: child, sex, gen, unionId: u2 });
          }
        } else if (gen < generations && rand() < 0.4) {
          // A parent whose spouse was never recorded: a union with exactly
          // one partner. A legitimate state, not a broken record.
          const u = uuid(); unionRows.push(u);
          partnerRows.push([u, child, 0]);
          next.push({ id: child, sex, gen, unionId: u });
        }
      }
    }
    if (!next.length) break;
    current = next;
    deepest = next;
  }
  gen = Math.min(gen - 1, generations);

  // Top up to the requested size. Generation quotas are geometric estimates,
  // and family sizes are random, so the loop above lands near the target
  // rather than on it. The remainder goes to the deepest couples, which is
  // also where a real tree is densest — the living generation is the one
  // people actually finish recording.
  let ci2 = 0;
  while (peopleRows.length < target && deepest.length) {
    const parent = deepest[ci2++ % deepest.length];
    const existing = childRows.filter(c => c[0] === parent.unionId).length;
    const sex = rand() < 0.5 ? 'm' : 'f';
    const child = mkPerson(sex, gen);
    childRows.push([parent.unionId, child, existing]);
  }

  await bulkInsert(pool, treeId, { peopleRows, unionRows, partnerRows, childRows });
  await pool.query('UPDATE people SET is_root = true WHERE id = $1', [founderM]);

  // Report the depth actually achieved, measured from the root, rather than
  // the loop counter — the top-up pass can add a level.
  const { rows: [{ depth }] } = await pool.query(`
    WITH RECURSIVE d AS (
      SELECT id, 0 AS g FROM people WHERE tree_id = $1 AND is_root
      UNION ALL
      SELECT uc.person_id, d.g + 1 FROM d
        JOIN union_partners up ON up.person_id = d.id
        JOIN union_children uc ON uc.union_id = up.union_id
       WHERE d.g < 40)
    SELECT COALESCE(max(g), 0) AS depth FROM d`, [treeId]);

  return {
    treeId, generations: Number(depth),
    people: peopleRows.length, unions: unionRows.length,
    partners: partnerRows.length, children: childRows.length
  };
}

// COPY-style multi-row inserts. Chunked to stay under the 65535 bind-parameter
// limit the wire protocol imposes.
async function bulkInsert(pool, treeId, { peopleRows, unionRows, partnerRows, childRows }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await chunked(client, peopleRows, 6,
      'INSERT INTO people (id, name, sex, totem, born, added_by, tree_id) VALUES ', treeId);
    await chunked(client, unionRows.map(u => [u]), 1,
      'INSERT INTO unions (id, tree_id) VALUES ', treeId);
    await chunked(client, partnerRows, 3,
      'INSERT INTO union_partners (union_id, person_id, position) VALUES ', null);
    await chunked(client, childRows, 3,
      'INSERT INTO union_children (union_id, person_id, birth_order) VALUES ', null);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK'); throw e;
  } finally { client.release(); }
}

async function chunked(client, rows, width, prefix, treeId) {
  const cols = width + (treeId ? 1 : 0);
  const perChunk = Math.floor(60000 / cols);
  for (let i = 0; i < rows.length; i += perChunk) {
    const slice = rows.slice(i, i + perChunk);
    const vals = [];
    const tuples = slice.map(r => {
      const full = treeId ? [...r, treeId] : r;
      const ph = full.map(v => { vals.push(v); return `$${vals.length}`; });
      return `(${ph.join(',')})`;
    });
    await client.query(prefix + tuples.join(','), vals);
  }
}

module.exports = { seed };

if (require.main === module) {
  const arg = (n, d) => {
    const i = process.argv.indexOf('--' + n);
    return i > -1 ? Number(process.argv[i + 1]) : d;
  };
  (async () => {
    const pool = createPool();
    if (!pool) { console.error('DATABASE_URL is not set'); process.exit(2); }
    await migrate(pool);
    const t0 = Date.now();
    const r = await seed(pool, { people: arg('people', 5000), generations: arg('generations', 10) });
    console.log(`Seeded in ${Date.now() - t0} ms:`);
    console.log(`  tree        ${r.treeId}`);
    console.log(`  people      ${r.people}`);
    console.log(`  unions      ${r.unions}`);
    console.log(`  partnerships${String(r.partners).padStart(6)}`);
    console.log(`  child links ${String(r.children).padStart(6)}`);
    console.log(`  generations ${String(r.generations).padStart(6)}`);
    await pool.end();
  })().catch(e => { console.error(e); process.exit(1); });
}
