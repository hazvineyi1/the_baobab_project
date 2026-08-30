// One deployment, many families.
//
// Until now this served one tree to everyone, which made the cross-tree
// matcher pointless: there was never a second family to find. Each tree now
// has a key, and the key is the credential that opens it.
//
// The honest description, which these assert rather than assume: this is
// capability access, not accounts. Hold the key and you are in; there is no
// way to tell two holders apart, and no way to take it from one without
// changing it for everybody. What it buys is that a family's records stop
// being visible to every other family on the deployment.

const { check, eq, section, freshPool, report } = require('./helpers');
const { applyOps } = require('../db/ops');
const { fullTree } = require('../db/reads');

(async () => {
  const pool = await freshPool();
  const make = async name => (await pool.query(
    'INSERT INTO trees (name) VALUES ($1) RETURNING id, key, name', [name])).rows[0];

  section('every family gets a key, without anyone asking for one');
  const moyo = await make('Moyo');
  const ncube = await make('Ncube');
  check('a key was minted', !!moyo.key, JSON.stringify(moyo));
  check('long enough not to be guessed', moyo.key.length >= 20, moyo.key);
  check('and made only of characters that survive being read aloud',
        /^[a-z2-9]+$/.test(moyo.key), moyo.key);
  check('two families never share one', moyo.key !== ncube.key);

  section('the alphabet leaves out the characters people misread');
  // 0/O and 1/I/l are what turn a link copied off a screen into a dead one.
  check('no zero or O', !/[0o]/.test(moyo.key + ncube.key));
  check('no one, I or l',  !/[1il]/.test(moyo.key + ncube.key));

  section('keys are unguessable in the only way that matters');
  const keys = new Set();
  for (let i = 0; i < 200; i++) keys.add((await make('t' + i)).key);
  eq('200 families, 200 distinct keys', keys.size, 200);

  section('the database will not accept a short key');
  let refused = false;
  try {
    await pool.query('INSERT INTO trees (name, key) VALUES ($1,$2)', ['Weak', 'abc']);
  } catch (e) { refused = /trees_key_long_enough/.test(e.message); }
  check('a key too short to be a credential is rejected', refused);

  section('the key opens its own family and no other');
  const byKey = async key => (await pool.query(
    'SELECT id, name FROM trees WHERE key = $1', [key])).rows[0] || null;
  eq('the Moyo key finds the Moyo family', (await byKey(moyo.key)).name, 'Moyo');
  eq('and the Ncube key the Ncube one',    (await byKey(ncube.key)).name, 'Ncube');
  eq('a key nobody issued finds nothing',
     await byKey('zzzzzzzzzzzzzzzzzzzz'), null);

  section('families do not see into each other');
  await applyOps(pool, moyo.id,
    [{ op:'addPerson', name:'Rufaro Moyo', sex:'m', born:'1912' }], 'Rudo');
  await applyOps(pool, ncube.id,
    [{ op:'addPerson', name:'Tapiwa Ncube', sex:'m', born:'1950' }], 'Tapiwa');
  const seenByMoyo = (await fullTree(pool, moyo.id)).people.map(p => p.name);
  eq('the Moyo tree holds only its own', seenByMoyo, ['Rufaro Moyo']);
  eq('and the Ncube tree only its own',
     (await fullTree(pool, ncube.id)).people.map(p => p.name), ['Tapiwa Ncube']);

  section('changing the key locks out the old link');
  const rotated = (await pool.query(
    `UPDATE trees SET key = mw_new_tree_key(), key_set_at = clock_timestamp()
      WHERE id = $1 RETURNING key`, [moyo.id])).rows[0];
  check('a new key was issued', rotated.key !== moyo.key);
  eq('the old one opens nothing now', await byKey(moyo.key), null);
  eq('the new one opens the same family', (await byKey(rotated.key)).name, 'Moyo');

  section('and nothing in the tree was touched by the change');
  eq('everybody is still there',
     (await fullTree(pool, moyo.id)).people.map(p => p.name), ['Rufaro Moyo']);
  eq('under the same id', (await byKey(rotated.key)).id, moyo.id);

  section('the id is not the credential');
  // Ids are what every other table references. If the key were the id, a
  // family could never change their link without rewriting every row that
  // points at them.
  const refs = (await pool.query(
    `SELECT count(*)::int n FROM people WHERE tree_id = $1`, [moyo.id])).rows[0].n;
  eq('rows still point at the unchanged id', refs, 1);

  report();
})();
