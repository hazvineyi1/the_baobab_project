// The four cousin tables, row by row.
//
// WHERE THESE COME FROM. The family handed this project a written table — the
// maternal and paternal cousins of a girl and of a boy, in Shona, with the
// English gloss beside each word. Every row below is one row of that table.
// Nothing here was reasoned out from the shape of the system; where the table
// says a word, the word is what is asserted.
//
// WHY IT IS WORTH A FILE OF ITS OWN. These sixteen rows are where a kinship
// engine is either right or quietly wrong, because they are the ones English
// flattens: "cousin" covers all of them, and Shona has five different answers
// depending on which parent's side, that parent's sex, the cousin's sex, and
// who is older. An engine can get every parent and grandparent right and still
// be wrong about every single one of these.
//
// ONE THING IN THE TABLE IS NOT ASSERTED AS WRITTEN, and it is flagged rather
// than silently corrected. In "Paternal cousins of a girl" the two graded rows
// read:
//
//   Daughter of fathers brother, if YOUNGER    mukoma - old sister
//   Daughter of fathers brother, if OLDER      munun'una - young sister
//
// The English column and the gloss contradict each other, and they cannot both
// be meant: mukoma is the older and munun'una the younger, which every other
// table here agrees on and which the glossary the family sent with it states
// outright ("Mukoma: Older brother or older same-sex sibling"). So those two
// rows are read by their glosses, which makes them identical to the other three
// tables. If the family means something else by them, this is the comment that
// says where to change it.

const { check, eq, section, report, loadFrontend } = require('./helpers');

/* One family holding every cousin the tables name.
 *
 *          Sekuru Chenjerai ═ Ambuya Rufaro        Sekuru Tafara ═ Ambuya Nyasha
 *            (father's side)                          (mother's side)
 *                  │                                        │
 *        ┌─────────┴──────────┐                  ┌───────────┴─────────┐
 *      FATHER   father's br  father's sis      MOTHER  mother's sis  mother's br
 *        ║        (Tonde)      (Chipo)           ║       (Rudo)        (Farai)
 *        ╚════════════╗                          ║
 *                     ╚══════════════════════════╝
 *                                │
 *                       ┌────────┴────────┐
 *                     GIRL              BOY          ← the two people looking
 *
 * Every uncle and aunt has a son and a daughter, and the graded ones have one
 * of each age, because a row that only tests the older case passes just as
 * well when seniority has been dropped altogether.
 */
function house() {
  const fe = loadFrontend();
  const P = (n, s, b) => fe.addPerson(n, s, 'Nzou', String(b), '');

  // The two grandparents' houses.
  const pgf = P('Chenjerai', 'm', 1920), pgm = P('Rufaro', 'f', 1925);
  const mgf = P('Tafara',   'm', 1922), mgm = P('Nyasha', 'f', 1928);

  const father = P('Baba Simba', 'm', 1950);
  const fbro   = P('Tonde',      'm', 1948);      // father's brother
  const fsis   = P('Chipo',      'f', 1955);      // father's sister
  fe.addUnion([pgf, pgm], [fbro, father, fsis]);

  const mother = P('Amai Tsitsi', 'f', 1952);
  const msis   = P('Rudo',        'f', 1949);     // mother's sister
  const mbro   = P('Farai',       'm', 1957);     // mother's brother
  fe.addUnion([mgf, mgm], [msis, mother, mbro]);

  // The two people doing the looking.
  const girl = P('Tendai', 'f', 1980);
  const boy  = P('Tapiwa', 'm', 1982);
  fe.addUnion([father, mother], [girl, boy]);

  // Every cousin the tables name. Older ones born before 1980, younger after,
  // so both are older/younger than BOTH the girl and the boy.
  const kids = (parent, spouseSex, tag) => {
    const spouse = P('Spouse of ' + tag, spouseSex, 1950);
    const sonOld  = P(tag + ' son older',    'm', 1975);
    const sonYng  = P(tag + ' son younger',  'm', 1990);
    const dauOld  = P(tag + ' daughter older',   'f', 1974);
    const dauYng  = P(tag + ' daughter younger', 'f', 1991);
    fe.addUnion([parent, spouse], [dauOld, sonOld, sonYng, dauYng]);
    return { sonOld, sonYng, dauOld, dauYng };
  };

  return {
    fe, girl, boy, father, mother, fbro, fsis, msis, mbro,
    pgf, pgm, mgf, mgm,
    ofMotherSister:  kids(msis, 'm', 'mothers-sister'),
    ofMotherBrother: kids(mbro, 'f', 'mothers-brother'),
    ofFatherBrother: kids(fbro, 'f', 'fathers-brother'),
    ofFatherSister:  kids(fsis, 'm', 'fathers-sister')
  };
}

