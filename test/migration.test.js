// Migration off the single-JSON-blob store.
//
// The blob is irreplaceable — a family typed it in by hand — so these tests
// care about more than row counts: birth order, dismissals, and a hand-picked
// family checked person by person.

const { check, eq, rejects, section, freshPool, newTree, report } = require('./helpers');
const { run } = require('../scripts/migrate-data');
const { applyOps } = require('../db/ops');
const { bootstrap } = require('../db/reads');

// A hand-built family, in the shape the current frontend describes.
// Sekuru Tafara + Mbuya Rudo
//   -> Rufaro (eldest), Tete Chipo, Tendai
// Rufaro + Nyasha -> Garikai (eldest), Tsitsi
// Rufaro remarried to Shamiso -> Farai
const BAOBAB = {
  people: {
    p1: { id: 'p1', name: 'Sekuru Tafara', sex: 'm', totem: 'Shumba', born: '1918', died: '1994', root: true },
    p2: { id: 'p2', name: 'Mbuya Rudo',    sex: 'f', totem: 'Moyo',   born: '1922', died: '2001' },
    p3: { id: 'p3', name: 'Rufaro',        sex: 'm', totem: 'Shumba', born: '1948', died: '' },
    p4: { id: 'p4', name: 'Tete Chipo',    sex: 'f', totem: 'Shumba', born: '1951', died: '' },
    p5: { id: 'p5', name: 'Tendai',        sex: 'm', totem: 'Shumba', born: '1955', died: '' },
    p6: { id: 'p6', name: 'Nyasha',        sex: 'f', totem: 'Soko',   born: '1952', died: '' },
    p7: { id: 'p7', name: 'Garikai',       sex: 'm', totem: 'Shumba', born: '1975', died: '' },
    p8: { id: 'p8', name: 'Tsitsi',        sex: 'f', totem: 'Shumba', born: '1978', died: '' },
    p9: { id: 'p9', name: 'Shamiso',       sex: 'f', totem: 'Nzou',   born: '1960', died: '' },
    p10:{ id: 'p10',name: 'Farai',         sex: 'm', totem: 'Shumba', born: '1988', died: '' },
    p11:{ id: 'p11',name: 'Garikai',       sex: 'm', totem: 'Shumba', born: '2005', died: '' }
  },
  unions: {
    u1: { id: 'u1', partners: ['p1', 'p2'], children: ['p3', 'p4', 'p5'] },
    u2: { id: 'u2', partners: ['p3', 'p6'], children: ['p7', 'p8'] },
    u3: { id: 'u3', partners: ['p3', 'p9'], children: ['p10'] },
    u4: { id: 'u4', partners: ['p7'],       children: ['p11'] }   // spouse unknown
  },
  rootId: 'p1',
  seq: 40,
  notDuplicates: [['p7', 'p11']],    // the two Garikais: judged, and different
  // A word this family taught the app, which must survive the move.
  lexicon: {
    'inlaw:through-my-husband:their-sibling:man':
      { term: 'Vatete vevarume', note: 'as this family says it', by: 'Rufaro', at: '2026-08-30' }
  }
};

