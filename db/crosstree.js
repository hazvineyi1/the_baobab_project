// Where two families meet.
//
// Within one tree, two records are the same person mostly because of WHO THEY
// ARE ATTACHED TO: the same spouse, the same children, the same parent union.
// Those signals are ids, and ids do not survive the trip between trees. Two
// families recording the same grandfather share no identifier at all — they
// share names, a totem, a birth year, and the names of the people around him.
//
// So this is a different scorer, not the within-tree one pointed sideways, and
// the weights below are reasoned from that difference rather than copied.
// db/duplicates.js keeps its own weights, unchanged.
//
// THE ASYMMETRY THAT SETS THE THRESHOLD. Inside one family, a false match
// costs a moment: somebody looks, says "no, that is my uncle's boy", dismisses
// it. Across families it says two unrelated households descend from one man —
// a claim about lineage, which in a system where lineage carries totem and
// marriage rules is not a small thing to be wrong about. So the bar is higher
// than the within-tree 0.5, and a name alone can never come close to it.

const { nameTokens, nameSimilarity, birthYear } = require('./duplicates');

const WEIGHTS = {
  // Necessary, nowhere near sufficient. Children are named after their
  // grandparents, so "Garikai Moyo" appears in half the trees in a district.
  NAME_SAME:            0.26,
  NAME_CLOSE:           0.14,

  // Mutupo is inherited down the male line and is the single best cross-family
  // discriminator available — it is precisely what Zimbabweans use themselves
  // when working out whether two people are of one house. It is weighted
  // higher than any other single signal here for that reason.
  TOTEM_SAME:           0.30,
  // And a different totem is close to a refusal. Two people of different
  // mutupo are not the same person; the usual causes of a mismatch are one
  // side leaving it blank (scored as unknown, not as different) or one side
  // recording a mother's totem by mistake — rare enough to be worth flagging
  // against, not rare enough to disqualify outright.
  TOTEM_DIFFERENT:     -0.55,

  SAME_BIRTH_YEAR:      0.26,
  NEAR_BIRTH_YEAR:      0.12,   // within three years — memory is approximate
  DIFFERENT_BIRTH:     -0.55,   // more than eight apart

  // The names around a person are the real evidence. If your Rufaro's father
  // was Chenjerai and ours was too, that is two families independently
  // recording the same man's father — far stronger than the name itself.
  PARENT_NAME_MATCH:    0.34,
  CHILD_NAME_MATCH:     0.28,
  SPOUSE_NAME_MATCH:    0.30,

  // Recorded as dead in one tree at a date the other contradicts.
  DEATH_CONFLICT:      -0.45
};

const THRESHOLD = Number(process.env.MW_CROSS_TREE_THRESHOLD || 0.62);

// How many same-name records one bucket may hold before it is skipped. A name
// shared by hundreds of people across the country carries no information, and
// scoring every pair of them is how this becomes quadratic.
const MAX_BUCKET = 200;

// Cap on how many surrounding-name agreements can stack, so a large family
// cannot reach the threshold on relatives alone.
const MAX_RELATIVE_HITS = 2;

/* Everything about one person that can be compared across trees. Deliberately
   thin: this is also exactly what another family gets to see. */
function contextOf(row, ctx) {
  return {
    id: row.id,
    treeId: row.tree_id,
    name: row.name,
    nameKey: row.name_key,
    sex: row.sex || '',
    totem: (row.totem || '').trim().toLowerCase(),
    born: row.born || '',
    bornYear: row.born_year != null ? Number(row.born_year) : birthYear(row.born),
    died: row.died || '',
    diedYear: birthYear(row.died),
    parents: ctx.parents.get(row.id) || [],
    children: ctx.children.get(row.id) || [],
    partners: ctx.partners.get(row.id) || []
  };
}

/* Do these two names describe one person?
 
   Whole-string similarity is not enough, and the reason is the ordinary case
   rather than an edge one: one family records a married woman as "Nyarai
   Moyo", her own people record her as "Nyarai". Every token of the shorter
   name appearing in the longer is the same woman — the within-tree scorer has
   always treated it that way, and it matters more here, because across trees
   the names of the surrounding people are most of the evidence there is. */
