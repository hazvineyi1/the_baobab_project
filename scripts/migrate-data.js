#!/usr/bin/env node
// Moves the family tree out of the single-JSON-blob kv_store row and into the
// relational tables.
//
//   node scripts/migrate-data.js                  # inspect, change nothing
//   node scripts/migrate-data.js --apply
//   node scripts/migrate-data.js --apply --key family-tree-people
//
// Properties this must have, because it runs once against irreplaceable data
// that a family has typed in by hand:
//
//   * It backs the blob up BEFORE touching anything.
//   * It runs in ONE transaction. A failure leaves the database exactly as it
//     was, with the blob still authoritative.
//   * It is re-runnable. People and unions are upserted on their old ids
//     (people.legacy_id), so running twice produces the same tree rather than
//     a second copy of it.
//   * It verifies. Counts on both sides must agree, and it fails loudly rather
//     than reporting a success it has not checked.
//   * It refuses to run over later edits unless forced, so a second run cannot
//     silently discard work done after the first.
//
// TWO SOURCE SHAPES.
//
// The shape described by the current frontend:
//   { people: { id: {id,name,sex:'m'|'f'|'',totem,born,died,root} },
//     unions: { id: {id, partners:[], children:[]} },
//     rootId, seq, notDuplicates: [[a,b]] }
//
// And the older shape that the deployed app actually wrote, where the union
// is implicit in each person's parent pointers:
//   { people: { id: {id,name,sex:'M'|'F',totem,fatherId,motherId,spouseId,
//                    order,addedBy} }, nextId }
//
// Both are handled. Which one is present is detected, not assumed.

const { createPool } = require('../db/pool');
const { migrate } = require('../db/migrate');

const DEFAULT_KEYS = ['muti-baobab-v1', 'family-tree-people'];

// ---------------------------------------------------------------------------

function detectShape(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const people = parsed.people;
  if (!people || typeof people !== 'object') return null;
  if (parsed.unions && typeof parsed.unions === 'object') return 'baobab';
  const first = Object.values(people)[0];
  if (!first) return 'baobab';                       // empty tree, either way
  if ('fatherId' in first || 'motherId' in first || 'spouseId' in first) return 'legacy';
  return 'baobab';
}

const normSex = s => (s === 'm' || s === 'f') ? s
                   : (s === 'M') ? 'm' : (s === 'F') ? 'f' : '';

// Convert either shape into the same intermediate form: a list of people and a
// list of unions with ordered partners and ordered children.
function normalise(parsed, shape) {
  if (shape === 'baobab') return normaliseBaobab(parsed);
  return normaliseLegacy(parsed);
}

function normaliseBaobab(parsed) {
  const people = Object.values(parsed.people || {}).map(p => ({
    legacyId: String(p.id),
    name: p.name ?? '',
    sex: normSex(p.sex),
    totem: p.totem ?? '',
    born: p.born ?? '',
    died: p.died ?? '',
    addedBy: p.addedBy ?? '',
    isRoot: !!p.root || String(p.id) === String(parsed.rootId ?? '')
  }));

  const unions = Object.values(parsed.unions || {}).map(u => ({
    legacyId: String(u.id),
    partners: (u.partners || []).map(String),
    children: (u.children || []).map(String)   // already eldest-first
  }));

  return {
    people, unions,
    notDuplicates: (parsed.notDuplicates || []).map(pair => pair.map(String)),
    // Words the family taught the app. Losing these would mean asking a
    // relative the same question twice, which is exactly what recording them
    // was meant to prevent.
    lexicon: parsed.lexicon && typeof parsed.lexicon === 'object' ? parsed.lexicon : {},
    rootId: parsed.rootId != null ? String(parsed.rootId) : null
  };
}