// The same family in the older shape the deployed app actually wrote.
const LEGACY = {
  nextId: 12,
  people: {
    p1: { id:'p1', name:'Sekuru Tafara', sex:'M', totem:'Shumba', fatherId:null, motherId:null, spouseId:'p2', order:0, addedBy:'hazvi' },
    p2: { id:'p2', name:'Mbuya Rudo',    sex:'F', totem:'Moyo',   fatherId:null, motherId:null, spouseId:'p1', order:0, addedBy:'hazvi' },
    p3: { id:'p3', name:'Rufaro',        sex:'M', totem:'Shumba', fatherId:'p1', motherId:'p2', spouseId:'p6', order:0, addedBy:'hazvi' },
    p4: { id:'p4', name:'Tete Chipo',    sex:'F', totem:'Shumba', fatherId:'p1', motherId:'p2', spouseId:null, order:1, addedBy:'' },
    p5: { id:'p5', name:'Tendai',        sex:'M', totem:'Shumba', fatherId:'p1', motherId:'p2', spouseId:null, order:2, addedBy:'' },
    p6: { id:'p6', name:'Nyasha',        sex:'F', totem:'Soko',   fatherId:null, motherId:null, spouseId:'p3', order:0, addedBy:'' },
    p7: { id:'p7', name:'Garikai',       sex:'M', totem:'Shumba', fatherId:'p3', motherId:'p6', spouseId:null, order:0, addedBy:'' },
    p8: { id:'p8', name:'Tsitsi',        sex:'F', totem:'Shumba', fatherId:'p3', motherId:'p6', spouseId:null, order:1, addedBy:'' },
    p9: { id:'p9', name:'Shamiso',       sex:'F', totem:'Nzou',   fatherId:null, motherId:null, spouseId:null, order:0, addedBy:'' },
    p11:{ id:'p11',name:'Garikai',       sex:'M', totem:'Shumba', fatherId:'p7', motherId:null, spouseId:null, order:0, addedBy:'' },
    // A married couple with no recorded children. In the old shape their
    // marriage exists ONLY as the mutual spouseId pointer — there is no child
    // to infer a union from — so it is the case most easily lost in the move.
    p12:{ id:'p12',name:'Tapiwa',        sex:'M', totem:'Nzou',   fatherId:null, motherId:null, spouseId:'p13', order:0, addedBy:'' },
    p13:{ id:'p13',name:'Vimbai',        sex:'F', totem:'Hungwe', fatherId:null, motherId:null, spouseId:'p12', order:0, addedBy:'' }
  }
};

