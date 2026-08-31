// Read paths: bootstrap, incremental sync, search.
//
// The old client loaded the entire tree to show one corner of it. At a few
// hundred people that is merely wasteful; at five thousand it is the reason
// the app stops being usable. Everything here is scoped — to a neighbourhood,
// to what changed since last time, or to what was searched for.

const { badRequest, notFound } = require('./errors');

const PERSON_COLS = `id, name, also_known_as, sex, totem, born, born_year, died, is_root,
                     added_by, aside_at, aside_by, aside_why, merged_into,
                     visibility, visibility_by, visibility_at,
                     mw_is_living(died, born_year) AS is_living,
                     mw_is_public(visibility, died, born_year) AS is_public,
                     created_at, updated_at`;

// Set-aside people are out of the tree everybody sees. They are never deleted,
// so every read of the visible tree has to say so explicitly — a query that
// forgets this clause is how a folded duplicate reappears as a duplicate of
// the record it was folded into.
const PRESENT = 'aside_at IS NULL';

/* What the world may see. Written once and used by every public read, because
   a read that forgets this clause publishes a living person, and that is the
   one kind of bug that cannot be taken back. */
const PUBLIC = `${PRESENT} AND mw_is_public(visibility, died, born_year)`;

// Deliberately narrower than PERSON_COLS. A public reader gets what identifies
// an ancestor and nothing else: no note of who recorded them, no set-aside
// reason, no timestamps that would say when a family was working on them.
const PUBLIC_COLS = `id, name, sex, totem, born, born_year, died, is_root`;

// ---------------------------------------------------------------------------
// bootstrap: the neighbourhood around one person.
//
// Depth is counted in UNION hops, which is the unit that matches how people
// actually think about the tree: one hop reaches your parents, your partners,
// your children and your siblings (everyone sharing a union with you); two
// reaches grandparents, nieces and nephews; three reaches the great-
// grandparents and the wider generation that the Shona terms still name
// directly. Three is the default for that reason.
async function bootstrap(pool, treeId, { focus = null, depth = 3 } = {}) {
  const d = Math.max(0, Math.min(Number(depth) || 0, 8));

  const { rowCount } = await pool.query('SELECT 1 FROM trees WHERE id = $1', [treeId]);
  if (!rowCount) throw notFound(`tree ${treeId} does not exist`);

  // No focus given: start from the recorded root, else the earliest-born
  // person, else anyone. A first-time visitor gets the top of the tree.
  let focusId = focus;
  if (!focusId) {
    const { rows } = await pool.query(
      `SELECT id FROM people WHERE tree_id = $1 AND ${PRESENT}
        ORDER BY is_root DESC, born_year ASC NULLS LAST, created_at ASC LIMIT 1`, [treeId]);
    if (!rows.length) return emptyResult(treeId, await headSeq(pool, treeId));
    focusId = rows[0].id;
  }

  // One round trip. The recursion walks person -> unions they belong to ->
  // everyone else in those unions, which is the same bipartite structure the
  // kinship rules read.
  const { rows: reached } = await pool.query(`
    WITH RECURSIVE nb(person_id, depth) AS (
      SELECT $1::uuid, 0
      UNION
      SELECT other.person_id, nb.depth + 1
        FROM nb
        JOIN (SELECT person_id, union_id FROM union_partners
              UNION ALL
              SELECT person_id, union_id FROM union_children) mine
          ON mine.person_id = nb.person_id
        JOIN (SELECT person_id, union_id FROM union_partners
              UNION ALL
              SELECT person_id, union_id FROM union_children) other
          ON other.union_id = mine.union_id
        JOIN people op ON op.id = other.person_id AND op.aside_at IS NULL
       WHERE nb.depth < $2
    )
    SELECT person_id, min(depth) AS depth FROM nb GROUP BY person_id`,
    [focusId, d]);

  const ids = reached.map(r => r.person_id);
  if (!ids.length) {
    // A person with no links at all is still a valid tree of one.
    const { rows } = await pool.query(
      `SELECT ${PERSON_COLS} FROM people WHERE id = $1 AND tree_id = $2 AND ${PRESENT}`,
      [focusId, treeId]);
    return { ...emptyResult(treeId, await headSeq(pool, treeId)), focus: focusId,
             people: rows, depth: d };
  }

  const depthOf = Object.fromEntries(reached.map(r => [r.person_id, Number(r.depth)]));

  const [people, unions] = await Promise.all([
    pool.query(`SELECT ${PERSON_COLS} FROM people
                 WHERE tree_id = $1 AND id = ANY($2::uuid[]) AND ${PRESENT}`,
               [treeId, ids]),
    // Every union touching the neighbourhood, with partners and children in
    // order. Children are eldest-first: that order is the birth order the
    // seniority terms read, so it must survive the trip.
    pool.query(`
      SELECT u.id, u.updated_at,
             COALESCE((SELECT array_agg(up.person_id ORDER BY up.position)
                         FROM union_partners up WHERE up.union_id = u.id), '{}') AS partners,
             COALESCE((SELECT array_agg(uc.person_id ORDER BY uc.birth_order)
                         FROM union_children uc WHERE uc.union_id = u.id), '{}') AS children
        FROM unions u
       WHERE u.tree_id = $1
         AND u.id IN (
           SELECT union_id FROM union_partners WHERE person_id = ANY($2::uuid[])
           UNION
           SELECT union_id FROM union_children WHERE person_id = ANY($2::uuid[]))`,
      [treeId, ids])
  ]);

  const { rows: nd } = await pool.query(
    'SELECT a_id, b_id FROM not_duplicates WHERE tree_id = $1', [treeId]);
  // The whole lexicon travels with every bootstrap. It is a handful of rows,
  // and the client cannot name anything without it.
  const { rows: terms } = await pool.query(
    'SELECT shape, term, note, by, at FROM kin_terms WHERE tree_id = $1', [treeId]);
  const { rows: [{ total }] } = await pool.query(
    `SELECT count(*)::int AS total FROM people WHERE tree_id = $1 AND ${PRESENT}`, [treeId]);
  const { rows: rootRows } = await pool.query(
    `SELECT id FROM people WHERE tree_id = $1 AND is_root AND ${PRESENT} LIMIT 1`, [treeId]);

  return {
    treeId,
    focus: focusId,
    depth: d,
    seq: await headSeq(pool, treeId),
    rootId: rootRows.length ? rootRows[0].id : null,
    // How many people exist in total vs how many were sent, so the client can
    // tell the difference between "this is the whole family" and "this is the
    // part of it near you".
    total,
    people: people.rows.map(p => ({ ...p, depth: depthOf[p.id] })),
    unions: unions.rows,
    notDuplicates: nd.map(r => [r.a_id, r.b_id]),
    lexicon: Object.fromEntries(terms.map(t =>
      [t.shape, { term: t.term, note: t.note, by: t.by, at: t.at }]))
  };
}