const h = house();
const term = (from, to) => {
  const k = h.fe.kinTerms(from, to);
  return k && k.list.length ? k.list.map(t => t.term) : [];
};
// A row of the table passes if the word it names is among the words the app
// gives. Several at once is ordinary here — a person is often two things —
// and a table row is an assertion that its word is one of them, not that it
// is the only one.
const says = (from, to, want, label) => {
  const got = term(from, to);
  check(label, got.includes(want), `wanted ${want}, got ${got.join(' + ') || 'nothing'}`);
};

// ── the uncles and aunts themselves, since the cousins hang off them ───────
section('the parent generation, from the glossary');
says(h.girl, h.father, 'Baba', "father is Baba");
says(h.girl, h.mother, 'Amai', "mother is Amai");
says(h.girl, h.fbro,  'Babamukuru', "father's older brother is Babamukuru");
says(h.girl, h.fsis,  'Tete',       "father's sister is Tete");
says(h.girl, h.msis,  'Amaiguru',   "mother's older sister is Amaiguru");
says(h.girl, h.mbro,  'Sekuru',     "mother's brother is Sekuru");
says(h.girl, h.pgf,   'Sekuru',     'father\'s father is Sekuru');
says(h.girl, h.pgm,   'Ambuya',     'father\'s mother is Ambuya');

section("and the younger ones, which are different words entirely");
{
  const fe = loadFrontend();
  const gf = fe.addPerson('Gf', 'm', 'Nzou', '1920', '');
  const gm = fe.addPerson('Gm', 'f', 'Nzou', '1925', '');
  const dad = fe.addPerson('Dad', 'm', 'Nzou', '1950', '');
  const mum = fe.addPerson('Mum', 'f', 'Shava', '1952', '');
  const dadYoungerBro = fe.addPerson('Uncle', 'm', 'Nzou', '1960', '');
  fe.addUnion([gf, gm], [dad, dadYoungerBro]);
  const mgf = fe.addPerson('Mgf', 'm', 'Shava', '1922', '');
  const mgm = fe.addPerson('Mgm', 'f', 'Shava', '1926', '');
  const mumYoungerSis = fe.addPerson('Aunt', 'f', 'Shava', '1962', '');
  fe.addUnion([mgf, mgm], [mum, mumYoungerSis]);
  const me = fe.addPerson('Me', 'f', 'Nzou', '1980', '');
  fe.addUnion([dad, mum], [me]);
  const t = (a, b) => (fe.kinTerms(a, b).list[0] || {}).term;
  eq("father's younger brother is Babamunini", t(me, dadYoungerBro), 'Babamunini');
  eq("mother's younger sister is Amainini",    t(me, mumYoungerSis), 'Amainini');
}

// ── MATERNAL COUSINS OF A GIRL ────────────────────────────────────────────
section('Maternal cousins of a girl');
says(h.girl, h.ofMotherSister.dauOld,  'Mukoma',
     "daughter of mother's sister, if older — mukoma");
says(h.girl, h.ofMotherSister.dauYng,  "Munin'ina",
     "daughter of mother's sister, if younger — munun'una");
says(h.girl, h.ofMotherSister.sonOld,  'Hanzvadzi',
     "son of mother's sister — hanzvadzi");
says(h.girl, h.ofMotherBrother.sonOld, 'Sekuru',
     "son of mother's brother — sekuru");
says(h.girl, h.ofMotherBrother.dauOld, 'Amainini',
     "daughter of mother's brother — mainini or amainini");

section("and that last one is NOT graded by age, which is the whole of what makes it different");
// The family said so in as many words: "same word, but mothers brothers
// daughter is not graded by age." Her mother's sister's daughters are Mukoma
// or Munin'ina depending on who is older; her mother's brother's daughters are
// Amainini whether they are older or younger.
says(h.girl, h.ofMotherBrother.dauYng, 'Amainini',
     "the younger one is Amainini too");
