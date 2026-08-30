// Mitupo: identifying totems, and nothing more.
//
// A mutupo is a clan's totem, inherited down the male line. It is what
// Zimbabweans use to work out whether two people are of one house, which is
// why the cross-tree matcher weighs it above every other single signal.
//
// What is deliberately NOT here: any rule derived from a totem. No kinship
// term, no relationship, no marriage prohibition. Those are real and were
// explicitly left for later; this identifies the totem and stops there. If a
// test ever appears here asserting a term from a totem, it has overstepped.
//
// The list is for recognition, never restriction — so the load-bearing
// assertions are the ones about what happens to a totem the app has never
// heard of.

const { check, eq, section, report, loadFrontend } = require('./helpers');

const fe = loadFrontend();

(async () => {
  section('a totem is recognised however the family writes it');
  eq('the plain name',          fe.knownTotem('Shumba').name, 'Shumba');
  eq('lower case',              fe.knownTotem('shumba').name, 'Shumba');
  eq('with spaces around it',   fe.knownTotem('  Shumba  ').name, 'Shumba');
  eq('an alternate name for the same clan', fe.knownTotem('Sibanda').name, 'Shumba');
  eq('Zhou is Nzou',            fe.knownTotem('Zhou').name, 'Nzou');
  eq('Mukanya is Soko',         fe.knownTotem('Mukanya').name, 'Soko');
  eq('and Shava is Mhofu',      fe.knownTotem('Shava').name, 'Mhofu');

  section('a praise name after the totem does not hide it');
  // "Mhofu yeMukono", "Soko Murehwa": what follows says which house within
  // the clan, not which clan.
  eq('Mhofu yeMukono',  fe.knownTotem('Mhofu yeMukono').name, 'Mhofu');
  eq('Soko Murehwa',    fe.knownTotem('Soko Murehwa').name, 'Soko');
  eq('Nzou Samanyanga', fe.knownTotem('Nzou Samanyanga').name, 'Nzou');

  section('and it says what the totem names');
  eq('Shumba is the lion',  fe.knownTotem('Shumba').means, 'lion');
  eq('Nzou is the elephant', fe.knownTotem('Nzou').means, 'elephant');
  eq('Dziva is water',       fe.knownTotem('Dziva').means, 'pool, water');

  section('an unrecognised totem is not an error');
  // The list is certainly not complete, and a family's own word for their own
  // totem is not something an autocomplete list gets to overrule.
  eq('unknown returns nothing rather than a guess',
     fe.knownTotem('Chiwororo'), null);
  eq('and nothing at all returns nothing', fe.knownTotem(''), null);
  eq('but it still groups with itself',
     fe.totemKey('Chiwororo'), fe.totemKey('  chiwororo '));
  eq('and is never confused with a known one',
     fe.totemKey('Chiwororo') === fe.totemKey('Shumba'), false);

  section('two spellings of one clan group together');
  eq('Shumba and Sibanda',  fe.totemKey('Sibanda'), fe.totemKey('Shumba'));
  eq('Nzou and Zhou',       fe.totemKey('Zhou'),    fe.totemKey('Nzou'));
  eq('but two clans do not', fe.totemKey('Shumba') === fe.totemKey('Nzou'), false);

  section('the suggestions help somebody who knows it only in English');
  const eland = fe.totemSuggestions('eland').map(h => h.name);
  check('"eland" finds Mhofu', eland.includes('Mhofu'), eland.join(', '));
  const lion = fe.totemSuggestions('lion').map(h => h.name);
  check('"lion" finds Shumba', lion.includes('Shumba'), lion.join(', '));
  const sh = fe.totemSuggestions('sh').map(h => h.name);
  check('"sh" offers Shumba', sh.includes('Shumba'), sh.join(', '));
  eq('nothing typed offers nothing', fe.totemSuggestions('').length, 0);
  check('and the list is short enough to read', fe.totemSuggestions('a').length <= 6);

  section('the totems actually in a family');
  fe.setState({ people:{}, unions:{}, rootId:null, seq:1, notDuplicates:[], lexicon:{} });
  const st = fe.getState();
  const a = fe.addPerson('Rufaro',  'm', 'Shumba',  '1940', '');
  st.rootId = a;
  fe.grow('child',   a, 'Garikai',  'm', 'Sibanda', {});   // same clan, written differently
  fe.grow('child',   a, 'Tendai',   'm', 'Shumba',  {});
  fe.grow('partner', a, 'Chipo',    'f', 'Soko',    {});
  fe.grow('child',   a, 'Rudo',     'f', '',        {});   // no totem recorded

  const groups = fe.totemsHere();
  eq('two clans are present', groups.length, 2);
  eq('the commonest first',   groups[0].known.name, 'Shumba');
  eq('with everyone in it',   groups[0].people.length, 3);
  eq('including the one written Sibanda',
     groups[0].people.some(p => p.name === 'Garikai'), true);
  eq('and both spellings are remembered',
     [...groups[0].written].sort(), ['Shumba', 'Sibanda']);
  eq('the second clan',       groups[1].known.name, 'Soko');

  section('an unrecognised totem still appears, on its own terms');
  fe.grow('child', a, 'Nyasha', 'f', 'Chiwororo', {});
  const withUnknown = fe.totemsHere();
  const odd = withUnknown.find(g => g.key === 'chiwororo');
  check('it is listed', !!odd, withUnknown.map(g => g.key).join(', '));
  eq('as written, with no invented meaning', odd && odd.known, null);
  eq('and with its person', odd && odd.people[0].name, 'Nyasha');

  section('nothing is inferred from a totem');
  // The instruction was to identify totems and stop. Two people of one clan
  // are not thereby related, and no term is produced for them.
  const shumbaFolk = fe.totemsHere()[0].people.map(p => p.id);
  const [x, y] = shumbaFolk;
  const terms = fe.kinTerms(x, y);
  check('two people of one clan get a term only from how they are recorded, ' +
        'not from sharing a totem',
        !terms || !JSON.stringify(terms).toLowerCase().includes('shumba'),
        JSON.stringify(terms));

  section('the list itself is well formed');
  const seen = new Set();
  let dupes = 0, blanks = 0;
  for (const [name, means, also] of fe.MITUPO){
    if (seen.has(name.toLowerCase())) dupes++;
    seen.add(name.toLowerCase());
    if (!name || !means) blanks++;
    for (const alt of also){
      if (seen.has(alt.toLowerCase())) dupes++;
      seen.add(alt.toLowerCase());
    }
  }
  eq('no name is listed twice', dupes, 0);
  eq('every entry says what it names', blanks, 0);
  check('and there are enough of them to be useful', fe.MITUPO.length >= 15);

  report();
})();
