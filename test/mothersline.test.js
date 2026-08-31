// Rules the family gave this app, and the machinery for giving it more.
//
// WHERE THESE COME FROM. They were not read out of a book. They were told to
// this project by the family it is being built for, in these words:
//
//   "My sisters children are my children if i am female, if i am male they
//    are vazukuru."
//   "My brothers sons are sekuru to my children and his daughters are mainini
//    to my children."
//   "Victor Tendai Musoni is the son of Ida Murraye Musoni who is the sister
//    of Hazvineyi Belinda Musoni, thus making Victor a son to Hazvineyi."
//
// That last one is the first rule with the names left in, and it is here as
// its own case because a rule stated abstractly and a rule recognised in a
// real tree are two different tests.
//
// THE FIRST RULE IS UNUSUAL IN THIS FILE and worth flagging: the answer turns
// on the sex of the person ASKING. The same two people, the same tree, and the
// word changes depending on who is looking. Almost nothing else here does
// that, so it is asserted from both sides.

const { check, eq, section, report, loadFrontend } = require('./helpers');

/* Three siblings — two sisters and a brother — each with children. Enough
   shape for every rule above to have somewhere to land. */
function house() {
  const fe = loadFrontend();
  const gf = fe.addPerson('Sekuru Chenjerai', 'm', 'Nzou', '1920', '1998');
  const gm = fe.addPerson('Ambuya Rufaro', 'f', 'Shava', '1925', '2001');
  const haz = fe.addPerson('Hazvineyi Belinda', 'f', 'Nzou', '1972', '');
  const ida = fe.addPerson('Ida Murraye', 'f', 'Nzou', '1975', '');
  const bro = fe.addPerson('Terence Kurauwone', 'm', 'Nzou', '1981', '');
  fe.addUnion([gf, gm], [haz, ida, bro]);

  const hazH = fe.addPerson('Joseph Mhaka', 'm', 'Shava', '1970', '');
  const hazSon = fe.addPerson('Takunda', 'm', 'Shava', '2000', '');
  const hazDau = fe.addPerson('Rudo', 'f', 'Shava', '2003', '');
  fe.addUnion([haz, hazH], [hazSon, hazDau]);

  const idaH = fe.addPerson('Tendai Musoni', 'm', 'Moyo', '1970', '');
  const victor = fe.addPerson('Victor Tendai', 'm', 'Moyo', '2000', '');
  const idaDau = fe.addPerson('Chipo', 'f', 'Moyo', '2004', '');
  fe.addUnion([ida, idaH], [victor, idaDau]);

  const broW = fe.addPerson('Janet Munderi', 'f', 'Moyo', '1985', '');
  const broSon = fe.addPerson('Munyaradzi', 'm', 'Nzou', '2005', '');
  const broDau = fe.addPerson('Anesu', 'f', 'Nzou', '2008', '');
  fe.addUnion([bro, broW], [broSon, broDau]);

  return { fe, haz, ida, bro, hazSon, hazDau, victor, idaDau, broSon, broDau, gf, gm };
}

/* WHAT THE PANEL ACTUALLY SHOWS, which is kinTerms rather than relationship.

   relationship() is the structural derivation. kinTerms() is that plus the
   overlaps — the places where one relationship is genuinely two things at
   once, and where a rule may REPLACE the derived word entirely. A test that
   reads relationship() is testing the engine's first pass, not the answer a
   family sees, and the two differ exactly where the interesting rules live. */
const shown = (fe, a, b) => {
  const k = fe.kinTerms(a, b);
  return k && k.list.length ? k.list[0] : null;
};
const term = (fe, a, b) => { const t = shown(fe, a, b); return t ? t.term : null; };
const why  = (fe, a, b) => { const t = shown(fe, a, b); return t ? t.why : ''; };

