// Duplicate detection.
//
// READ THIS BEFORE CHANGING A NUMBER IN HERE.
//
// The thing that makes this hard is cultural, not technical. Shona children
// are named after their grandparents, so three living Garikais in one family
// is completely ordinary. Having the same name is NOT evidence of being the
// same person. What identifies a duplicate is family POSITION: two records
// married to the same man, or with the same child, or recorded as children of
// the same couple.
//
// So the name can only ever open the question. It is capped low on purpose,
// and every strong signal in the scoring is positional. Two records that are a
// generation apart are pushed hard towards "different people" no matter how
// identically they are spelled — because that is the grandfather-and-grandson
// case, and it is the common one.
//
// The weights below are ported unchanged from the frontend's sameness(). They
// are not tuning parameters. Do not adjust them to make a particular pair come
// out the way you expect.

const WEIGHTS = {
  SHARED_SPOUSE:     0.5,   // married to the same person
  SHARED_CHILD:      0.5,   // recorded as parent of the same child
  SAME_PARENT_UNION: 0.4,   // both recorded as children of the same couple
  GENERATION_APART: -0.45,  // per generation of separation
  DIFFERENT_PARENTS:-0.4,   // each has parents, and they are different people
  DIFFERENT_SEX:    -0.6,
  NAME_CAP:          0.34   // the most a name can ever contribute
};

// UNCONFIRMED — the frontend's sameness() threshold was not available when
// this was written, so this is a placeholder chosen to satisfy the behaviour
// that IS specified: a name alone (max 0.34) must never flag a pair, while a
// shared spouse (0.5) or a shared parent union (0.4) plus a matching name
// must. Anything in (0.34, 0.74] does that. Replace with the real constant.
const THRESHOLD = Number(process.env.MW_DUPLICATE_THRESHOLD || 0.5);

// Blocking. Comparing every person to every other is O(n^2) — at 3,000 people
// that is 4.5 million comparisons, which is what made the old client stall
// inside render(). Instead, candidates are grouped into small buckets and only
// compared within a bucket, which is O(n*k) for average bucket size k.
//
// Two blocking keys, because one is not enough:
//   * the exact name_key, which catches "Garikai" vs "Sekuru Garikai"
//   * a short prefix of it, which catches "Garikai" vs "Garikayi" — families
//     spell by ear and the same person genuinely gets entered both ways
const PREFIX_BLOCK = 4;

// A pathological bucket (a thousand people whose names all start "chi") would
// put O(n^2) back in through the side door. Buckets past this size are still
// compared on the exact-name key, where they belong, but their prefix block is
// skipped rather than allowed to dominate the scan.
const MAX_BUCKET = 300;

// ---------------------------------------------------------------------------
// Generation numbers.
//
// DERIVED, NEVER STORED. Adding one person can shift what generation hundreds
// of others sit in relative to each other, so this is computed fresh at the
// start of each scan and thrown away afterwards — the same rule that keeps
// kinship terms out of the database.
//
// Computed per connected component by relative position: parent -> child is
// +1, and two partners are by definition the same generation. That last edge
// matters: a woman who married in has no recorded parents, so counting only
// downward from roots would place her at generation 0 and score her as five
// generations from her own husband.
function generations({ people, parentUnion, unionPartners, unionChildren }) {
  const gen = new Map();

  // Adjacency: person -> [{ id, delta }]
  const adj = new Map();
  const link = (a, b, delta) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push({ id: b, delta });
  };

  for (const [unionId, partners] of unionPartners) {
    for (let i = 0; i < partners.length; i++) {
      for (let j = i + 1; j < partners.length; j++) {
        link(partners[i], partners[j], 0);
        link(partners[j], partners[i], 0);
      }
    }
    const kids = unionChildren.get(unionId) || [];
    for (const kid of kids) {
      for (const p of partners) { link(p, kid, 1); link(kid, p, -1); }
    }
  }
  // Siblings sit in the same generation even when no parent is recorded.
  for (const [, kids] of unionChildren) {
    for (let i = 0; i < kids.length; i++) {
      for (let j = i + 1; j < kids.length; j++) {
        link(kids[i], kids[j], 0);
        link(kids[j], kids[i], 0);
      }
    }
  }

  for (const person of people) {
    if (gen.has(person.id)) continue;
    gen.set(person.id, 0);
    const queue = [person.id];
    while (queue.length) {
      const cur = queue.shift();
      for (const edge of adj.get(cur) || []) {
        if (gen.has(edge.id)) continue;
        gen.set(edge.id, gen.get(cur) + edge.delta);
        queue.push(edge.id);
      }
    }
  }
  return gen;
}