check("and neither is called older or younger",
      !term(h.girl, h.ofMotherBrother.dauOld).some(t => /Mukoma|Munin/.test(t)) &&
      !term(h.girl, h.ofMotherBrother.dauYng).some(t => /Mukoma|Munin/.test(t)),
      term(h.girl, h.ofMotherBrother.dauOld).join(' + ') + ' / ' +
      term(h.girl, h.ofMotherBrother.dauYng).join(' + '));

// ── MATERNAL COUSINS OF A BOY ─────────────────────────────────────────────
section('Maternal cousins of a boy');
says(h.boy, h.ofMotherSister.sonOld,  'Mukoma',
     "son of mother's sister, if older — mukoma");
says(h.boy, h.ofMotherSister.sonYng,  "Munin'ina",
     "son of mother's sister, if younger — munun'una");
says(h.boy, h.ofMotherSister.dauOld,  'Hanzvadzi',
     "daughter of mother's sister — hanzvadzi");
says(h.boy, h.ofMotherBrother.sonOld, 'Sekuru',
     "son of mother's brother — sekuru");
says(h.boy, h.ofMotherBrother.dauOld, 'Amainini',
     "daughter of mother's brother — mainini or amainini");

// ── PATERNAL COUSINS OF A GIRL ────────────────────────────────────────────
section('Paternal cousins of a girl');
// Read by the glosses, not by the English column — see the header.
says(h.girl, h.ofFatherBrother.dauOld, 'Mukoma',
     "daughter of father's brother, older — mukoma (old sister)");
says(h.girl, h.ofFatherBrother.dauYng, "Munin'ina",
     "daughter of father's brother, younger — munun'una (young sister)");
says(h.girl, h.ofFatherBrother.sonOld, 'Hanzvadzi',
     "sons of father's brother — hanzvadzi");
says(h.girl, h.ofFatherSister.sonOld,  'Mwanakomana',
     "son of father's sister — mwana (son)");
says(h.girl, h.ofFatherSister.dauOld,  'Mwanasikana',
     "daughter of father's sister — mwana (daughter)");

// ── PATERNAL COUSINS OF A BOY ─────────────────────────────────────────────
section('Paternal cousins of a boy');
says(h.boy, h.ofFatherBrother.sonOld, 'Mukoma',
     "son of father's brother, if older — mukoma");
says(h.boy, h.ofFatherBrother.sonYng, "Munin'ina",
     "son of father's brother, if younger — munun'una");
says(h.boy, h.ofFatherBrother.dauOld, 'Hanzvadzi',
     "daughter of father's brother — hanzvadzi");

section("and a father's sister's child is NOT a boy's child — the tables stop before this row");
/* The paternal table for a boy lists three rows and stops; it does not say
   what a man calls his father's sister's children. The family DID say, in the
   sentence this app was built from: "My sisters children are my children if i
   am female, if i am male they are vazukuru." So the woman's row above and
   this one are the same rule seen from its two sides, and neither was guessed. */
says(h.boy, h.ofFatherSister.sonOld, 'Muzukuru',
     "to a man they are Muzukuru");

// ── the words that come back the other way ────────────────────────────────
/* ── THE WORDS THAT COME BACK ──────────────────────────────────────────────
   Shona terms are not reciprocal, and these four are the proof. Each was
   written the wrong way round first, by reasoning from the word instead of
   from the tables, and each time the tables were right:

   * She calls her mother's brother's daughter AMAININI — a young mother. So
     the word coming back is not Muzukuru but MWANASIKANA: if the woman is a
     mother to her, she is a daughter to the woman.

   * She calls her father's sister's son MWANAKOMANA — her child. And he calls
     her AMAININI, not Amai, because from where he stands she is his mother's
     brother's daughter, and that row of his own table says Amainini. Mwana
     against Amainini looks lopsided and is not: both tables say it, and the
     pair is still mother-and-child, graded.

   * Tete's word for her brother's daughter is MUZUKURU, not Mwanasikana. The
     rule the family gave is "my sisterS children are my children if i am
     female" — her brother's children are not that, and the family said so
     directly: "My brothers son is my muzukuru, but i am being identified as
     his ancestor instead of his tete." */
section('and the words that come back — Shona terms are not reciprocal');
says(h.ofMotherBrother.dauOld, h.girl, 'Mwanasikana',
     "the Amainini's word for her is Mwanasikana, not Muzukuru");
says(h.ofFatherSister.sonOld, h.girl, 'Amainini',
     "her child by one table is her Amainini by his own — and both tables say so");