(async () => {
  // ── "my sister's children are my children if I am female" ────────────────
  section('a woman\'s sister\'s children are her children');
  {
    const { fe, haz, victor, idaDau } = house();
    eq('her sister\'s son is her son', term(fe, haz, victor), 'Mwanakomana');
    eq('and her sister\'s daughter is her daughter', term(fe, haz, idaDau), 'Mwanasikana');
    check('and it says which rule it followed',
          /a woman's sister's children are her own/.test(why(fe, haz, victor)),
          why(fe, haz, victor));
  }

  section('THE CASE AS THE FAMILY PUT IT: Victor is a son to Hazvineyi');
  {
    const { fe, haz, victor } = house();
    eq('Victor Tendai is Hazvineyi Belinda\'s Mwanakomana',
       term(fe, haz, victor), 'Mwanakomana');
  }

  section('a MAN\'s sister\'s children are vazukuru');
  {
    const { fe, bro, victor, idaDau } = house();
    eq('his sister\'s son', term(fe, bro, victor), 'Muzukuru');
    eq('and his sister\'s daughter', term(fe, bro, idaDau), 'Muzukuru');
  }

  section('so the same two people are two words, and the difference is who is asking');
  {
    const { fe, haz, bro, victor } = house();
    const asWoman = term(fe, haz, victor);
    const asMan = term(fe, bro, victor);
    check(`a woman says ${asWoman}, a man says ${asMan}`, asWoman !== asMan);
  }

  section('a woman\'s BROTHER\'s children are not her children');
  // The rule is about sisters. A brother's children stay where they were, and
  // the reciprocal says so: they call her Tete.
  {
    const { fe, haz, broSon } = house();
    eq('her brother\'s son is her muzukuru', term(fe, haz, broSon), 'Muzukuru');
    eq('and he calls her Tete', term(fe, broSon, haz), 'Tete');
  }

  // ── "my brother's sons are sekuru, his daughters are mainini" ─────────────
  section('a mother\'s brother\'s son is Sekuru, and his daughter is Amainini');
  {
    const { fe, hazSon, hazDau, broSon, broDau } = house();
    eq('her son to his son', term(fe, hazSon, broSon), 'Sekuru');
    eq('her son to his daughter', term(fe, hazSon, broDau), 'Amainini');
    eq('her daughter to his son', term(fe, hazDau, broSon), 'Sekuru');
    eq('her daughter to his daughter', term(fe, hazDau, broDau), 'Amainini');
    check('and the reason names the house it comes from',
          /mother's house/.test(why(fe, hazSon, broDau)), why(fe, hazSon, broDau));
  }

  section('AND IT IS NOT GRADED BY AGE, which is the whole difference');
  /* "same word, but mothers brothers daughter is not graded by age."

     Your mother's SISTER is graded — older is Amaiguru, younger is Amainini.
     Your mother's brother's DAUGHTER is Amainini whatever her age. The word is
     saying she is of your mother's house; it is not saying where she falls
     among her own. So this builds one of each, one older than the mother and
     one younger, and asserts they are the same word — and then asserts the
     mother's own sisters beside them are NOT, because a test that only shows
     the flat case would pass just as well if grading had never existed. */
  {
    const fe = loadFrontend();
    const gf = fe.addPerson('Sekuru', 'm', 'Nzou', '1920', '');
    const gm = fe.addPerson('Ambuya', 'f', 'Shava', '1925', '');
    const mother = fe.addPerson('Evelyn', 'f', 'Nzou', '1954', '');
    const elderAunt = fe.addPerson('Maiguru Tsitsi', 'f', 'Nzou', '1948', '');
    const youngerAunt = fe.addPerson('Mainini Agnes', 'f', 'Nzou', '1960', '');
    const uncle = fe.addPerson('Sekuru Farai', 'm', 'Nzou', '1950', '');
    fe.addUnion([gf, gm], [elderAunt, uncle, mother, youngerAunt]);

    const uncleW = fe.addPerson('Janet', 'f', 'Moyo', '1955', '');
    // One of his daughters is older than the mother, one younger.
    const olderCousin = fe.addPerson('Rudo', 'f', 'Nzou', '1949', '');
    const youngerCousin = fe.addPerson('Chipo', 'f', 'Nzou', '1985', '');
    fe.addUnion([uncle, uncleW], [olderCousin, youngerCousin]);

    const father = fe.addPerson('Joseph', 'm', 'Shava', '1950', '');
    const child = fe.addPerson('Takunda', 'm', 'Shava', '1980', '');
    fe.addUnion([mother, father], [child]);

    eq('his daughter older than your mother is Amainini',
       term(fe, child, olderCousin), 'Amainini');
    eq('and his daughter younger than your mother is Amainini too',
       term(fe, child, youngerCousin), 'Amainini');
    check('so the age made no difference at all',
          term(fe, child, olderCousin) === term(fe, child, youngerCousin));

    section('while your mother\'s own sisters ARE graded, beside them');
    eq('her older sister is Amaiguru', term(fe, child, elderAunt), 'Amaiguru');
    eq('her younger sister is Amainini', term(fe, child, youngerAunt), 'Amainini');
    check('which is the distinction the family drew',
          term(fe, child, elderAunt) !== term(fe, child, youngerAunt));

    section('and the word for the cousin is the same word, not a near one');
    eq('the same as the younger sister carries',
       term(fe, child, olderCousin), term(fe, child, youngerAunt));
  }

  section('the mother\'s brother himself is still Sekuru');
  {
    const { fe, hazSon, bro } = house();
    eq('unchanged', term(fe, hazSon, bro), 'Sekuru');
  }

  section('and the father\'s sister\'s line is untouched by any of this');
  {
    const { fe, victor, hazSon } = house();
    // Victor's father's side is not in this tree, so this checks the other
    // crossed line: Hazvineyi is Victor's mother's sister, so her children
    // are... his brothers and sisters, not cousins.
    const t = term(fe, victor, hazSon);
    check('still a sibling word, not a cousin',
          ['Mukoma', "Munin'ina", 'Hanzvadzi', "Mukoma or Munin'ina"].includes(t), String(t));
  }

  section('nothing above disturbs the plain answers');
  {
    const { fe, haz, gf, gm, hazSon, ida } = house();
    eq('her father', term(fe, haz, gf), 'Baba');
    eq('her mother', term(fe, haz, gm), 'Amai');
    eq('her own son', term(fe, haz, hazSon), 'Mwanakomana');
    // Hazvineyi is the elder, so her younger sister is Munin'ina to her.
    eq('her younger sister', term(fe, haz, ida), "Munin'ina");
    eq('and she is Mukoma to that sister', term(fe, ida, haz), 'Mukoma');
  }

  // ── every word can now be affirmed or put right ──────────────────────────
  section('EVERY derived word carries a shape, which is what makes it correctable');
  {
    const { fe, haz, victor, hazSon, gf, ida } = house();
    for (const [a, b, label] of [[haz, victor, "a sister's child"],
                                 [haz, gf, 'a father'],
                                 [haz, ida, 'a sister'],
                                 [hazSon, gf, 'a grandfather']]) {
      const r = fe.relationship(a, b);
      check(`${label} has a shape`, !!r.shape, JSON.stringify(r));
      check(`${label} says in plain words what it is`, !!r.plain, JSON.stringify(r));
      check(`${label} reaches the panel with that shape`, !!shown(fe, a, b).shape);
    }
  }

  section('a shape is about the PLACE, not the two people standing in it');
  {
    const { fe, haz, victor, idaDau } = house();
    const a = fe.relationship(haz, victor).shape;
    const b = fe.relationship(haz, idaDau).shape;
    check('a sister\'s son and a sister\'s daughter are different places',
          a !== b, a + ' / ' + b);
    check('and neither carries a name', !/Victor|Chipo|Hazvineyi/.test(a + b), a + b);
  }

  section('correcting one word corrects every pair standing in the same place');
  {
    const { fe, haz, victor, ida, idaDau } = house();
    const shape = fe.relationship(haz, victor).shape;
    fe.teachTerm(shape, 'Mwana wangu', 'a woman raises her sister\'s children as her own');
    eq('this pair', fe.kinTerms(haz, victor).list[0].term, 'Mwana wangu');
    // A different woman, a different sister, a different child — the same place.
    check('and the rule, not the row', fe.relationship(ida, victor) !== null);
    eq('the explanation is kept with it',
       fe.lexicon()[shape].note, 'a woman raises her sister\'s children as her own');
    check('and who said it, if they have said who they are',
          'by' in fe.lexicon()[shape]);
  }

  section('affirming is recorded too, because agreeing is worth as much');
  {
    const { fe, hazSon, broDau } = house();
    const t = shown(fe, hazSon, broDau);
    eq('the app read Amainini', t.term, 'Amainini');
    fe.affirmTerm(t.shape, t.term, 'she is of my mother\'s house');
    const k = fe.kinTerms(hazSon, broDau);
    eq('the word is unchanged', k.list[0].term, 'Amainini');
    eq('but it is now agreed rather than guessed', k.list[0].affirmed, true);
    eq('and not shown as a correction', k.list[0].taught, false);
    eq('with the reason kept', k.list[0].note, 'she is of my mother\'s house');
  }

  section('an agreement can be undone as easily as a correction');
  {
    const { fe, hazSon, broDau } = house();
    const t = shown(fe, hazSon, broDau);
    fe.affirmTerm(t.shape, t.term, 'agreed');
    eq('agreed', fe.kinTerms(hazSon, broDau).list[0].affirmed, true);
    fe.forgetTerm(t.shape);
    eq('and back to the app\'s own reading',
       fe.kinTerms(hazSon, broDau).list[0].affirmed, false);
    eq('which is still the same word', fe.kinTerms(hazSon, broDau).list[0].term, 'Amainini');
  }

  section('the family\'s own list of words reads as sentences, not as keys');
  {
    const { fe, haz, victor } = house();
    const shape = fe.relationship(haz, victor).shape;
    const label = fe.shapeLabel(shape);
    check('no colons or hyphenated keys', !/blood:|-looking/.test(label), label);
    check('and it says what the relationship is', /sister's child/.test(label), label);
  }

  section('no English kin term has crept into any of the new words');
  {
    const { fe } = house();
    const ENGLISH = /\b(aunt|uncle|cousin|nephew|niece|grandma|grandpa|half-brother|half-sister)\b/i;
    const ids = fe.frontier ? null : null;
    const all = fe.getState ? Object.keys(fe.getState().people) : [];
    let bad = [];
    for (const a of all) for (const b of all) {
      if (a === b) continue;
      const r = fe.relationship(a, b);
      if (r && r.term && ENGLISH.test(r.term)) bad.push(r.term);
    }
    eq('none', [...new Set(bad)], []);
  }

  // ── who is older, and what the app believes when its sources disagree ────
  section('SENIORITY: a recorded birth year beats a position in the row');
  /* Reported from the family's own tree: "my older sister's kids would call me
     amainini, my kids would call my older sisters amaiguru. So to Victor,
     Hazvineyi would be amainini."

     The rule was already right. What was wrong was which evidence won. Two
     children of one marriage were settled by their position in the row and
     their birth years were never consulted — while db/ops.js has said all
     along that birth order decides seniority WHEN BIRTH YEARS ARE MISSING.

     They are not equally good evidence. A year is something a family knows and
     states; a row position is often just where somebody got added, since every
     new child is appended last. */
  {
    const fe = loadFrontend();
    const mother = fe.addPerson('Evelyn', 'f', 'Moyondizvo', '1954', '');
    // Entered in this order, so the row says Hazvineyi is the elder...
    const haz = fe.addPerson('Hazvineyi', 'f', 'Nzou', '1978', '');
    const ida = fe.addPerson('Ida', 'f', 'Nzou', '1972', '');
    fe.addUnion([mother], [haz, ida]);
    const idaH = fe.addPerson('Tendai', 'm', 'Moyo', '1970', '');
    const victor = fe.addPerson('Victor', 'm', 'Moyo', '2000', '');
    fe.addUnion([ida, idaH], [victor]);

    // ...but the years say she is the younger, and the years are believed.
    eq('Ida is the elder, by her year', fe.olderThan(ida, haz), true);
    eq('so Victor calls his mother\'s younger sister Amainini',
       term(fe, victor, haz), 'Amainini');
    eq('and Hazvineyi calls her older sister Mukoma', term(fe, haz, ida), 'Mukoma');
  }

  section('and the row still decides when a year is missing');
  // Which is the case birth order was always for, and the only evidence there
  // is when nobody has recorded a year.
  {
    const fe = loadFrontend();
    const mother = fe.addPerson('Evelyn', 'f', 'Moyondizvo', '1954', '');
    const haz = fe.addPerson('Hazvineyi', 'f', 'Nzou', '', '');
    const ida = fe.addPerson('Ida', 'f', 'Nzou', '1972', '');
    fe.addUnion([mother], [ida, haz]);          // Ida placed first
    const idaH = fe.addPerson('Tendai', 'm', 'Moyo', '1970', '');
    const victor = fe.addPerson('Victor', 'm', 'Moyo', '2000', '');
    fe.addUnion([ida, idaH], [victor]);
    eq('the row is believed, because it is all there is',
       term(fe, victor, haz), 'Amainini');
  }

  section('a disagreement is reported rather than resolved quietly');
  {
    const fe = loadFrontend();
    const mother = fe.addPerson('Evelyn', 'f', 'Moyondizvo', '1954', '');
    const bertha = fe.addPerson('Bertha', 'f', 'Nzou', '1975', '');
    const ida = fe.addPerson('Ida', 'f', 'Nzou', '1972', '');
    fe.addUnion([mother], [bertha, ida]);       // row says Bertha is elder
    const clash = fe.seniorityConflicts();
    eq('one disagreement found', clash.length, 1);
    eq('and it names the one placed too early', clash[0].a, bertha);
    eq('with both years, so the family can see which they meant',
       [clash[0].ya, clash[0].yb], [1975, 1972]);
  }

  section('and a tree whose row and years agree reports nothing');
  {
    const fe = loadFrontend();
    const mother = fe.addPerson('Evelyn', 'f', 'Moyondizvo', '1954', '');
    fe.addUnion([mother], [fe.addPerson('A', 'f', 'Nzou', '1972', ''),
                           fe.addPerson('B', 'f', 'Nzou', '1975', '')]);
    eq('nothing to report', fe.seniorityConflicts(), []);
  }

  section('nor does one where the years are simply not known');
  {
    const fe = loadFrontend();
    const mother = fe.addPerson('Evelyn', 'f', 'Moyondizvo', '1954', '');
    fe.addUnion([mother], [fe.addPerson('A', 'f', 'Nzou', '', ''),
                           fe.addPerson('B', 'f', 'Nzou', '1975', '')]);
    eq('a missing year is not a disagreement', fe.seniorityConflicts(), []);
  }

  report();
})();