// The old shape stores parentage on the child, so unions have to be inferred.
function normaliseLegacy(parsed) {
  const src = parsed.people || {};
  const rows = Object.values(src);

  const people = rows.map(p => ({
    legacyId: String(p.id),
    name: p.name ?? '',
    sex: normSex(p.sex),
    totem: p.totem ?? '',
    born: p.born ?? '',
    died: p.died ?? '',
    addedBy: p.addedBy ?? '',
    isRoot: false
  }));

  // One union per distinct parent pair. A person with only a father recorded
  // still gets a union — with one partner, which is a legitimate state, not a
  // broken record.
  const unions = new Map();
  const unionKey = (f, m) => `pair:${f || ''}+${m || ''}`;

  for (const p of rows) {
    const f = p.fatherId ? String(p.fatherId) : null;
    const m = p.motherId ? String(p.motherId) : null;
    if (!f && !m) continue;
    const key = unionKey(f, m);
    if (!unions.has(key)) {
      unions.set(key, { legacyId: key, partners: [f, m].filter(Boolean), children: [] });
    }
    unions.get(key).children.push({ id: String(p.id), order: Number(p.order) || 0 });
  }

  // Birth order: the old data's `order` is a sort key that can repeat or have
  // gaps. Sort by it and re-index densely, preserving the recorded sequence.
  for (const u of unions.values()) {
    u.children.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    u.children = u.children.map(c => c.id);
  }

  // Marriages with no recorded children have no union yet. spouseId is
  // mutual in the old data, so each couple is seen twice — dedupe on the
  // sorted pair.
  const seenCouple = new Set();
  for (const p of rows) {
    if (!p.spouseId) continue;
    const a = String(p.id), b = String(p.spouseId);
    if (!src[b]) continue;                       // dangling pointer, skip
    const pair = [a, b].sort();
    const coupleKey = `couple:${pair[0]}+${pair[1]}`;
    if (seenCouple.has(coupleKey)) continue;
    seenCouple.add(coupleKey);

    // If these two are already partners in a union inferred from children,
    // that is the same marriage — do not create a second one.
    const already = [...unions.values()].some(u =>
      u.partners.length === 2 && u.partners.includes(a) && u.partners.includes(b));
    if (already) continue;

    // Keep the father-first ordering the old shape implied.
    const partners = normSex(src[a].sex) === 'f' ? [b, a] : [a, b];
    unions.set(coupleKey, { legacyId: coupleKey, partners, children: [] });
  }

  return {
    people,
    unions: [...unions.values()],
    // The old shape had neither a dismissal list nor a lexicon. Nothing to
    // lose, but say so rather than silently producing empties that look like
    // data loss.
    notDuplicates: [],
    lexicon: {},
    rootId: null
  };
}

// ---------------------------------------------------------------------------

async function readBlob(pool, keys) {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'kv_store'`);
  if (!rowCount) return null;

  for (const key of keys) {
    const { rows } = await pool.query('SELECT key, value FROM kv_store WHERE key = $1', [key]);
    if (rows.length && rows[0].value) return rows[0];
  }
  return null;
}

async function backup(client, row) {
  const stamp = new Date().toISOString();
  const envelope = JSON.stringify({ key: row.key, backedUpAt: stamp, value: row.value });
  // A timestamped row per run, so a second migration cannot overwrite the
  // backup taken before the first one.
  await client.query(
    `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO NOTHING`, [`kv_store_backup:${stamp}`, envelope]);
  await client.query(
    `INSERT INTO kv_store (key, value, updated_at) VALUES ('kv_store_backup', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [envelope]);
  return `kv_store_backup:${stamp}`;
}

