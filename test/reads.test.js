// Read paths: bootstrap scoping, incremental sync, search and its context.

const { check, eq, rejects, section, freshPool, newTree, report } = require('./helpers');
const { applyOps } = require('../db/ops');
const { bootstrap, changesSince, search } = require('../db/reads');

(async () => {
  const pool = await freshPool();
  const tree = await newTree(pool, 'reads');
  const ops = o => applyOps(pool, tree, o, 'tester');

  // Four generations, with three Garikais at different positions — the case
  // the search context exists to disambiguate.
  const r = await ops([
    { op: 'addPerson', ref: '$gf', name: 'Garikai Moyo', sex: 'm', born: '1920' },
    { op: 'addPerson', ref: '$gm', name: 'Mbuya Rudo',   sex: 'f', born: '1925' },
    { op: 'addUnion', ref: '$g' },
    { op: 'addPartner', unionId: '$g', personId: '$gf' },
    { op: 'addPartner', unionId: '$g', personId: '$gm' },

    { op: 'addPerson', ref: '$dad', name: 'Rufaro Moyo', sex: 'm', born: '1950' },
    { op: 'addPerson', ref: '$aunt', name: 'Tete Chipo', sex: 'f', born: '1953' },
    { op: 'addChild', unionId: '$g', personId: '$dad' },
    { op: 'addChild', unionId: '$g', personId: '$aunt' },

    { op: 'addPerson', ref: '$mum', name: 'Nyasha Dube', sex: 'f', born: '1955' },
    { op: 'addUnion', ref: '$p' },
    { op: 'addPartner', unionId: '$p', personId: '$dad' },
    { op: 'addPartner', unionId: '$p', personId: '$mum' },

    // Named after his grandfather. Ordinary, and not a duplicate.
    { op: 'addPerson', ref: '$me', name: 'Garikai Moyo', sex: 'm', born: '1980' },
    { op: 'addPerson', ref: '$sis', name: 'Tsitsi Moyo', sex: 'f', born: '1983' },
    { op: 'addChild', unionId: '$p', personId: '$me' },
    { op: 'addChild', unionId: '$p', personId: '$sis' },

    { op: 'addPerson', ref: '$w', name: 'Rutendo Ncube', sex: 'f', born: '1982' },
    { op: 'addUnion', ref: '$mu' },
    { op: 'addPartner', unionId: '$mu', personId: '$me' },
    { op: 'addPartner', unionId: '$mu', personId: '$w' },
    // The third Garikai, named after his own father.
    { op: 'addPerson', ref: '$son', name: 'Sekuru Garikai Moyo', sex: 'm', born: '2010' },
    { op: 'addChild', unionId: '$mu', personId: '$son' },
    { op: 'setRoot', personId: '$gf' }
  ]);
  const id = k => r.refs['$' + k];

  section('bootstrap sends a neighbourhood, not the tree');
  const b1 = await bootstrap(pool, tree, { focus: id('me'), depth: 1 });
  const names1 = b1.people.map(p => p.name).sort();
  check('depth 1 reaches parents, siblings, partner and children',
        names1.includes('Rufaro Moyo') && names1.includes('Tsitsi Moyo') &&
        names1.includes('Rutendo Ncube') && names1.includes('Sekuru Garikai Moyo'),
        names1.join(', '));
  check('depth 1 does NOT reach the grandparents', !names1.includes('Mbuya Rudo'), names1.join(', '));

  const b2 = await bootstrap(pool, tree, { focus: id('me'), depth: 2 });
  check('depth 2 reaches the grandparents',
        b2.people.some(p => p.name === 'Mbuya Rudo'));
  check('depth 2 reaches the father’s sister',
        b2.people.some(p => p.name === 'Tete Chipo'));

  eq('bootstrap reports the true total, so the client knows it has a slice',
     b2.total, 9);
  eq('bootstrap reports the root', b2.rootId, id('gf'));
  check('bootstrap carries the seq the client should sync from', b2.seq > 0);
  check('each person is tagged with their distance from the focus',
        b2.people.find(p => p.id === id('me')).depth === 0 &&
        b2.people.find(p => p.id === id('gf')).depth === 2);

  section('bootstrap preserves the shapes the kinship rules read');
  const pu = b2.unions.find(u => u.id === id('p'));
  eq('children come back in birth order', pu.children, [id('me'), id('sis')]);
  eq('partners come back in position order', pu.partners, [id('dad'), id('mum')]);
  const b3 = await bootstrap(pool, tree, { depth: 3 });
  eq('with no focus, bootstrap starts from the root', b3.focus, id('gf'));

  section('search finds people whatever title is attached');
  const s1 = await search(pool, tree, 'Garikai');
  eq('all three Garikais are found', s1.results.length, 3);
  check('including the one recorded with an honorific',
        s1.results.some(x => x.name === 'Sekuru Garikai Moyo'));
  const s2 = await search(pool, tree, 'Sekuru Garikai');
  eq('searching WITH an honorific finds the same three', s2.results.length, 3);
  const s3 = await search(pool, tree, 'gari');
  eq('a prefix finds them too', s3.results.length, 3);

  section('search gives enough context to tell two Garikais apart');
  const ctx = Object.fromEntries(s1.results.map(x => [x.born_year, x.context]));
  check('the grandfather is identified by his marriage',
        /married to Mbuya Rudo/.test(ctx[1920]), ctx[1920]);
  check('the middle one by his parents, wife and child',
        /child of Rufaro Moyo and Nyasha Dube/.test(ctx[1980]) &&
        /married to Rutendo Ncube/.test(ctx[1980]), ctx[1980]);
  check('the youngest by his parents',
        /child of Garikai Moyo and Rutendo Ncube/.test(ctx[2010]), ctx[2010]);
  check('all three contexts are distinct',
        new Set(Object.values(ctx)).size === 3);

  section('search tolerates the way families actually spell names');
  const fuzzy = await search(pool, tree, 'Garikayi');
  check('a misspelling still finds them (or degrades honestly without pg_trgm)',
        fuzzy.fuzzy ? fuzzy.results.length >= 1 : true,
        `fuzzy=${fuzzy.fuzzy} hits=${fuzzy.results.length}`);
  eq('an empty query returns nothing rather than everything',
     (await search(pool, tree, '   ')).results.length, 0);

  section('incremental sync');
  const head = (await changesSince(pool, tree, 0)).head;
  const since = await changesSince(pool, tree, head - 3);
  eq('asking from a seq returns only what came after', since.changes.length, 3);
  check('every returned change is above the requested seq',
        since.changes.every(ch => ch.seq > head - 3));
  await ops([{ op: 'addPerson', name: 'Later Arrival' }]);
  const after = await changesSince(pool, tree, head);
  eq('a new write shows up for a client polling from the old head', after.changes.length, 1);
  eq('and it is the one just made', after.changes[0].op, 'addPerson');
  eq('a client already at the head gets nothing',
     (await changesSince(pool, tree, after.head)).changes.length, 0);
  const paged = await changesSince(pool, tree, 0, 2);
  eq('paging returns at most the limit', paged.changes.length, 2);
  check('and says there is more to fetch', paged.more === true);

  section('words the family has taught the app travel with the tree');
  await applyOps(pool, tree, [
    { op:'teachTerm', shape:'inlaw:through-my-husband:their-sibling:man',
      term:'Vatete vevarume', note:'as this family says it' },
    { op:'teachTerm', shape:'inlaw:through-my-husband:their-sibling:woman',
      term:'Muramu wangu' }
  ], 'hazvi');
  const withTerms = await bootstrap(pool, tree, { depth: 2 });
  eq('both taught words come back with the bootstrap',
     Object.keys(withTerms.lexicon).length, 2);
  eq('with the word itself',
     withTerms.lexicon['inlaw:through-my-husband:their-sibling:man'].term,
     'Vatete vevarume');
  eq('and who taught it', withTerms.lexicon['inlaw:through-my-husband:their-sibling:man'].by, 'hazvi');

  await applyOps(pool, tree, [
    { op:'teachTerm', shape:'inlaw:through-my-husband:their-sibling:man', term:'Babamunini' }
  ], 'someone-else');
  eq('teaching the same shape again corrects it rather than duplicating',
     (await bootstrap(pool, tree, { depth: 2 }))
       .lexicon['inlaw:through-my-husband:their-sibling:man'].term, 'Babamunini');

  await applyOps(pool, tree, [
    { op:'forgetTerm', shape:'inlaw:through-my-husband:their-sibling:woman' }], 'hazvi');
  eq('a word can be taken back',
     Object.keys((await bootstrap(pool, tree, { depth: 2 })).lexicon).length, 1);

  await rejects('a blank word is refused', () =>
    applyOps(pool, tree, [{ op:'teachTerm', shape:'x', term:'   ' }]), { status: 400 });
  await rejects('a word with no relationship shape is refused', () =>
    applyOps(pool, tree, [{ op:'teachTerm', shape:'', term:'Something' }]), { status: 400 });

  section('unknown trees');
  await rejects('bootstrap on a missing tree is a 404', () =>
    bootstrap(pool, '00000000-0000-4000-8000-000000000000', {}), { status: 404 });

  await pool.end();
  report();
})().catch(e => { console.error('\nHARNESS ERROR:', e); process.exit(1); });