// Dice coefficient over character bigrams. Deterministic and dependency-free,
// so scoring does not change depending on whether pg_trgm happens to be
// installed on the host.
//
// Bigram maps are memoised: a scan compares each name against many others, and
// there are only as many distinct name_keys as there are distinct names.
const gramCache = new Map();
function bigrams(s) {
  let g = gramCache.get(s);
  if (g) return g;
  g = { map: new Map(), total: 0 };
  for (let i = 0; i < s.length - 1; i++) {
    const k = s.slice(i, i + 2);
    g.map.set(k, (g.map.get(k) || 0) + 1);
    g.total++;
  }
  // Bounded so a long-running process cannot grow this without limit.
  if (gramCache.size > 20000) gramCache.clear();
  gramCache.set(s, g);
  return g;
}

function nameSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ga = bigrams(a), gb = bigrams(b);
  if (!ga.total || !gb.total) return 0;
  // Iterate the smaller map.
  const [small, large] = ga.map.size <= gb.map.size ? [ga, gb] : [gb, ga];
  let shared = 0;
  for (const [k, n] of small.map) {
    const m = large.map.get(k);
    if (m) shared += n < m ? n : m;
  }
  return (2 * shared) / (ga.total + gb.total);
}

function score(a, b, ctx, identicalNames = false) {
  const { parentUnion, partnersOf, childrenOf, gen } = ctx;
  let s = 0;
  const why = [];

  // The name opens the question and nothing more.
  //
  // NOTE: "capped at 0.34" is read literally as min(similarity, 0.34) rather
  // than as a scaling factor. In practice the two readings almost never
  // differ, because blocking means most compared pairs have identical keys.
  const sim = identicalNames ? 1 : nameSimilarity(a.name_key, b.name_key);
  if (sim > 0) {
    const contribution = Math.min(sim, WEIGHTS.NAME_CAP);
    s += contribution;
    why.push({ signal: 'name', value: +contribution.toFixed(3) });
  }

  // Married to the same person.
  const spousesA = partnersOf.get(a.id) || new Set();
  const spousesB = partnersOf.get(b.id) || new Set();
  const sharedSpouse = [...spousesA].some(x => x !== b.id && spousesB.has(x));
  if (sharedSpouse) { s += WEIGHTS.SHARED_SPOUSE; why.push({ signal: 'shared spouse', value: WEIGHTS.SHARED_SPOUSE }); }

  // Recorded as parent of the same child.
  const kidsA = childrenOf.get(a.id) || new Set();
  const kidsB = childrenOf.get(b.id) || new Set();
  const sharedChild = [...kidsA].some(x => kidsB.has(x));
  if (sharedChild) { s += WEIGHTS.SHARED_CHILD; why.push({ signal: 'shared child', value: WEIGHTS.SHARED_CHILD }); }

  // Parents.
  const pa = parentUnion.get(a.id), pb = parentUnion.get(b.id);
  if (pa && pb && pa === pb) {
    s += WEIGHTS.SAME_PARENT_UNION;
    why.push({ signal: 'same parents', value: WEIGHTS.SAME_PARENT_UNION });
  } else if (pa && pb) {
    s += WEIGHTS.DIFFERENT_PARENTS;
    why.push({ signal: 'different parents', value: WEIGHTS.DIFFERENT_PARENTS });
  }

  // Generation. This is the signal that keeps a grandfather and the grandson
  // named after him apart, and it is meant to be decisive.
  const ga = gen.get(a.id), gb = gen.get(b.id);
  if (ga != null && gb != null) {
    const apart = Math.abs(ga - gb);
    if (apart) {
      const penalty = WEIGHTS.GENERATION_APART * apart;
      s += penalty;
      why.push({ signal: `${apart} generation${apart > 1 ? 's' : ''} apart`, value: +penalty.toFixed(3) });
    }
  }

  // '' means "not recorded", which is not a disagreement.
  if (a.sex && b.sex && a.sex !== b.sex) {
    s += WEIGHTS.DIFFERENT_SEX;
    why.push({ signal: 'different sex', value: WEIGHTS.DIFFERENT_SEX });
  }

  return { score: +s.toFixed(3), why };
}

// ---------------------------------------------------------------------------