async function putBlob(pool, key, obj) {
  await pool.query(`CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ DEFAULT now())`);
  await pool.query(
    `INSERT INTO kv_store (key, value) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [key, JSON.stringify(obj)]);
}

const nameOf = async (pool, tree, legacy) => (await pool.query(
  'SELECT name FROM people WHERE tree_id=$1 AND legacy_id=$2', [tree, legacy])).rows[0]?.name;
const idOf = async (pool, tree, legacy) => (await pool.query(
  'SELECT id FROM people WHERE tree_id=$1 AND legacy_id=$2', [tree, legacy])).rows[0]?.id;

(async () => {
  const pool = await freshPool();

  section('a fresh database with no blob');
  const none = await run(pool, { apply: false });
  eq('reports nothing to migrate rather than failing', none.found, false);

  section('reading the blob without writing anything');
  await putBlob(pool, 'muti-baobab-v1', BAOBAB);
  const dry = await run(pool, { apply: false });
  eq('the shape is detected, not assumed', dry.shape, 'baobab');
  eq('counts are reported from the blob', dry.counts,
     { people: 11, unions: 4, partnerLinks: 7, childLinks: 7, dismissals: 1, terms: 1 });
  eq('a dry run writes no people', 
     (await pool.query('SELECT count(*)::int n FROM people')).rows[0].n, 0);

  section('migrating the baobab shape');
  const r = await run(pool, { apply: true });
  const tree = r.treeId;
  check('it applied', r.applied === true);
  eq('verification found no mismatches', r.verification.mismatches, []);
  eq('every person arrived', r.verification.actual.people, 11);
  eq('every union arrived', r.verification.actual.unions, 4);
  eq('every partner link arrived', r.verification.actual.partnerLinks, 7);
  eq('every child link arrived', r.verification.actual.childLinks, 7);
  eq('the dismissal arrived', r.verification.actual.dismissals, 1);
  eq('the taught word arrived', r.verification.actual.terms, 1);
  eq('with its wording intact',
     (await pool.query('SELECT term, by FROM kin_terms WHERE tree_id=$1', [tree])).rows[0],
     { term: 'Vatete vevarume', by: 'Rufaro' });

  section('the blob was backed up before anything was written');
  const bk = (await pool.query(
    `SELECT value FROM kv_store WHERE key='kv_store_backup'`)).rows[0];
  check('a backup row exists', !!bk);
  const env = JSON.parse(bk.value);
  eq('it names the key it came from', env.key, 'muti-baobab-v1');
  eq('and holds the original blob byte for byte', env.value, JSON.stringify(BAOBAB));
  check('a timestamped copy exists too', (await pool.query(
    `SELECT count(*)::int n FROM kv_store WHERE key LIKE 'kv_store_backup:%'`)).rows[0].n >= 1);

  section('spot-checking a hand-picked family, person by person');
  const u1 = (await pool.query(
    `SELECT p.legacy_id, p.name FROM unions u
       JOIN union_children uc ON uc.union_id=u.id JOIN people p ON p.id=uc.person_id
      WHERE u.tree_id=$1 AND u.legacy_id='u1' ORDER BY uc.birth_order`, [tree])).rows;
  eq('Tafara and Rudo’s children are in birth order, eldest first',
     u1.map(x => x.name), ['Rufaro', 'Tete Chipo', 'Tendai']);

  const u1p = (await pool.query(
    `SELECT p.name FROM unions u JOIN union_partners up ON up.union_id=u.id
       JOIN people p ON p.id=up.person_id
      WHERE u.tree_id=$1 AND u.legacy_id='u1' ORDER BY up.position`, [tree])).rows;
  eq('their partners kept their order', u1p.map(x => x.name), ['Sekuru Tafara', 'Mbuya Rudo']);

  const tafara = (await pool.query(
    `SELECT * FROM people WHERE tree_id=$1 AND legacy_id='p1'`, [tree])).rows[0];
  eq('every field survived', [tafara.name, tafara.sex, tafara.totem, tafara.born, tafara.died],
     ['Sekuru Tafara', 'm', 'Shumba', '1918', '1994']);
  eq('the honorific is kept in the name', tafara.name, 'Sekuru Tafara');
  eq('but stripped in the match key', tafara.name_key, 'tafara');
  eq('the birth year was extracted', tafara.born_year, 1918);
  eq('the root flag survived', tafara.is_root, true);

  eq('Rufaro is a partner in both his marriages',
     (await pool.query(`SELECT count(*)::int n FROM union_partners up
        JOIN people p ON p.id=up.person_id WHERE p.tree_id=$1 AND p.legacy_id='p3'`, [tree])).rows[0].n, 2);
  eq('and each marriage kept its own children',
     (await pool.query(`SELECT u.legacy_id, count(uc.person_id)::int n FROM unions u
        LEFT JOIN union_children uc ON uc.union_id=u.id
        WHERE u.tree_id=$1 AND u.legacy_id IN ('u2','u3') GROUP BY u.legacy_id ORDER BY u.legacy_id`,
        [tree])).rows.map(x => [x.legacy_id, x.n]), [['u2', 2], ['u3', 1]]);

  eq('the one-partner union (spouse unknown) survived as one partner',
     (await pool.query(`SELECT count(*)::int n FROM unions u JOIN union_partners up ON up.union_id=u.id
        WHERE u.tree_id=$1 AND u.legacy_id='u4'`, [tree])).rows[0].n, 1);

  section('the two Garikais stayed two people, and the judgement survived');
  eq('both Garikais exist',
     (await pool.query(`SELECT count(*)::int n FROM people WHERE tree_id=$1 AND name='Garikai'`,
        [tree])).rows[0].n, 2);
  const nd = (await pool.query('SELECT a_id, b_id FROM not_duplicates WHERE tree_id=$1', [tree])).rows[0];
  const [g1, g2] = [await idOf(pool, tree, 'p7'), await idOf(pool, tree, 'p11')];
  eq('the dismissal names exactly those two, canonically ordered',
     [nd.a_id, nd.b_id], [g1, g2].sort());

  section('re-running is safe');
  const again = await run(pool, { apply: true });
  eq('it reuses the same tree rather than making a second one', again.treeId, tree);
  eq('the person count is unchanged', again.verification.actual.people, 11);
  eq('there is still only one tree',
     (await pool.query('SELECT count(*)::int n FROM trees')).rows[0].n, 1);
  eq('birth order is still right after a re-run',
     (await pool.query(`SELECT p.name FROM unions u JOIN union_children uc ON uc.union_id=u.id
        JOIN people p ON p.id=uc.person_id WHERE u.tree_id=$1 AND u.legacy_id='u1'
        ORDER BY uc.birth_order`, [tree])).rows.map(x => x.name),
     ['Rufaro', 'Tete Chipo', 'Tendai']);

  section('re-running refuses to discard work done since');
  await applyOps(pool, tree, [{ op: 'addPerson', name: 'Added After Migration' }], 'hazvi');
  await rejects('a re-run over later edits is refused', () => run(pool, { apply: true }));
  eq('and the later edit is still there',
     (await pool.query(`SELECT count(*)::int n FROM people WHERE tree_id=$1
        AND name='Added After Migration'`, [tree])).rows[0].n, 1);
  const forced = await run(pool, { apply: true, force: true });
  eq('--force goes through', forced.applied, true);

  section('the migrated tree works through the real read path');
  const boot = await bootstrap(pool, tree, { focus: await idOf(pool, tree, 'p7'), depth: 2 });
  const near = boot.people.map(p => p.name);
  check('Garikai reaches his father', near.includes('Rufaro'));
  check('his sister', near.includes('Tsitsi'));
  check('his half-brother through his father’s second marriage', near.includes('Farai'));
  check('and his own son', near.includes('Garikai'));
  check('at depth 2 he reaches his grandfather', near.includes('Sekuru Tafara'));

  await pool.end();

  // ---- the older shape, in its own database ----
  const pool2 = await freshPool();
  section('migrating the older fatherId/motherId/spouseId shape');
  await pool2.query('DROP TABLE IF EXISTS kv_store');
  for (const t of ['not_duplicates','union_children','union_partners','changes','people','unions','trees'])
    await pool2.query(`DELETE FROM ${t}`);
  await putBlob(pool2, 'family-tree-people', LEGACY);

  const L = await run(pool2, { apply: true });
  eq('the older shape is detected', L.shape, 'legacy');
  eq('verification found no mismatches', L.verification.mismatches, []);
  eq('every person arrived', L.verification.actual.people, 12);
  eq('the older shape has no lexicon, and that is reported as zero rather than lost',
     L.verification.actual.terms, 0);
  const t2 = L.treeId;

  eq('sex M/F was converted to m/f',
     (await pool2.query(`SELECT sex FROM people WHERE tree_id=$1 AND legacy_id='p1'`, [t2])).rows[0].sex, 'm');
  eq('addedBy was kept rather than dropped',
     (await pool2.query(`SELECT added_by FROM people WHERE tree_id=$1 AND legacy_id='p1'`, [t2])).rows[0].added_by,
     'hazvi');

  section('parent pointers became unions');
  const kids = (await pool2.query(`
    SELECT p.name FROM unions u JOIN union_children uc ON uc.union_id=u.id
      JOIN people p ON p.id=uc.person_id
     WHERE u.tree_id=$1 AND u.legacy_id='pair:p1+p2' ORDER BY uc.birth_order`, [t2])).rows;
  eq('the parent pair became one union with its children in `order`',
     kids.map(x => x.name), ['Rufaro', 'Tete Chipo', 'Tendai']);

  const rufUnions = (await pool2.query(`
    SELECT count(*)::int n FROM union_partners up JOIN people p ON p.id=up.person_id
     WHERE p.tree_id=$1 AND p.legacy_id='p3'`, [t2])).rows[0].n;
  eq('Rufaro is a partner in exactly one union, not two', rufUnions, 1);

  eq('a childless marriage, which exists only as a spouse pointer, produced a union',
     (await pool2.query(`SELECT count(*)::int n FROM unions
        WHERE tree_id=$1 AND legacy_id LIKE 'couple:%'`, [t2])).rows[0].n, 1);
  eq('with both partners in it',
     (await pool2.query(`SELECT p.name FROM unions u JOIN union_partners up ON up.union_id=u.id
        JOIN people p ON p.id=up.person_id
        WHERE u.tree_id=$1 AND u.legacy_id LIKE 'couple:%' ORDER BY up.position`,
        [t2])).rows.map(x => x.name), ['Tapiwa', 'Vimbai']);
  eq('and a couple who DO have children did not get a second, duplicate union',
     (await pool2.query(`SELECT count(*)::int n FROM union_partners up
        JOIN people p ON p.id=up.person_id
        WHERE p.tree_id=$1 AND p.legacy_id='p1'`, [t2])).rows[0].n, 1);

  eq('a father-only parent became a one-partner union',
     (await pool2.query(`SELECT count(*)::int n FROM union_partners up
        JOIN unions u ON u.id=up.union_id
        WHERE u.tree_id=$1 AND u.legacy_id='pair:p7+'`, [t2])).rows[0].n, 1);

  eq('nobody ended up with two sets of parents',
     (await pool2.query(`SELECT count(*)::int n FROM (
        SELECT person_id FROM union_children GROUP BY person_id HAVING count(*)>1) x`)).rows[0].n, 0);

  await pool2.end();
  report();
})().catch(e => { console.error('\nHARNESS ERROR:', e); process.exit(1); });