async function loadInto(client, treeId, data) {
  // People, upserted on their old id so a re-run updates rather than duplicates.
  const idOf = new Map();
  for (const p of data.people) {
    const { rows } = await client.query(`
      INSERT INTO people (tree_id, legacy_id, name, sex, totem, born, died, added_by, is_root)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (tree_id, legacy_id) DO UPDATE SET
        name = EXCLUDED.name, sex = EXCLUDED.sex, totem = EXCLUDED.totem,
        born = EXCLUDED.born, died = EXCLUDED.died,
        added_by = EXCLUDED.added_by, is_root = EXCLUDED.is_root
      RETURNING id`,
      [treeId, p.legacyId, p.name, p.sex, p.totem, p.born, p.died, p.addedBy, p.isRoot]);
    idOf.set(p.legacyId, rows[0].id);
  }

  const unionIdOf = new Map();
  for (const u of data.unions) {
    const { rows } = await client.query(`
      INSERT INTO unions (tree_id, legacy_id) VALUES ($1, $2)
      ON CONFLICT (tree_id, legacy_id) DO UPDATE SET legacy_id = EXCLUDED.legacy_id
      RETURNING id`, [treeId, u.legacyId]);
    unionIdOf.set(u.legacyId, rows[0].id);
  }

  // Links are rebuilt wholesale rather than upserted, so a re-run reflects the
  // blob exactly — including anyone removed from it. Children go first:
  // union_children.union_id is RESTRICT, so the child links must be cleared
  // before anything could try to remove a union out from under them.
  const unionIds = [...unionIdOf.values()];
  if (unionIds.length) {
    await client.query('DELETE FROM union_children WHERE union_id = ANY($1::uuid[])', [unionIds]);
    await client.query('DELETE FROM union_partners WHERE union_id = ANY($1::uuid[])', [unionIds]);
  }

  let partnerLinks = 0, childLinks = 0;
  const skipped = [];
  for (const u of data.unions) {
    const uid = unionIdOf.get(u.legacyId);
    let pos = 0;
    for (const legacy of u.partners) {
      const pid = idOf.get(legacy);
      if (!pid) { skipped.push(`union ${u.legacyId}: partner ${legacy} not in people`); continue; }
      await client.query(
        'INSERT INTO union_partners (union_id, person_id, position) VALUES ($1,$2,$3)',
        [uid, pid, pos++]);
      partnerLinks++;
    }
    let order = 0;
    for (const legacy of u.children) {
      const pid = idOf.get(legacy);
      if (!pid) { skipped.push(`union ${u.legacyId}: child ${legacy} not in people`); continue; }
      await client.query(
        'INSERT INTO union_children (union_id, person_id, birth_order) VALUES ($1,$2,$3)',
        [uid, pid, order++]);
      childLinks++;
    }
  }

  // Dismissals. These are a human's explicit judgement that two similarly
  // named people are different people — losing them means asking the family
  // the same question again, so they are carried across exactly.
  let dismissals = 0;
  for (const [aLegacy, bLegacy] of data.notDuplicates) {
    let a = idOf.get(String(aLegacy)), b = idOf.get(String(bLegacy));
    if (!a || !b || a === b) {
      skipped.push(`notDuplicates [${aLegacy}, ${bLegacy}]: unknown person`);
      continue;
    }
    if (a > b) [a, b] = [b, a];        // canonical, matching the table's CHECK
    await client.query(
      `INSERT INTO not_duplicates (tree_id, a_id, b_id, by) VALUES ($1,$2,$3,'migration')
       ON CONFLICT DO NOTHING`, [treeId, a, b]);
    dismissals++;
  }

  let terms = 0;
  for (const [shape, t] of Object.entries(data.lexicon || {})){
    if (!shape || !t || !String(t.term || '').trim()) continue;
    await client.query(
      `INSERT INTO kin_terms (tree_id, shape, term, note, by) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tree_id, shape) DO UPDATE SET
         term = EXCLUDED.term, note = EXCLUDED.note, by = EXCLUDED.by`,
      [treeId, shape, String(t.term).trim(), String(t.note || ''), String(t.by || '')]);
    terms++;
  }

  if (data.rootId && idOf.has(data.rootId)) {
    await client.query('UPDATE people SET is_root = false WHERE tree_id = $1', [treeId]);
    await client.query('UPDATE people SET is_root = true WHERE id = $1', [idOf.get(data.rootId)]);
  }

  return { idOf, unionIdOf, partnerLinks, childLinks, dismissals, terms, skipped };
}