function sameName(x, y) {
  if (!x || !y) return false;
  if (x === y) return true;
  if (nameSimilarity(x, y) >= 0.85) return true;
  const xs = nameTokens(x), ys = nameTokens(y);
  if (!xs.length || !ys.length) return false;
  const [short, long] = xs.length <= ys.length ? [xs, ys] : [ys, xs];
  // A single shared token is not a name in common — half the district shares
  // a surname. Two names only match this way when everything the shorter one
  // says is also said by the longer.
  return short.every(t => long.some(u => t === u || nameSimilarity(t, u) >= 0.88));
}

// Do any two of these name lists describe the same person? Compared on
// name_key, because "Sekuru Chenjerai" and "Chenjerai" are one man.
function nameOverlap(a, b) {
  let hits = 0;
  const used = new Set();
  for (const x of a) {
    for (let i = 0; i < b.length; i++) {
      if (used.has(i)) continue;
      if (sameName(x, b[i])) { hits++; used.add(i); break; }
    }
  }
  return hits;
}

/* Two records from different trees: are they the same person?
   Returns null when they cannot be, otherwise a score and its reasons. */
function match(a, b) {
  // A person is not the other sex. This is a refusal, not a penalty: names are
  // gendered loosely in Shona and this is one of the few hard facts available.
  if (a.sex && b.sex && a.sex !== b.sex) return null;

  const why = [], against = [];
  let score = 0;

  // ---- the name ----
  if (a.nameKey && a.nameKey === b.nameKey) {
    score += WEIGHTS.NAME_SAME;
    why.push(`both recorded as ${a.name === b.name ? a.name : `${a.name} / ${b.name}`}`);
  } else if (nameSimilarity(a.nameKey, b.nameKey) >= 0.85) {
    score += WEIGHTS.NAME_CLOSE;
    why.push(`${a.name} and ${b.name} are nearly the same name`);
  } else {
    // Not in the same bucket by name and nothing else can carry it.
    return null;
  }

  // ---- mutupo ----
  if (a.totem && b.totem) {
    if (a.totem === b.totem) {
      score += WEIGHTS.TOTEM_SAME;
      why.push(`same totem — ${a.totem}`);
    } else {
      score += WEIGHTS.TOTEM_DIFFERENT;
      against.push(`different totem — ${a.totem} and ${b.totem}`);
    }
  }

  // ---- when they were born ----
  if (a.bornYear && b.bornYear) {
    const gap = Math.abs(a.bornYear - b.bornYear);
    if (gap === 0) { score += WEIGHTS.SAME_BIRTH_YEAR; why.push(`both born ${a.bornYear}`); }
    else if (gap <= 3) { score += WEIGHTS.NEAR_BIRTH_YEAR; why.push(`born ${gap} year${gap === 1 ? '' : 's'} apart`); }
    else if (gap > 8) { score += WEIGHTS.DIFFERENT_BIRTH; against.push(`born ${gap} years apart`); }
  }

  if (a.diedYear && b.diedYear && Math.abs(a.diedYear - b.diedYear) > 5) {
    score += WEIGHTS.DEATH_CONFLICT;
    against.push(`recorded as dying ${Math.abs(a.diedYear - b.diedYear)} years apart`);
  }

  // ---- the people around them ----
  const par = Math.min(nameOverlap(a.parents, b.parents), MAX_RELATIVE_HITS);
  if (par) {
    score += par * WEIGHTS.PARENT_NAME_MATCH;
    why.push(par === 1 ? 'a parent recorded under the same name in both'
                       : 'both parents recorded under the same names in both');
  }
  const kid = Math.min(nameOverlap(a.children, b.children), MAX_RELATIVE_HITS);
  if (kid) {
    score += kid * WEIGHTS.CHILD_NAME_MATCH;
    why.push(kid === 1 ? 'a child recorded under the same name in both'
                       : `${kid} children recorded under the same names in both`);
  }
  const sp = Math.min(nameOverlap(a.partners, b.partners), 1);
  if (sp) { score += WEIGHTS.SPOUSE_NAME_MATCH; why.push('married to the same name in both'); }

  score = Math.max(0, Math.min(1, score));

  // A name and a totem and nothing else is two people of one house with one
  // name, which is the ordinary case rather than a discovery. Something about
  // the people around them, or their dates, has to agree.
  const positional = par + kid + sp > 0;
  const dated = a.bornYear && b.bornYear && Math.abs(a.bornYear - b.bornYear) <= 3;
  if (!positional && !dated) return null;

  return { score: Number(score.toFixed(3)), why, against, positional };
}