says(h.mbro, h.girl, 'Muzukuru', "Sekuru's word for her is Muzukuru");
says(h.fsis, h.girl, 'Muzukuru',
     "Tete's word for her BROTHER's daughter is Muzukuru — the sister's-children " +
     'rule is about sisters');
check("and she is Tete to her, which is the pair that matters",
      term(h.girl, h.fsis).includes('Tete'), term(h.girl, h.fsis).join(' + '));

/* ── THE IN-LAWS, from the glossary ────────────────────────────────────────
   Four words the family's list names outright, and one it deliberately does
   not. Each of these was DESCRIBED rather than named until the list arrived —
   the app said "your wife's Baba" and offered to be told the word. It has now
   been told. */
section('the words for people married in, or married to');
{
  const fe = loadFrontend();
  const P = (n, s, b) => fe.addPerson(n, s, 'Nzou', String(b), '');
  const hisDad = P('His father', 'm', 1930), hisMum = P('His mother', 'f', 1935);
  const man = P('Man', 'm', 1960), manBro = P("Man's brother", 'm', 1958),
        manSis = P("Man's sister", 'f', 1965);
  fe.addUnion([hisDad, hisMum], [manBro, man, manSis]);
  const herDad = P('Her father', 'm', 1932), herMum = P('Her mother', 'f', 1938);
  const woman = P('Woman', 'f', 1962), womanBro = P("Woman's brother", 'm', 1959);
  fe.addUnion([herDad, herMum], [womanBro, woman]);
  fe.addUnion([man, woman], []);
  const broWife = P("Brother's wife", 'f', 1961);
  fe.addUnion([manBro, broWife], []);
  const herBroWife = P("Her brother's wife", 'f', 1963);
  fe.addUnion([womanBro, herBroWife], []);
  const sisHusband = P("Sister's husband", 'm', 1964);
  fe.addUnion([manSis, sisHusband], []);

  const w = (a, b) => { const k = fe.kinTerms(a, b);
                        return k && k.list.length ? k.list.map(t => t.term) : []; };
  const has = (a, b, want, label) =>
    check(label, w(a, b).includes(want),
          `wanted ${want}, got ${w(a, b).join(' + ') || 'nothing'}`);

  has(man,   herDad, 'Tezvara', "a man's wife's father is Tezvara");
  has(man,   herMum, 'Ambuya',  "and her mother is Ambuya");
  has(woman, hisDad, 'Tezvara', "a woman's husband's father is Tezvara too");
  has(woman, hisMum, 'Ambuya',  'and his mother is Ambuya');

  section("and it is the FATHER, not anybody standing in a father's place");
  // The one way a rule like this goes wrong is by being generous about what
  // counts as a parent. Her father's older brother is Babamukuru to her and a
  // different man entirely.
  const herUncle = P("Her father's brother", 'm', 1928);
  const hgf = P('Her grandfather', 'm', 1900), hgm = P('Her grandmother', 'f', 1905);
  fe.addUnion([hgf, hgm], [herUncle, herDad]);
  check('her Babamukuru is not his Tezvara', !w(man, herUncle).includes('Tezvara'),
        w(man, herUncle).join(' + ') || 'described, not named');

  section("Muroora is one word for what English calls two relations");
  has(hisDad, woman,      'Muroora', "a son's wife is Muroora");
  has(man,    broWife,    'Muroora', "and a brother's wife is Muroora — the same word");
  has(woman,  herBroWife, 'Muroora', 'to a woman as much as to a man');
  has(herDad, man,        'Mukwasha', "a daughter's husband is Mukwasha");

  section("and a sister's husband is left DESCRIBED, because the list does not name him");
  /* The mirror image of the brother's wife, and the family's list stops
     before it. Inventing a word here would be the one thing this app must
     never do — it would be indistinguishable, on screen, from a word the
     family actually uses. */
  eq('no word invented for him', w(man, sisHusband), []);
  const gap = fe.kinTerms(man, sisHusband);
  // Described in the family's own terms rather than translated back into
  // English: "the husband of your Hanzvadzi" says exactly which relation is
  // missing a word, which is what the family is being asked about.
  check('but the app says what he is', /husband of your Hanzvadzi/.test(gap.base.plain || ''),
        gap.base.plain || '(nothing)');
  check('and has a shape to be taught one against', !!gap.base.shape, gap.base.shape);
}