// Count both sides and compare. A migration that reports success without
// checking is worse than one that fails.
//
// Counts are restricted to rows that CAME FROM THE BLOB — those carrying a
// legacy_id. The claim being verified is "everything in the blob arrived
// intact", not "the database contains nothing else": on a re-run, people added
// through the ops API since the first migration are legitimately present and
// are not the migration's business.
async function verify(client, treeId, data, loaded) {
  const one = async (sql, params) => Number((await client.query(sql, params)).rows[0].n);

  const dbPeople = await one(
    'SELECT count(*)::int n FROM people WHERE tree_id=$1 AND legacy_id IS NOT NULL', [treeId]);
  const dbUnions = await one(
    'SELECT count(*)::int n FROM unions WHERE tree_id=$1 AND legacy_id IS NOT NULL', [treeId]);
  const dbPartners = await one(`SELECT count(*)::int n FROM union_partners up
     WHERE EXISTS (SELECT 1 FROM unions u
                    WHERE u.id=up.union_id AND u.tree_id=$1 AND u.legacy_id IS NOT NULL)`, [treeId]);
  const dbChildren = await one(`SELECT count(*)::int n FROM union_children uc
     WHERE EXISTS (SELECT 1 FROM unions u
                    WHERE u.id=uc.union_id AND u.tree_id=$1 AND u.legacy_id IS NOT NULL)`, [treeId]);
  const dbDismissals = await one(`SELECT count(*)::int n FROM not_duplicates nd
     WHERE nd.tree_id=$1
       AND EXISTS (SELECT 1 FROM people p WHERE p.id=nd.a_id AND p.legacy_id IS NOT NULL)
       AND EXISTS (SELECT 1 FROM people p WHERE p.id=nd.b_id AND p.legacy_id IS NOT NULL)`, [treeId]);

  const expected = {
    people: data.people.length,
    unions: data.unions.length,
    partnerLinks: loaded.partnerLinks,
    childLinks: loaded.childLinks,
    dismissals: loaded.dismissals,
    terms: loaded.terms
  };
  const dbTerms = await one(
    'SELECT count(*)::int n FROM kin_terms WHERE tree_id=$1', [treeId]);
  const actual = {
    people: dbPeople, unions: dbUnions,
    partnerLinks: dbPartners, childLinks: dbChildren, dismissals: dbDismissals,
    terms: dbTerms
  };

  const mismatches = Object.keys(expected)
    .filter(k => expected[k] !== actual[k])
    .map(k => `${k}: blob has ${expected[k]}, database has ${actual[k]}`);

  // Birth order must survive as ORDER, not just as a count. Compare the actual
  // sequence of children in every union — this is the check that would catch a
  // migration that loaded everybody but scrambled who is the eldest.
  const { rows: dbOrder } = await client.query(`
    SELECT u.legacy_id, array_agg(p.legacy_id ORDER BY uc.birth_order) AS kids
      FROM unions u
      JOIN union_children uc ON uc.union_id = u.id
      JOIN people p ON p.id = uc.person_id
     WHERE u.tree_id = $1 GROUP BY u.legacy_id`, [treeId]);
  const dbByUnion = new Map(dbOrder.map(r => [r.legacy_id, r.kids]));
  let orderMismatch = 0;
  for (const u of data.unions) {
    if (!u.children.length) continue;
    const got = dbByUnion.get(u.legacyId) || [];
    const want = u.children.filter(c => loaded.idOf.has(c));
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      orderMismatch++;
      if (orderMismatch <= 3) {
        mismatches.push(`birth order in union ${u.legacyId}: expected ${want.join(',')}, got ${got.join(',')}`);
      }
    }
  }
  if (orderMismatch > 3) mismatches.push(`...and ${orderMismatch - 3} more birth-order mismatches`);

  return { expected, actual, mismatches };
}

// ---------------------------------------------------------------------------