const emptyResult = (treeId, seq) => ({
  treeId, focus: null, depth: 0, seq, rootId: null, total: 0,
  people: [], unions: [], notDuplicates: [], lexicon: {}
});

async function headSeq(pool, treeId) {
  const { rows } = await pool.query(
    'SELECT COALESCE(max(seq), 0)::bigint AS seq FROM changes WHERE tree_id = $1', [treeId]);
  return Number(rows[0].seq);
}

// ---------------------------------------------------------------------------
// changes: everything this client has not seen yet.
//
// Gapless per tree because writes hold the tree's advisory lock (see ops.js),
// so "give me everything after N" cannot skip a row that committed late.
async function changesSince(pool, treeId, since = 0, limit = 500) {
  const n = Math.max(0, Number(since) || 0);
  const cap = Math.max(1, Math.min(Number(limit) || 500, 2000));
  const { rows } = await pool.query(
    `SELECT seq, entity, entity_id, op, payload, at, by
       FROM changes WHERE tree_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
    [treeId, n, cap]);
  const head = await headSeq(pool, treeId);
  return {
    changes: rows.map(r => ({ ...r, seq: Number(r.seq) })),
    seq: rows.length ? Number(rows[rows.length - 1].seq) : n,
    head,
    // The client should come straight back rather than waiting for the next
    // poll interval, because there is more waiting for it.
    more: rows.length === cap
  };
}

// ---------------------------------------------------------------------------
// search
//
// Three living Garikais in one family is ordinary — children are named after
// grandparents. So a name alone is never enough to identify anyone, and every
// hit carries the family context needed to tell them apart: who their parents
// are, who they are married to, how many children they have, when they were
// born. That context is the actual product here; the matching is the easy part.
async function search(pool, treeId, q, { limit = 25 } = {}) {
  const raw = String(q || '').trim();
  if (!raw) return { query: '', results: [] };
  const cap = Math.max(1, Math.min(Number(limit) || 25, 100));

  // Match on the same normalised key the names are indexed by, so searching
  // "sekuru garikai" and "Garikai" both land on the same man.
  const { rows: [{ key }] } = await pool.query('SELECT mw_name_key($1) AS key', [raw]);
  const needle = key || raw.toLowerCase();

  const hasTrgm = await trigramAvailable(pool);

  // Prefix matches rank above fuzzy ones: someone typing "gari" almost always
  // wants Garikai, not Garai. similarity() only breaks ties below that.
  const sql = hasTrgm ? `
    SELECT ${PERSON_COLS},
           (name_key = $2) AS exact,
           (name_key LIKE $2 || '%') AS prefix,
           similarity(name_key, $2) AS score
      FROM people
     WHERE tree_id = $1
       AND ${PRESENT}
       AND (name_key LIKE $2 || '%' OR similarity(name_key, $2) > 0.3
            -- name_key is empty when a record is nothing but an honorific
            -- ("Baba"). Such a person is not a duplicate candidate, but they
            -- must still be findable, so fall back to the raw name.
            OR (name_key = '' AND lower(name) LIKE '%' || $2 || '%')
            -- THE OTHER NAME SHE ANSWERS TO. A woman recorded under her own
            -- house's surname is looked for under her husband's by everybody
            -- who met her after the wedding, and a search that cannot find
            -- her is a search that says she is not in the family.
            OR (also_known_as <> '' AND lower(also_known_as) LIKE '%' || $2 || '%'))
     ORDER BY exact DESC, prefix DESC, score DESC, born_year ASC NULLS LAST
     LIMIT $3` : `
    SELECT ${PERSON_COLS},
           (name_key = $2) AS exact,
           true AS prefix,
           0::real AS score
      FROM people
     WHERE tree_id = $1
       AND ${PRESENT}
       AND (name_key LIKE $2 || '%'
            OR (name_key = '' AND lower(name) LIKE '%' || $2 || '%'))
     ORDER BY exact DESC, born_year ASC NULLS LAST
     LIMIT $3`;

  const { rows } = await pool.query(sql, [treeId, needle, cap]);
  if (!rows.length) return { query: raw, key: needle, fuzzy: hasTrgm, results: [] };

  const context = await familyContext(pool, rows.map(r => r.id));
  return {
    query: raw,
    key: needle,
    fuzzy: hasTrgm,
    results: rows.map(r => ({ ...r, score: Number(r.score), ...context[r.id] }))
  };
}

// The details that distinguish two people with the same name. One query per
// relationship kind over the whole result set, not per hit.
async function familyContext(pool, ids) {
  if (!ids.length) return {};

  const [parents, partners, children] = await Promise.all([
    pool.query(`
      SELECT uc.person_id, p.name, p.sex
        FROM union_children uc
        JOIN union_partners up ON up.union_id = uc.union_id
        JOIN people p ON p.id = up.person_id
       WHERE uc.person_id = ANY($1::uuid[])
       ORDER BY up.position`, [ids]),
    pool.query(`
      SELECT mine.person_id, p.name, p.sex
        FROM union_partners mine
        JOIN union_partners other
          ON other.union_id = mine.union_id AND other.person_id <> mine.person_id
        JOIN people p ON p.id = other.person_id
       WHERE mine.person_id = ANY($1::uuid[])`, [ids]),
    pool.query(`
      SELECT up.person_id, count(uc.person_id)::int AS n
        FROM union_partners up
        LEFT JOIN union_children uc ON uc.union_id = up.union_id
       WHERE up.person_id = ANY($1::uuid[])
       GROUP BY up.person_id`, [ids])
  ]);

  const out = {};
  for (const id of ids) out[id] = { parents: [], partners: [], childCount: 0 };
  for (const r of parents.rows)  out[r.person_id].parents.push({ name: r.name, sex: r.sex });
  for (const r of partners.rows) out[r.person_id].partners.push({ name: r.name, sex: r.sex });
  for (const r of children.rows) out[r.person_id].childCount += r.n;

  // A one-line human summary — "child of Rufaro · married to Chipo" — so the
  // client can render a disambiguating line without knowing the shape.
  for (const id of ids) {
    const c = out[id];
    const bits = [];
    if (c.parents.length)  bits.push(`child of ${c.parents.map(p => p.name).join(' and ')}`);
    if (c.partners.length) bits.push(`married to ${c.partners.map(p => p.name).join(' and ')}`);
    if (c.childCount)      bits.push(`${c.childCount} ${c.childCount === 1 ? 'child' : 'children'}`);
    c.context = bits.join(' · ');
  }
  return out;
}

let trgmCache = null;
async function trigramAvailable(pool) {
  if (trgmCache !== null) return trgmCache;
  const { rowCount } = await pool.query(`SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`);
  trgmCache = rowCount > 0;
  return trgmCache;
}

/* The whole tree, in the shape the page holds it.
 
   bootstrap() sends a neighbourhood, which is the right answer for a tree with
   thousands of people in it and a reader who is looking at one corner. This
   sends everything, and exists because the page is an EDITOR: it derives
   kinship terms, generation numbers, duplicate candidates and the layout from
   the whole graph, and a partial graph gives quietly wrong answers rather than
   missing ones — a cousin who looks like a stranger because the linking
   ancestor was outside the neighbourhood.
 
   The seq is the point of it as much as the rows are. It is the position in
   the change log that this snapshot was taken at, so a client can ask "has
   anything happened since?" with one cheap query instead of re-reading. */
async function fullTree(pool, treeId) {
  const { rowCount } = await pool.query('SELECT 1 FROM trees WHERE id = $1', [treeId]);
  if (!rowCount) throw notFound(`tree ${treeId} does not exist`);

  // The seq is read FIRST, before the rows. A change committing between the
  // two would then be re-delivered by the next poll rather than missed — the
  // safe direction to be wrong in.
  const seq = await headSeq(pool, treeId);

  // Set-aside people ARE sent, with their state. They are not part of the
  // visible tree, but the page is where they are read and put back, and a
  // record you cannot see is a record you cannot recover. The page hides them
  // through its own single seam, the same way this module does with PRESENT.
  const [peopleR, unionsR, ndR, termsR, rootR] = await Promise.all([
    pool.query(`SELECT ${PERSON_COLS} FROM people
                 WHERE tree_id = $1 ORDER BY created_at`, [treeId]),
    pool.query(`
      SELECT u.id, u.updated_at,
             COALESCE((SELECT array_agg(up.person_id ORDER BY up.position)
                         FROM union_partners up WHERE up.union_id = u.id), '{}') AS partners,
             COALESCE((SELECT array_agg(uc.person_id ORDER BY uc.birth_order)
                         FROM union_children uc WHERE uc.union_id = u.id), '{}') AS children
        FROM unions u WHERE u.tree_id = $1 ORDER BY u.created_at`, [treeId]),
    pool.query('SELECT a_id, b_id FROM not_duplicates WHERE tree_id = $1', [treeId]),
    pool.query('SELECT shape, term, note, by, at FROM kin_terms WHERE tree_id = $1', [treeId]),
    pool.query(`SELECT id FROM people
                 WHERE tree_id = $1 AND is_root AND ${PRESENT}
                 ORDER BY created_at LIMIT 1`, [treeId])
  ]);

  // Union lists are sent whole. A set-aside person has not left their marriage
  // or stopped being their children's parent — filtering them out here would
  // destroy that link on the way to the page, and putting them back would not
  // put it back.
  const unions = unionsR.rows.map(u => ({
    id: u.id,
    updated_at: u.updated_at,
    partners: u.partners.slice(),
    children: u.children.slice()
  }));

  const lexicon = {};
  for (const t of termsR.rows) {
    lexicon[t.shape] = { term: t.term, note: t.note, by: t.by, at: t.at };
  }

  return {
    treeId, seq,
    people: peopleR.rows,
    unions,
    notDuplicates: ndR.rows.map(r => [r.a_id, r.b_id]),
    lexicon,
    rootId: rootR.rows.length ? rootR.rows[0].id : null,
    total: peopleR.rows.filter(p => !p.aside_at).length
  };
}

/* The tree as the world sees it.
 
   A separate function rather than a flag on fullTree, and that is deliberate.
   A boolean parameter on a read is one `if` away from serving the family's
   view to a stranger, and the mistake is silent. Two functions cannot be
   confused: this one has no way to return a private person.
 
   Union lists are filtered to people who are actually being sent, so the
   public graph never points at somebody it will not name. The shape of a
   family stays visible — you can see that a public ancestor had children —
   but a private living child is not there to be counted or inferred from. */
async function publicTree(pool, treeId) {
  const { rowCount } = await pool.query('SELECT 1 FROM trees WHERE id = $1', [treeId]);
  if (!rowCount) throw notFound(`tree ${treeId} does not exist`);

  const seq = await headSeq(pool, treeId);
  const { rows: people } = await pool.query(
    `SELECT ${PUBLIC_COLS} FROM people
      WHERE tree_id = $1 AND ${PUBLIC} ORDER BY created_at`, [treeId]);

  const here = new Set(people.map(p => p.id));
  const { rows: unionRows } = await pool.query(`
    SELECT u.id,
           COALESCE((SELECT array_agg(up.person_id ORDER BY up.position)
                       FROM union_partners up WHERE up.union_id = u.id), '{}') AS partners,
           COALESCE((SELECT array_agg(uc.person_id ORDER BY uc.birth_order)
                       FROM union_children uc WHERE uc.union_id = u.id), '{}') AS children
      FROM unions u WHERE u.tree_id = $1 ORDER BY u.created_at`, [treeId]);

  const unions = unionRows
    .map(u => ({ id: u.id,
                 partners: u.partners.filter(x => here.has(x)),
                 children: u.children.filter(x => here.has(x)) }))
    .filter(u => u.partners.length || u.children.length);

  return { treeId, seq, people, unions, total: people.length };
}

/* One ancestor, for a page anybody can link to. Returns null rather than
   throwing when the person is not public, so that "private" and "does not
   exist" are indistinguishable from outside — an error that said "this person
   exists but you may not see them" would confirm they exist. */
async function publicPerson(pool, personId) {
  const { rows } = await pool.query(
    `SELECT ${PUBLIC_COLS}, tree_id FROM people
      WHERE id = $1 AND ${PUBLIC}`, [personId]);
  if (!rows.length) return null;
  const person = rows[0];

  // Parents and children, public ones only.
  const [parents, children, partners] = await Promise.all([
    pool.query(`SELECT ${PUBLIC_COLS} FROM people p
                  JOIN union_partners up ON up.person_id = p.id
                  JOIN union_children uc ON uc.union_id = up.union_id
                 WHERE uc.person_id = $1 AND ${PUBLIC}`, [personId]),
    pool.query(`SELECT ${PUBLIC_COLS} FROM people p
                  JOIN union_children uc ON uc.person_id = p.id
                  JOIN union_partners up ON up.union_id = uc.union_id
                 WHERE up.person_id = $1 AND ${PUBLIC}
                 ORDER BY uc.birth_order`, [personId]),
    pool.query(`SELECT ${PUBLIC_COLS} FROM people p
                  JOIN union_partners a ON a.person_id = p.id
                  JOIN union_partners b ON b.union_id = a.union_id
                                       AND b.person_id <> a.person_id
                 WHERE b.person_id = $1 AND ${PUBLIC}`, [personId])
  ]);
  return { person, parents: parents.rows, children: children.rows,
           partners: partners.rows };
}

/* Who has been set aside, and — when `recordedBy` is given — which of them
   were entered by that person.

   This is the whole notification mechanism. There is no queue and no
   acknowledgement flag: a notice is the live fact "an entry of yours is
   currently set aside", read straight off the rows. It stops being shown when
   it stops being true — because the record was restored, or because the
   person who entered it agreed and left it aside. A stored "seen" flag would
   be a second copy of that truth, free to disagree with the first. */
async function setAsideList(pool, treeId, { recordedBy } = {}) {
  const args = [treeId];
  let filter = '';
  if (recordedBy !== undefined && recordedBy !== null) {
    args.push(recordedBy);
    filter = ` AND p.added_by = $${args.length}`;
  }
  const { rows } = await pool.query(`
    SELECT p.id, p.name, p.born, p.died, p.added_by,
           p.aside_at, p.aside_by, p.aside_why, p.merged_into,
           m.name AS merged_into_name
      FROM people p
      LEFT JOIN people m ON m.id = p.merged_into
     WHERE p.tree_id = $1 AND p.aside_at IS NOT NULL${filter}
     ORDER BY p.aside_at DESC`, args);
  return {
    treeId,
    recordedBy: recordedBy ?? null,
    total: rows.length,
    people: rows.map(r => ({
      id: r.id, name: r.name, born: r.born, died: r.died,
      addedBy: r.added_by,
      asideAt: r.aside_at, asideBy: r.aside_by, asideWhy: r.aside_why,
      mergedInto: r.merged_into, mergedIntoName: r.merged_into_name
    }))
  };
}

module.exports = { bootstrap, fullTree, publicTree, publicPerson, changesSince,
                   search, headSeq, familyContext, trigramAvailable, setAsideList };
