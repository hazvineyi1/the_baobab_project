// Duplicate detection — a faithful port of the frontend's sameness().
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
// This is a PORT, not a reimplementation. The weights, the thresholds and the
// order they are applied in all come from sameness() in public/index.html, and
// test/parity.test.js runs both against the same trees and fails on any
// disagreement. If you change a number here, change it there, or the browser
// and the server will start giving the family different answers.

const WEIGHTS = {
  NAME_SAME:          0.34,  // identical once titles are set aside
  NAME_ALL_SHARED:    0.28,  // every token of the shorter name matched
  NAME_SOME_SHARED:   0.18,
  SAME_GENERATION:    0.08,
  GENERATION_APART:  -0.45,  // per generation, floored at -0.8 in total
  GENERATION_FLOOR:  -0.8,
  SHARED_SPOUSE:      0.5,
  DIFFERENT_SPOUSE:  -0.18,
  SHARED_CHILD:       0.5,
  DIFFERENT_CHILDREN:-0.12,
  SAME_PARENT_UNION:  0.4,
  DIFFERENT_PARENTS: -0.4,
  SAME_BIRTH_YEAR:    0.2,
  DIFFERENT_BIRTH:   -0.55,  // more than two years apart
  DIFFERENT_SEX:     -0.6,
  SAME_TOTEM:         0.12
};

// The cut-off duplicatePairs() uses in the frontend.
const THRESHOLD = Number(process.env.MW_DUPLICATE_THRESHOLD || 0.5);

// What the frontend surfaces as worth interrupting somebody over: a positional
// signal, or an overwhelming score. A name alone can never reach either.
const isLikely = d => d.strong || d.score >= 0.75;

const TITLES = new Set([
  'sekuru','tateguru','ambuya','mbuya','gogo','baba','babamukuru','babamunini',
  'amai','mai','mainini','maiguru','tete','vatete','mudhara','mukoma','muninina',
  'sisi','bhudhi','va','mr','mrs','ms','dr','the','late'
]);

// Mirrors mw_name_key() in migrations/003, which mirrors nameTokens() in the
// frontend. Kept here too so scoring never depends on a round trip.
//
// Memoised, along with nameSimilarity below. The browser can afford to redo
// this work — it holds one family and a person is watching. A server scanning
// thousands of records compares the same handful of distinct names over and
// over, and Levenshtein is the most expensive thing in the scan. Caching
// changes no result; it only stops the same answer being computed again.
const tokenCache = new Map();
const bounded = (cache, key, make) => {
  let hit = cache.get(key);
  if (hit !== undefined) return hit;
  hit = make();
  if (cache.size > 50000) cache.clear();
  cache.set(key, hit);
  return hit;
};