async function findDuplicates(pool, treeId, { threshold = THRESHOLD, limit = 200 } = {}) {
  const started = Date.now();

  const [peopleR, partnersR, childrenR, dismissedR] = await Promise.all([
    pool.query(`SELECT id, name, name_key, sex, born_year FROM people WHERE tree_id = $1`, [treeId]),
    pool.query(`SELECT union_id, person_id FROM union_partners up
                 WHERE EXISTS (SELECT 1 FROM unions u WHERE u.id = up.union_id AND u.tree_id = $1)
                 ORDER BY position`, [treeId]),
    pool.query(`SELECT union_id, person_id FROM union_children uc
                 WHERE EXISTS (SELECT 1 FROM unions u WHERE u.id = uc.union_id AND u.tree_id = $1)
                 ORDER BY birth_order`, [treeId]),
    pool.query(`SELECT a_id, b_id FROM not_duplicates WHERE tree_id = $1`, [treeId])
  ]);

  const people = peopleR.rows;
  const byId = new Map(people.map(p => [p.id, p]));

  const unionPartners = new Map();
  for (const r of partnersR.rows) {
    if (!unionPartners.has(r.union_id)) unionPartners.set(r.union_id, []);
    unionPartners.get(r.union_id).push(r.person_id);
  }
  const unionChildren = new Map();
  const parentUnion = new Map();
  for (const r of childrenR.rows) {
    if (!unionChildren.has(r.union_id)) unionChildren.set(r.union_id, []);
    unionChildren.get(r.union_id).push(r.person_id);
    parentUnion.set(r.person_id, r.union_id);
  }

  // person -> the people they are partnered with, and the children they have.
  const partnersOf = new Map(), childrenOf = new Map();
  for (const [unionId, partners] of unionPartners) {
    for (const p of partners) {
      if (!partnersOf.has(p)) partnersOf.set(p, new Set());
      for (const q of partners) if (q !== p) partnersOf.get(p).add(q);
      if (!childrenOf.has(p)) childrenOf.set(p, new Set());
      for (const kid of unionChildren.get(unionId) || []) childrenOf.get(p).add(kid);
    }
  }

  const dismissed = new Set(dismissedR.rows.map(r => `${r.a_id}|${r.b_id}`));
  const gen = generations({ people, parentUnion, unionPartners, unionChildren });
  const ctx = { parentUnion, partnersOf, childrenOf, gen };

  // Bucket, then score only within buckets.
  const exact = new Map(), prefix = new Map();
  for (const p of people) {
    if (!p.name_key) continue;
    if (!exact.has(p.name_key)) exact.set(p.name_key, []);
    exact.get(p.name_key).push(p);
    const pk = p.name_key.slice(0, PREFIX_BLOCK);
    if (!prefix.has(pk)) prefix.set(pk, []);
    prefix.get(pk).push(p);
  }

  const seen = new Set();
  const hits = [];
  let comparisons = 0;

  const compare = (bucket, identicalNames = false) => {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        let a = bucket[i], b = bucket[j];
        // Canonical order, matching not_duplicates' CHECK (a_id < b_id), so a
        // dismissal recorded once suppresses the pair however it is reached.
        if (a.id > b.id) [a, b] = [b, a];
        const key = `${a.id}|${b.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (dismissed.has(key)) continue;
        comparisons++;
        const { score: s, why } = score(a, b, ctx, identicalNames);
        if (s >= threshold) hits.push({ a, b, score: s, why });
      }
    }
  };

  // Within an exact-name bucket every name_key is identical by construction,
  // so similarity is 1 and does not need computing.
  for (const bucket of exact.values()) if (bucket.length > 1) compare(bucket, true);
  for (const bucket of prefix.values()) {
    if (bucket.length > 1 && bucket.length <= MAX_BUCKET) compare(bucket);
  }

  hits.sort((x, y) => y.score - x.score);

  return {
    treeId,
    threshold,
    scanned: people.length,
    comparisons,
    ms: Date.now() - started,
    // A worst-case O(n^2) scan would need this many. Reported so a regression
    // in the blocking strategy is visible rather than merely slow.
    naiveComparisons: (people.length * (people.length - 1)) / 2,
    pairs: hits.slice(0, limit).map(h => ({
      score: h.score,
      why: h.why,
      a: publicPerson(byId.get(h.a.id)),
      b: publicPerson(byId.get(h.b.id))
    })),
    truncated: hits.length > limit
  };
}

const publicPerson = p => ({
  id: p.id, name: p.name, sex: p.sex, born_year: p.born_year
});

module.exports = { findDuplicates, nameSimilarity, generations, WEIGHTS, THRESHOLD };