// ---------------------------------------------------------------------------

async function loadContext(pool, ids) {
  const parents = new Map(), children = new Map(), partners = new Map();
  if (!ids.length) return { parents, children, partners };

  const push = (m, k, v) => { if (!v) return; const a = m.get(k) || []; a.push(v); m.set(k, a); };

  // The name_key of each parent, child and partner. Names, not ids — ids mean
  // nothing on the other side of a tree boundary.
  const [par, kid, sp] = await Promise.all([
    pool.query(`
      SELECT uc.person_id AS who, pp.name_key AS name
        FROM union_children uc
        JOIN union_partners up ON up.union_id = uc.union_id
        JOIN people pp ON pp.id = up.person_id AND pp.aside_at IS NULL
       WHERE uc.person_id = ANY($1::uuid[])`, [ids]),
    pool.query(`
      SELECT up.person_id AS who, cp.name_key AS name
        FROM union_partners up
        JOIN union_children uc ON uc.union_id = up.union_id
        JOIN people cp ON cp.id = uc.person_id AND cp.aside_at IS NULL
       WHERE up.person_id = ANY($1::uuid[])`, [ids]),
    pool.query(`
      SELECT a.person_id AS who, op.name_key AS name
        FROM union_partners a
        JOIN union_partners b ON b.union_id = a.union_id AND b.person_id <> a.person_id
        JOIN people op ON op.id = b.person_id AND op.aside_at IS NULL
       WHERE a.person_id = ANY($1::uuid[])`, [ids])
  ]);
  for (const r of par.rows) push(parents, r.who, r.name);
  for (const r of kid.rows) push(children, r.who, r.name);
  for (const r of sp.rows)  push(partners, r.who, r.name);
  return { parents, children, partners };
}

/* Candidate shared ancestors between one tree and every other tree that is
   willing to be compared against.

   Bucketed on name_key, which is why it is O(n·k) rather than O(n²): a person
   is only ever compared with people who are already recorded under the same
   name somewhere else. */