/* ── THE WORD ON THE CARD ──────────────────────────────────────────────────
   What all of the above is for. Every card in the tree carries what to call
   that person, reckoned from whoever is picked — so the tables above are not
   something to be looked up, they are what the screen says. */
section('every card says what to call that person, from wherever you are standing');
{
  const t = (anchor, id) => {
    const html = h.fe.titleFor(anchor, id);
    const m = html.match(/>([^<]+)</);
    return m ? m[1] : '';
  };
  h.fe.setMe(h.girl);
  eq("her father's card says Baba",        t(h.girl, h.father), 'Baba');
  eq("her mother's brother's says Sekuru", t(h.girl, h.mbro),   'Sekuru');
  eq("her father's sister's says Tete",    t(h.girl, h.fsis),   'Tete');

  section('and picking somebody else repaints every card in THEIR words');
  // The same two people, the same tree, and a different word — which is the
  // whole of why a family tree in Shona cannot be drawn once and read by
  // everybody.
  eq('from the girl, her mother is Amai',   t(h.girl, h.mother), 'Amai');
  eq('from the boy, the same woman is Amai', t(h.boy, h.mother), 'Amai');
  eq('but from her mother, the girl is Mwanasikana',
     t(h.mother, h.girl), 'Mwanasikana');
  eq('and from her mother, the BOY is Mwanakomana',
     t(h.mother, h.boy), 'Mwanakomana');
  eq("from the girl, her mother's sister's daughter is Mukoma",
     t(h.girl, h.ofMotherSister.dauOld), 'Mukoma');
  // The same pair, the other way round — and a DIFFERENT word, which is what
  // makes a Shona family tree impossible to draw once and read by everybody.
  // This also caught the cache: keyed by the person being named rather than by
  // the pair, it answered this with the word from the previous vantage.
  eq('while from that same cousin, the girl is the younger one',
     t(h.ofMotherSister.dauOld, h.girl), "Munin'ina");

  section('the card everything is reckoned FROM says so, in words');
  check('yours says so when it is you',
        /Your words/.test(h.fe.titleFor(h.girl, h.girl)),
        h.fe.titleFor(h.girl, h.girl));
  check('and names them when it is somebody else',
        /Tendai's words/.test(h.fe.titleFor(h.girl, h.girl)) === false &&
        /Amai Tsitsi's words|Amai's words/.test(h.fe.titleFor(h.mother, h.mother)),
        h.fe.titleFor(h.mother, h.mother));

  section('a pair with no word yet is left blank rather than labelled');
  // "Not named yet" on every second card would be the crowding this replaced.
  // The card behind the ⋯ and the line between two people both say what is
  // missing, when somebody actually asks.
  const stranger = h.fe.addPerson('Nobody Related', 'f', 'Shava', '1990', '');
  eq('nothing at all', h.fe.titleFor(h.girl, stranger), '');

  section('several words at once are counted, not hidden');
  // A person is often two things. The card shows the first and says how many
  // more there are; the card and the kinship panel list them.
  const many = h.fe.kinTerms(h.girl, h.fsis);
  if (many.list.length > 1){
    check('the extra ones are marked', /<em>\+\d<\/em>/.test(h.fe.titleFor(h.girl, h.fsis)),
          h.fe.titleFor(h.girl, h.fsis));
  } else {
    check('this pair has one word, so nothing to count', true);
  }
}

section('and the stamp notices every fact a word can turn on');
{
  const fe = loadFrontend();
  const a = fe.addPerson('A', 'f', 'Nzou', '1970', '');
  const b = fe.addPerson('B', 'm', 'Nzou', '1975', '');
  const before = fe.treeStamp();
  check('a fresh look at the same tree is the same stamp', fe.treeStamp() === before);
  fe.getState().people[b].sex = 'f';
  check('changing a sex changes it — Hanzvadzi turns into Munin\'ina',
        fe.treeStamp() !== before);
  const withSex = fe.treeStamp();
  fe.getState().people[b].born = '1960';
  check('so does a birth year — Munin\'ina turns into Mukoma',
        fe.treeStamp() !== withSex);
  const withYear = fe.treeStamp();
  fe.addUnion([a, b], []);
  check('and so does a marriage', fe.treeStamp() !== withYear);
  const withUnion = fe.treeStamp();
  fe.teachTerm('blood:sibling-older:woman-looking:woman', 'Sisi', 'what we say');
  check('and a word this family has taught', fe.treeStamp() !== withUnion);
}

report();
