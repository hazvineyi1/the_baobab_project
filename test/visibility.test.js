// Who is published, and who is not.
//
// Every other test in this project asks whether something works. These ask
// whether something LEAKS, which is a different question and needs a different
// habit: it is not enough to check that the public read returns the ancestors,
// because a read that returned everybody would pass that too. Each check here
// names a person who must NOT come back, and looks for them.
//
// The rule: an explicit choice always wins. Absent a choice, the dead are
// public and the living are private — and "living" leans safe, so a person
// with no dates at all is private until somebody says otherwise.

const { check, eq, rejects, section, freshPool, newTree, report } = require('./helpers');
const { applyOps } = require('../db/ops');
const { fullTree, publicTree, publicPerson, search } = require('../db/reads');
const { findRelatives } = require('../db/crosstree');

const thisYear = new Date().getFullYear();

(async () => {
  const pool = await freshPool();
  const tree = await newTree(pool, 'Moyo');

  const built = await applyOps(pool, tree, [
    // Long dead: born and died in the record.
    { op:'addPerson', ref:'$old',   name:'Chenjerai Moyo', sex:'m', totem:'Nzou',
      born:'1908', died:'1974' },
    // No death recorded, but born far enough back to be presumed gone.
    { op:'addPerson', ref:'$older', name:'Tateguru Moyo', sex:'m', totem:'Nzou',
      born:'1870' },
    // Plainly alive.
    { op:'addPerson', ref:'$son',   name:'Garikai Moyo', sex:'m', totem:'Nzou',
      born:String(thisYear - 40) },
    // Nothing known but a name — the case that decides which way the default
    // leans when the app cannot tell.
    { op:'addPerson', ref:'$unknown', name:'Rudo Moyo', sex:'f', totem:'Nzou' },
    { op:'addUnion', ref:'$u' },
    { op:'addPartner', unionId:'$u', personId:'$old' },
    { op:'addChild',   unionId:'$u', personId:'$son' }
  ], 'Rudo');
  const id = k => built.refs['$' + k];
  const name = k => ({ old:'Chenjerai Moyo', older:'Tateguru Moyo',
                       son:'Garikai Moyo', unknown:'Rudo Moyo' })[k];

  const publicNames = async () => (await publicTree(pool, tree)).people.map(p => p.name);

  section('with nobody having chosen, the dead are public');
  let out = await publicNames();
  check('the ancestor who died in 1974', out.includes(name('old')), out.join(', '));
  check('and the one born in 1870, with no death recorded',
        out.includes(name('older')), out.join(', '));

  section('and the living are not');
  check('a man of 40 is not published', !out.includes(name('son')), out.join(', '));
  check('nor is somebody with no dates at all — the safe way to lean',
        !out.includes(name('unknown')), out.join(', '));

  section('the family still sees everybody');
  const family = (await fullTree(pool, tree)).people.map(p => p.name);
  eq('all four', family.length, 4);
  check('including the private ones', family.includes(name('son')) &&
                                      family.includes(name('unknown')));
  const sonRow = (await fullTree(pool, tree)).people.find(p => p.id === id('son'));
  eq('and is told they are living',   sonRow.is_living, true);
  eq('and that they are not public',  sonRow.is_public, false);

  section('a living person can choose to be published');
  await applyOps(pool, tree, [{ op:'setVisibility', id:id('son'), visibility:'public' }], 'Garikai');
  out = await publicNames();
  check('now he is', out.includes(name('son')), out.join(', '));
  const chosen = (await fullTree(pool, tree)).people.find(p => p.id === id('son'));
  eq('the choice is recorded',       chosen.visibility, 'public');
  eq('with who made it',             chosen.visibility_by, 'Garikai');
  check('and when',                  !!chosen.visibility_at);
  eq('he is still recorded as living', chosen.is_living, true);

  section('and can change their mind');
  await applyOps(pool, tree, [{ op:'setVisibility', id:id('son'), visibility:'private' }], 'Garikai');
  out = await publicNames();
  check('back out of the public record', !out.includes(name('son')), out.join(', '));

  section('a family can withhold a dead relative too');
  await applyOps(pool, tree, [{ op:'setVisibility', id:id('old'), visibility:'private' }], 'Rudo');
  out = await publicNames();
  check('an explicit choice wins in either direction',
        !out.includes(name('old')), out.join(', '));

  section('clearing the choice returns them to the default');
  await applyOps(pool, tree, [{ op:'setVisibility', id:id('old'), visibility:null }], 'Rudo');
  out = await publicNames();
  check('the dead man is public again', out.includes(name('old')), out.join(', '));
  const cleared = (await fullTree(pool, tree)).people.find(p => p.id === id('old'));
  eq('and nothing is left behind', cleared.visibility, null);
  eq('nor a timestamp',            cleared.visibility_at, null);

  section('the public read gives what identifies an ancestor, and no more');
  const row = (await publicTree(pool, tree)).people.find(p => p.name === name('old'));
  eq('a name',      row.name, 'Chenjerai Moyo');
  eq('a totem',     row.totem, 'Nzou');
  check('no note of who recorded them', !('added_by' in row), Object.keys(row).join(', '));
  check('no set-aside reason',          !('aside_why' in row));
  check('no timestamps',                !('updated_at' in row) && !('created_at' in row));
  check('and not the visibility working either', !('visibility' in row));

  section('the public graph never points at somebody it will not name');
  const pt = await publicTree(pool, tree);
  const shown = new Set(pt.people.map(p => p.id));
  const dangling = pt.unions.flatMap(u => [...u.partners, ...u.children])
                            .filter(x => !shown.has(x));
  eq('no dangling members', dangling, []);

  section('one ancestor, for a page anybody can link to');
  const page = await publicPerson(pool, id('old'));
  check('the ancestor comes back', !!page);
  eq('named',                      page.person.name, 'Chenjerai Moyo');
  eq('and his living son is not among his children', page.children.length, 0);

  section('private and non-existent are indistinguishable from outside');
  eq('a private living person returns nothing', await publicPerson(pool, id('unknown')), null);
  eq('and so does an id that was never issued',
     await publicPerson(pool, '00000000-0000-0000-0000-000000000000'), null);

  section('a private person never reaches another family');
  // The leak that matters most: cross-tree matching shows one family a name,
  // a year and a totem from another. A private living person must not be in
  // it — not hidden from the results, but never compared, because a match is
  // shown to both sides.
  const other = await newTree(pool, 'Ncube');
  await applyOps(pool, other, [
    { op:'addPerson', name:'Garikai Moyo', sex:'m', totem:'Nzou', born:String(thisYear - 40) },
    { op:'addPerson', name:'Chenjerai Moyo', sex:'m', totem:'Nzou', born:'1908' }
  ], 'Tapiwa');

  const found = await findRelatives(pool, tree);
  const leaked = found.matches.filter(m => m.mine.name === name('son'));
  eq('the private living man is offered to nobody', leaked.length, 0,
     JSON.stringify(found.matches.map(m => m.mine.name)));
  const fromOther = await findRelatives(pool, other);
  eq('and cannot be found from their side either',
     fromOther.matches.filter(m => m.theirs.id === id('son')).length, 0);

  section('it takes BOTH sides choosing, which is the point');
  // A match is shown to two families, so one person's choice cannot publish
  // the other. Our Garikai going public is not enough while theirs has not.
  await applyOps(pool, tree, [{ op:'setVisibility', id:id('son'), visibility:'public' }], 'Garikai');
  let now = await findRelatives(pool, tree);
  eq('one side alone is not enough',
     now.matches.filter(m => m.mine.id === id('son')).length, 0,
     now.matches.map(m => `${m.mine.name}=${m.score}`).join('; '));

  // Their Garikai chooses too.
  const theirGarikai = (await pool.query(
    `SELECT id FROM people WHERE tree_id = $1 AND name = 'Garikai Moyo'`, [other])).rows[0].id;
  await applyOps(pool, other, [{ op:'setVisibility', id:theirGarikai, visibility:'public' }], 'Tapiwa');
  now = await findRelatives(pool, tree);
  check('once both have chosen, they can find each other',
        now.matches.some(m => m.mine.id === id('son') && m.theirs.id === theirGarikai),
        now.matches.map(m => `${m.mine.name}=${m.score}`).join('; '));

  section('the op refuses anything it does not understand');
  await rejects('a made-up visibility',
    () => applyOps(pool, tree, [{ op:'setVisibility', id:id('son'), visibility:'sort-of' }], 'x'),
    /public.*private.*null/i);

  section('and the database refuses it too, written straight to the table');
  await rejects('bypassing the op changes nothing',
    () => pool.query(`UPDATE people SET visibility = 'maybe' WHERE id = $1`, [id('son')]),
    /people_visibility_valid/);

  report();
})();