const rawTokens = name => String(name || '')
  .toLowerCase()
  .replace(/['’.]/g, '')
  .replace(/[^a-z0-9\s-]/g, ' ')
  .split(/[\s-]+/)
  .filter(t => t && !TITLES.has(t));

const nameTokens = name => bounded(tokenCache, String(name || ''), () => rawTokens(name));

function editDistance(a, b){
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++){
    const row = [i];
    for (let j = 1; j <= b.length; j++){
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1,
                        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

// Families spell by ear, so one or two letters of drift is the same name.
const closeEnough = (a, b) => {
  if (a === b) return true;
  // Both branches below need length >= 4 and allow at most 2 edits, so a pair
  // that fails on length or differs in length by more than 2 can never match.
  // Checking that first skips the Levenshtein table entirely for most pairs,
  // and cannot change any answer.
  if (a.length < 4 || b.length < 4) return false;
  if (Math.abs(a.length - b.length) > 2) return false;
  const d = editDistance(a, b);
  return d <= (Math.min(a.length, b.length) >= 7 ? 2 : 1);
};

const simCache = new Map();
function nameSimilarity(nameA, nameB){
  // Order-independent: comparing A to B gives the same verdict as B to A once
  // the shared-token list is the same, and the shorter-name test is symmetric.
  const key = String(nameA) < String(nameB)
    ? String(nameA) + '\u0000' + String(nameB)
    : String(nameB) + '\u0000' + String(nameA);
  return bounded(simCache, key, () => computeNameSimilarity(nameA, nameB));
}

function computeNameSimilarity(nameA, nameB){
  const ta = nameTokens(nameA), tb = nameTokens(nameB);
  if (!ta.length || !tb.length) return null;
  const shared = ta.filter(x => tb.some(y => closeEnough(x, y)));
  if (!shared.length) return null;
  if (ta.join(' ') === tb.join(' ')){
    return { score: WEIGHTS.NAME_SAME, why: 'same name once the title is set aside' };
  }
  if (shared.length >= Math.min(ta.length, tb.length)){
    return { score: WEIGHTS.NAME_ALL_SHARED, why: `both called ${shared.join(' ')}` };
  }
  return { score: WEIGHTS.NAME_SOME_SHARED, why: `share the name ${shared.join(' ')}` };
}

const birthYear = born => {
  const m = String(born || '').match(/\b(1[0-9]{3}|20[0-9]{2})\b/);
  return m ? Number(m[1]) : null;
};

// ---------------------------------------------------------------------------
// An in-memory view of one tree, so scoring never goes back to the database.

function buildGraph(rows){
  const { people, partnerRows, childRows } = rows;

  const unionPartners = new Map();   // unionId -> [personId]
  const unionChildren = new Map();
  const parentUnion = new Map();     // personId -> unionId
  const partnersOf = new Map();      // personId -> Set(personId)
  const childrenOf = new Map();      // personId -> Set(personId), via any union
  const unionsOf = new Map();        // personId -> [unionId]

  for (const r of partnerRows){
    if (!unionPartners.has(r.union_id)) unionPartners.set(r.union_id, []);
    unionPartners.get(r.union_id).push(r.person_id);
    if (!unionsOf.has(r.person_id)) unionsOf.set(r.person_id, []);
    unionsOf.get(r.person_id).push(r.union_id);
  }
  for (const r of childRows){
    if (!unionChildren.has(r.union_id)) unionChildren.set(r.union_id, []);
    unionChildren.get(r.union_id).push(r.person_id);
    parentUnion.set(r.person_id, r.union_id);
  }
  for (const [unionId, partners] of unionPartners){
    const kids = unionChildren.get(unionId) || [];
    for (const p of partners){
      if (!partnersOf.has(p)) partnersOf.set(p, new Set());
      if (!childrenOf.has(p)) childrenOf.set(p, new Set());
      for (const q of partners) if (q !== p) partnersOf.get(p).add(q);
      for (const k of kids) childrenOf.get(p).add(k);
    }
  }

  // Everyone above a person. Memoised: a scan asks for the same ancestors
  // repeatedly, and walking the tree per pair is what made this slow.
  const ancCache = new Map();
  function ancestorsOf(id){
    let hit = ancCache.get(id);
    if (hit) return hit;
    const up = new Set();
    let frontier = [id], guard = 0;
    while (frontier.length && guard++ < 200){
      const next = [];
      for (const cur of frontier){
        const u = parentUnion.get(cur);
        if (u === undefined) continue;
        for (const par of unionPartners.get(u) || []){
          if (up.has(par) || par === id) continue;
          up.add(par);
          next.push(par);
        }
      }
      frontier = next;
    }
    ancCache.set(id, up);
    return up;
  }

  return { people, unionPartners, unionChildren, parentUnion,
           partnersOf, childrenOf, unionsOf, ancestorsOf };
}

/* Generation numbers.
 *
 * DERIVED, NEVER STORED. Adding one person can shift what generation hundreds
 * of others sit in relative to each other, so this is computed fresh at the
 * start of each scan and thrown away — the same rule that keeps kinship terms
 * out of the database.
 *
 * This is the frontend's generations() step for step: breadth-first from the
 * recorded root, where a parent union's partners are one above, its other
 * children are level, a person's own spouses are level, and their children are
 * one below. Anyone the walk never reaches falls back to 0, exactly as the
 * frontend does — which matters, because it makes two unconnected records
 * count as the same generation rather than an arbitrary distance apart.
 */
function generations(g){
  const gen = {};
  const root = g.people.find(p => p.is_root);
  if (!root) { for (const p of g.people) gen[p.id] = 0; return gen; }

  const queue = [root.id];
  gen[root.id] = 0;
  const step = (other, n) => {
    if (other && gen[other] === undefined){ gen[other] = n; queue.push(other); }
  };
  while (queue.length){
    const id = queue.shift(), n = gen[id];
    const pu = g.parentUnion.get(id);
    if (pu !== undefined){
      (g.unionPartners.get(pu) || []).forEach(p => step(p, n - 1));
      (g.unionChildren.get(pu) || []).forEach(c => step(c, n));
    }
    for (const u of g.unionsOf.get(id) || []){
      (g.unionPartners.get(u) || []).forEach(p => step(p, n));
      (g.unionChildren.get(u) || []).forEach(c => step(c, n + 1));
    }
  }
  for (const p of g.people) if (gen[p.id] === undefined) gen[p.id] = 0;
  return gen;
}

// Two records cannot be one person if the tree already says they are related.
function mustBeDifferent(g, a, b){
  if (a === b) return true;
  if ((g.partnersOf.get(a) || new Set()).has(b)) return true;
  if (g.ancestorsOf(a).has(b)) return true;
  if (g.ancestorsOf(b).has(a)) return true;
  return false;
}

function sameness(g, gen, aId, bId){
  const a = g.byId.get(aId), b = g.byId.get(bId);
  if (!a || !b || mustBeDifferent(g, aId, bId)) return null;

  const nm = nameSimilarity(a.name, b.name);
  if (!nm) return null;

  const why = [nm.why];
  const against = [];
  let score = nm.score;

  // ── generation ────────────────────────────────────────────────────────
  if (gen[aId] !== undefined && gen[bId] !== undefined){
    const d = Math.abs(gen[aId] - gen[bId]);
    if (d === 0) score += WEIGHTS.SAME_GENERATION;
    else {
      score -= Math.min(-WEIGHTS.GENERATION_FLOOR, -WEIGHTS.GENERATION_APART * d);
      against.push(d === 1 ? 'one generation apart — more likely named after them'
                           : `${d} generations apart`);
    }
  }

  // ── who they are married to ───────────────────────────────────────────
  const mates = [...(g.partnersOf.get(aId) || [])];
  const theirs = g.partnersOf.get(bId) || new Set();
  const sharedMate = mates.filter(x => theirs.has(x));
  if (sharedMate.length){
    score += WEIGHTS.SHARED_SPOUSE;
    why.push(`both married to ${g.byId.get(sharedMate[0]).name}`);
  } else if (mates.length && theirs.size){
    score += WEIGHTS.DIFFERENT_SPOUSE;
    against.push('married to different people');
  }

  // ── whose children they are parents of ────────────────────────────────
  const kidsA = [...(g.childrenOf.get(aId) || [])];
  const kidsB = g.childrenOf.get(bId) || new Set();
  const sharedKid = kidsA.filter(k => kidsB.has(k));
  if (sharedKid.length){
    score += WEIGHTS.SHARED_CHILD;
    why.push(`both parents of ${g.byId.get(sharedKid[0]).name}`);
  } else if (kidsA.length && kidsB.size){
    score += WEIGHTS.DIFFERENT_CHILDREN;
    against.push('different children recorded');
  }

  // ── whose children they are ───────────────────────────────────────────
  const pa = g.parentUnion.get(aId), pb = g.parentUnion.get(bId);
  if (pa !== undefined && pb !== undefined){
    const setA = (g.unionPartners.get(pa) || []).slice().sort().join();
    const setB = (g.unionPartners.get(pb) || []).slice().sort().join();
    if (pa === pb){
      score += WEIGHTS.SAME_PARENT_UNION;
      why.push('listed twice among the same children');
    } else if (setA && setA === setB){
      score += WEIGHTS.SAME_PARENT_UNION;
      why.push('the same parents');
    } else {
      score += WEIGHTS.DIFFERENT_PARENTS;
      against.push('different parents recorded — if those two are also one person, merge them first');
    }
  }

  // ── the smaller corroborations ────────────────────────────────────────
  const ya = birthYear(a.born), yb = birthYear(b.born);
  if (ya && yb){
    if (ya === yb){ score += WEIGHTS.SAME_BIRTH_YEAR; why.push(`both born ${ya}`); }
    else if (Math.abs(ya - yb) > 2){
      score += WEIGHTS.DIFFERENT_BIRTH;
      against.push(`born ${ya} and ${yb}`);
    }
  }
  if (a.sex && b.sex && a.sex !== b.sex){
    score += WEIGHTS.DIFFERENT_SEX;
    against.push('recorded as different sexes');
  }
  if (a.totem && b.totem && a.totem.toLowerCase() === b.totem.toLowerCase()){
    score += WEIGHTS.SAME_TOTEM;
    why.push(`same totem, ${a.totem}`);
  }

  return {
    score: Math.max(0, Math.min(1, score)),
    why, against,
    // a name on its own never gets past "possible"
    strong: sharedMate.length > 0 || sharedKid.length > 0 || (pa !== undefined && pa === pb)
  };
}

module.exports = {
  WEIGHTS, THRESHOLD, TITLES, isLikely,
  nameTokens, editDistance, closeEnough, nameSimilarity, birthYear,
  buildGraph, generations, mustBeDifferent, sameness
};

// ---------------------------------------------------------------------------
// The scan.
//
// The frontend compares every person to every other one — O(n^2) — which is
// what made it stall inside render(). It can afford to: a browser tree is
// small and the user is looking at it. The server cannot, so it blocks
// candidates into buckets and only compares within them.
//
// Blocking never changes a SCORE, only which pairs get scored. Every pair a
// bucket produces is scored by the ported sameness() above and gets the same
// number the browser would give it. The two blocking keys are chosen so that
// nothing sameness() could have flagged is missed:
//
//   * the exact name_key, which catches "Garikai" against "Sekuru Garikai"
//   * a short prefix of it, which catches "Garikai" against "Garikayi" —
//     families spell by ear and the same person is entered both ways
//
// nameSimilarity() returns null unless two names share a token, so a pair with
// no shared token is not a candidate under either implementation.

const PREFIX_BLOCK = 4;

// A pathological block (a thousand names starting "chi") would put O(n^2) back
// in through the side door. Oversized prefix blocks are skipped; those people
// are still compared on their exact name key, where they belong.
const MAX_BUCKET = 300;

async function loadTree(pool, treeId){
  const [peopleR, partnersR, childrenR, dismissedR] = await Promise.all([
    pool.query(`SELECT id, name, name_key, sex, totem, born, born_year, is_root
                  FROM people WHERE tree_id = $1 AND aside_at IS NULL`, [treeId]),
    pool.query(`SELECT up.union_id, up.person_id FROM union_partners up
                  JOIN unions u ON u.id = up.union_id
                 WHERE u.tree_id = $1 ORDER BY up.position`, [treeId]),
    pool.query(`SELECT uc.union_id, uc.person_id FROM union_children uc
                  JOIN unions u ON u.id = uc.union_id
                 WHERE u.tree_id = $1 ORDER BY uc.birth_order`, [treeId]),
    pool.query(`SELECT a_id, b_id FROM not_duplicates WHERE tree_id = $1`, [treeId])
  ]);
  const g = buildGraph({
    people: peopleR.rows,
    partnerRows: partnersR.rows,
    childRows: childrenR.rows
  });
  g.byId = new Map(peopleR.rows.map(p => [p.id, p]));
  g.dismissed = new Set(dismissedR.rows.map(r => `${r.a_id}|${r.b_id}`));
  return g;
}

async function findDuplicates(pool, treeId, { threshold = THRESHOLD, limit = 200 } = {}) {
  const started = Date.now();
  const g = await loadTree(pool, treeId);
  const gen = generations(g);

  const exact = new Map(), prefix = new Map();
  for (const p of g.people){
    if (!p.name_key) continue;         // nothing but a title — never a candidate
    if (!exact.has(p.name_key)) exact.set(p.name_key, []);
    exact.get(p.name_key).push(p);
    const pk = p.name_key.slice(0, PREFIX_BLOCK);
    if (!prefix.has(pk)) prefix.set(pk, []);
    prefix.get(pk).push(p);
  }

  const seen = new Set();
  const hits = [];
  let comparisons = 0;

  const compare = bucket => {
    for (let i = 0; i < bucket.length; i++){
      for (let j = i + 1; j < bucket.length; j++){
        let a = bucket[i], b = bucket[j];
        // Canonical order, matching not_duplicates' CHECK (a_id < b_id), so a
        // dismissal recorded once suppresses the pair however it is reached.
        if (a.id > b.id) [a, b] = [b, a];
        const key = `${a.id}|${b.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (g.dismissed.has(key)) continue;
        comparisons++;
        const m = sameness(g, gen, a.id, b.id);
        if (m && m.score >= threshold) hits.push({ a, b, ...m });
      }
    }
  };

  for (const bucket of exact.values()) if (bucket.length > 1) compare(bucket);
  for (const bucket of prefix.values()){
    if (bucket.length > 1 && bucket.length <= MAX_BUCKET) compare(bucket);
  }

  hits.sort((x, y) => y.score - x.score);

  return {
    treeId,
    threshold,
    scanned: g.people.length,
    comparisons,
    ms: Date.now() - started,
    // What a naive all-pairs scan would have cost. Reported so a regression in
    // the blocking strategy shows up as a number rather than as "feels slow".
    naiveComparisons: (g.people.length * (g.people.length - 1)) / 2,
    likely: hits.filter(isLikely).length,
    pairs: hits.slice(0, limit).map(h => ({
      score: h.score,
      likely: isLikely(h),
      why: h.why,
      against: h.against,
      a: publicPerson(h.a),
      b: publicPerson(h.b)
    })),
    truncated: hits.length > limit
  };
}

const publicPerson = p => ({
  id: p.id, name: p.name, sex: p.sex, totem: p.totem,
  born: p.born, born_year: p.born_year
});

module.exports.findDuplicates = findDuplicates;
module.exports.loadTree = loadTree;