async function findRelatives(pool, treeId, { threshold, limit = 50 } = {}) {
  const cut = threshold ?? THRESHOLD;

  const { rows: [tree] } = await pool.query(
    'SELECT id, name, shares_frontier FROM trees WHERE id = $1', [treeId]);
  if (!tree) return { treeId, matches: [], compared: 0, shared: false };
  if (!tree.shares_frontier) {
    return { treeId, matches: [], compared: 0, shared: false,
             note: 'This family has asked not to be compared with others.' };
  }

  const { rows: mine } = await pool.query(
    `SELECT id, tree_id, name, name_key, sex, totem, born, born_year, died
       FROM people WHERE tree_id = $1 AND aside_at IS NULL AND name_key <> ''`, [treeId]);
  if (!mine.length) return { treeId, matches: [], compared: 0, shared: true };

  const keys = [...new Set(mine.map(p => p.name_key))];

  // Everybody in any other sharing tree who is already recorded under one of
  // those names. One query, served by people (name_key).
  const { rows: theirs } = await pool.query(
    `SELECT p.id, p.tree_id, p.name, p.name_key, p.sex, p.totem, p.born, p.born_year, p.died,
            t.name AS tree_name
       FROM people p
       JOIN trees t ON t.id = p.tree_id
      WHERE p.name_key = ANY($1::text[])
        AND p.tree_id <> $2
        AND p.aside_at IS NULL
        AND t.shares_frontier`, [keys, treeId]);

  if (!theirs.length) return { treeId, matches: [], compared: 0, shared: true };

  // Decisions already made about these pairs. A rejected pair must not come
  // back every time somebody looks — that throws away the work of judging it.
  const { rows: decided } = await pool.query(
    `SELECT a_person, b_person, status FROM tree_links
      WHERE a_tree = $1 OR b_tree = $1`, [treeId]);
  const already = new Map();
  for (const d of decided) already.set([d.a_person, d.b_person].sort().join('|'), d.status);

  const ctx = await loadContext(pool, [...mine.map(p => p.id), ...theirs.map(p => p.id)]);

  const byKey = new Map();
  for (const p of theirs) {
    const a = byKey.get(p.name_key) || [];
    a.push(p);
    byKey.set(p.name_key, a);
  }

  const out = [];
  let compared = 0;
  for (const row of mine) {
    const bucket = byKey.get(row.name_key);
    if (!bucket || bucket.length > MAX_BUCKET) continue;
    const a = contextOf(row, ctx);
    for (const other of bucket) {
      const pairKey = [row.id, other.id].sort().join('|');
      if (already.has(pairKey)) continue;
      compared++;
      const m = match(a, contextOf(other, ctx));
      if (!m || m.score < cut) continue;
      out.push({
        score: m.score, why: m.why, against: m.against,
        mine:   { id: row.id, name: row.name, born: row.born, totem: row.totem },
        theirs: { id: other.id, name: other.name, born: other.born, totem: other.totem,
                  treeId: other.tree_id, treeName: other.tree_name }
      });
    }
  }

  out.sort((x, y) => y.score - x.score);
  return { treeId, shared: true, compared, threshold: cut,
           matches: out.slice(0, limit), total: out.length };
}

/* Links already decided on, for display. */
async function linksFor(pool, treeId, status = null) {
  const args = [treeId];
  let filter = '';
  if (status) { args.push(status); filter = ` AND l.status = $${args.length}`; }
  const { rows } = await pool.query(`
    SELECT l.id, l.status, l.score, l.why, l.proposed_by, l.proposed_at,
           l.decided_by, l.decided_at,
           l.a_person, l.b_person, l.a_tree, l.b_tree,
           pa.name AS a_name, pa.born AS a_born,
           pb.name AS b_name, pb.born AS b_born,
           ta.name AS a_tree_name, tb.name AS b_tree_name
      FROM tree_links l
      JOIN people pa ON pa.id = l.a_person
      JOIN people pb ON pb.id = l.b_person
      JOIN trees  ta ON ta.id = l.a_tree
      JOIN trees  tb ON tb.id = l.b_tree
     WHERE (l.a_tree = $1 OR l.b_tree = $1)${filter}
     ORDER BY l.proposed_at DESC`, args);

  // Presented from the asking tree's side, so "yours" always means yours.
  return rows.map(r => {
    const iAmA = r.a_tree === treeId;
    return {
      id: r.id, status: r.status, score: r.score, why: r.why,
      proposedBy: r.proposed_by, proposedAt: r.proposed_at,
      decidedBy: r.decided_by, decidedAt: r.decided_at,
      mine:   iAmA ? { id:r.a_person, name:r.a_name, born:r.a_born }
                   : { id:r.b_person, name:r.b_name, born:r.b_born },
      theirs: iAmA ? { id:r.b_person, name:r.b_name, born:r.b_born,
                       treeId:r.b_tree, treeName:r.b_tree_name }
                   : { id:r.a_person, name:r.a_name, born:r.a_born,
                       treeId:r.a_tree, treeName:r.a_tree_name }
    };
  });
}

module.exports = { WEIGHTS, THRESHOLD, MAX_BUCKET, match, findRelatives, linksFor,
                   nameOverlap, sameName, contextOf, loadContext };