async function run(pool, { apply = false, key = null, treeName = 'The Baobab Project', force = false } = {}) {
  await migrate(pool, () => {});

  const keys = key ? [key] : DEFAULT_KEYS;
  const row = await readBlob(pool, keys);
  if (!row) {
    return { found: false, keysTried: keys };
  }

  let parsed;
  try { parsed = JSON.parse(row.value); }
  catch (e) { throw new Error(`kv_store['${row.key}'] is not valid JSON: ${e.message}`); }

  const shape = detectShape(parsed);
  if (!shape) throw new Error(`kv_store['${row.key}'] does not look like a family tree`);

  const data = normalise(parsed, shape);
  const summary = {
    found: true, key: row.key, shape, apply,
    counts: {
      people: data.people.length,
      unions: data.unions.length,
      partnerLinks: data.unions.reduce((n, u) => n + u.partners.length, 0),
      childLinks: data.unions.reduce((n, u) => n + u.children.length, 0),
      dismissals: data.notDuplicates.length,
      terms: Object.keys(data.lexicon || {}).length
    }
  };
  if (!apply) return summary;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    summary.backupKey = await backup(client, row);

    // Re-use the tree a previous run created, so this is an update rather than
    // a second copy of the family.
    const existing = await client.query(
      `SELECT t.id FROM trees t
        WHERE EXISTS (SELECT 1 FROM people p WHERE p.tree_id = t.id AND p.legacy_id IS NOT NULL)
        ORDER BY t.created_at LIMIT 1`);
    let treeId;
    if (existing.rowCount) {
      treeId = existing.rows[0].id;
      summary.reusedTree = true;

      // Refuse to overwrite edits made since the last run. The blob is only
      // authoritative until somebody starts using the new API.
      const { rows: [{ n }] } = await client.query(
        `SELECT count(*)::int n FROM changes WHERE tree_id = $1 AND by <> 'migration'`, [treeId]);
      if (n > 0 && !force) {
        throw new Error(
          `tree ${treeId} has ${n} change(s) made through the ops API since it was ` +
          `migrated.\n` +
          `  Re-running resets every person that came from the blob back to their ` +
          `blob values,\n` +
          `  and rebuilds all their partner and child links from it. Edits made to ` +
          `those people\n` +
          `  through the app since the last run would be lost. People ADDED since ` +
          `are left alone.\n` +
          `  Pass --force if that is really what you want.`);
      }
    } else {
      const { rows } = await client.query(
        'INSERT INTO trees (name) VALUES ($1) RETURNING id', [treeName]);
      treeId = rows[0].id;
    }
    summary.treeId = treeId;

    const loaded = await loadInto(client, treeId, data);
    summary.skipped = loaded.skipped;

    const check = await verify(client, treeId, data, loaded);
    summary.verification = check;
    if (check.mismatches.length) {
      throw new Error('verification failed:\n  ' + check.mismatches.join('\n  '));
    }

    await client.query(
      `INSERT INTO changes (tree_id, entity, entity_id, op, payload, by)
       VALUES ($1, 'tree', NULL, 'migrateFromBlob', $2, 'migration')`,
      [treeId, JSON.stringify({ key: row.key, shape, counts: check.actual })]);

    await client.query('COMMIT');
    summary.applied = true;
    return summary;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { run, detectShape, normalise, normaliseLegacy, normaliseBaobab };

if (require.main === module) {
  const has = f => process.argv.includes(f);
  const val = f => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : null; };
  (async () => {
    const pool = createPool();
    if (!pool) { console.error('DATABASE_URL is not set'); process.exit(2); }
    const apply = has('--apply');
    const res = await run(pool, { apply, key: val('--key'), force: has('--force'),
                                  treeName: val('--name') || 'The Baobab Project' });
    if (!res.found) {
      console.log(`No family-tree blob found. Tried: ${res.keysTried.join(', ')}`);
      console.log('Nothing to migrate — this is a fresh database.');
      await pool.end();
      return;
    }
    console.log(`Found kv_store['${res.key}'] in the ${res.shape} shape:`);
    for (const [k, v] of Object.entries(res.counts)) {
      console.log(`  ${k.padEnd(14)} ${v}`);
    }
    if (!apply) {
      console.log('\nDry run — nothing was written. Re-run with --apply to migrate.');
    } else {
      console.log(`\nBacked up to kv_store['${res.backupKey}']`);
      console.log(`${res.reusedTree ? 'Updated' : 'Created'} tree ${res.treeId}`);
      if (res.skipped?.length) {
        console.log(`\n${res.skipped.length} link(s) skipped:`);
        res.skipped.slice(0, 10).forEach(s => console.log(`  - ${s}`));
      }
      console.log('\nVerified — blob and database agree:');
      for (const [k, v] of Object.entries(res.verification.actual)) {
        console.log(`  ${k.padEnd(14)} ${v}`);
      }
    }
    await pool.end();
  })().catch(e => { console.error('\nMIGRATION FAILED — nothing was written.\n' + e.message); process.exit(1); });
}
