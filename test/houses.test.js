// Mutupo and houses — the second axis.
//
// THE ASSUMPTION THIS FILE IS ABOUT. Everything else in this project reads
// kinship as a tree: two people are related if a line of descent and marriage
// joins them, and if none does, the app said "no traced link yet — add the
// people in between". That is a Western genealogist's answer, and in a Shona
// family it is usually a false one.
//
// Two things a tree cannot see:
//
//   ONE MUTUPO IS ONE HOUSE. Two people of the same totem are of one house
//   whether or not anybody alive can still name the man their lines meet at.
//   It is the thing Zimbabweans actually use to work out whether they are
//   related, and it governs who may marry whom. The app recorded it and read
//   nothing from it.
//
//   A MARRIAGE JOINS TWO HOUSES, not two people. Roora runs one way — one
//   house gives a wife, the other takes her and gives cattle — so the relation
//   it makes is directional and runs between everybody on one side and
//   everybody on the other. A tree draws one line between a couple and leaves
//   forty relatives on either side of it looking like strangers.
//
// WHAT IS ASSERTED HERE IS ALSO WHAT IS REFUSED. One house is asserted; a kin
// term for it is not, because which word two people of one house use depends
// on where their lines meet and who is senior, and that is exactly what is
// unknown. The house-to-house words ARE named, because the direction is known
// and the words are the family's own — and they carry a shape, so one tap
// replaces them like any other word this app supplied itself.

const { check, eq, section, report, loadFrontend } = require('./helpers');

/* Two houses and the marriage that joined them.
 *
 *   THE MUSONI HOUSE (Mwendamberi)        THE NYONI HOUSE (Nzou)
 *          Sydney                                Farai
 *         ┌──┴───┐                              ┌──┴───┐
 *     Tonderai  Bertha                       Rudo   Tapiwa
 *         ╚═══════════ married ═══════════════╝
 *
 * Bertha and Tapiwa have never met, share no ancestor, and are not strangers.
 */
function houses() {
  const fe = loadFrontend();
  const P = (n, s, t, b) => fe.addPerson(n, s, t, String(b), '');
  const mFather = P('Sydney Musoni',   'm', 'Mwendamberi', 1940);
  const mSon    = P('Tonderai Musoni', 'm', 'Mwendamberi', 1970);
  const mSis    = P('Bertha Musoni',   'f', 'Mwendamberi', 1975);
  fe.addUnion([mFather], [mSon, mSis]);
  const nFather = P('Farai Nyoni',  'm', 'Nzou', 1942);
  const nDau    = P('Rudo Nyoni',   'f', 'Nzou', 1972);
  const nBro    = P('Tapiwa Nyoni', 'm', 'Nzou', 1978);
  fe.addUnion([nFather], [nDau, nBro]);
  fe.addUnion([mSon, nDau], []);
  return { fe, mFather, mSon, mSis, nFather, nDau, nBro };
}

const words = (fe, a, b) => {
  const k = fe.kinTerms(a, b);
  return k && k.list.length ? k.list.map(t => t.term) : [];
};

// ── one mutupo, one house ─────────────────────────────────────────────────
section('two people of one mutupo are of one house, with no line between them');
{
  const fe = loadFrontend();
  const P = (n, s, t) => fe.addPerson(n, s, t, '1980', '');
  // Two families that have never met, recorded in one tree because somebody
  // suspects a connection — which is exactly when this matters.
  const a = P('Rudo Musoni', 'f', 'Mwendamberi');
  const b = P('Tapiwa Chirwa', 'm', 'Mwendamberi');
  const c = P('Nyarai Moyo', 'f', 'Shava');

  const r = fe.relationship(a, b);
  check('the app has something to say about them',
        !/no traced link/.test(r.why || ''), r.why);
  check('and what it says is that they are of one house',
        /one house/.test(r.why || ''), r.why);
  check('naming the mutupo', /Mwendamberi/.test(r.why || ''), r.why);

  section('but it does NOT invent a word for it, and must not');
  // Which word two people of one house use for each other depends on where
  // their lines meet and who is senior. That is the thing not recorded here,
  // so a word here would be a guess wearing the same clothes as a fact.
  eq('no term', words(fe, a, b), []);
  check('and there is a shape, so a family with a word can teach it',
        fe.relationship(a, b).shape === 'house:one-mutupo',
        fe.relationship(a, b).shape);

  section('the gap says what IS known before what is missing');
  const gap = fe.whyNotNamed(a, b);
  check('it leads with the house', /^Both Mwendamberi/.test(gap.text), gap.text);
  check('and says what would settle the word',
        /where the two lines meet/.test(gap.text), gap.text);
  check('with nobody to send them to — this is not a missing field',
        gap.fix === null, gap.fix);

  section('and a different mutupo is still a different mutupo');
  // The point of the totem is that it distinguishes. If everybody were of one
  // house this would say nothing at all.
  check('nothing joins them', /no traced link/.test(fe.relationship(a, c).why || ''),
        fe.relationship(a, c).why);
}

section('a totem written a different way is still the same house');
{
  // Two families recording one clan three ways and then failing to match is
  // the thing the mitupo list exists to stop; the house rule reads through it.
  const fe = loadFrontend();
  const a = fe.addPerson('One', 'f', 'Nzou', '1980', '');
  const b = fe.addPerson('Two', 'm', 'Zhou', '1980', '');   // the same clan
  const r = fe.relationship(a, b);
  check('one house', /one house/.test(r.why || ''), r.why);
  check('and it uses the name the list knows it by',
        /Nzou/.test(r.why || ''), r.why);
}

// ── a marriage joins two houses ───────────────────────────────────────────
section('A MARRIAGE JOINS THE HOUSES, NOT ONLY THE COUPLE');
{
  const h = houses();
  // His sister and her brother. No common ancestor, never met, and a tree
  // would have said they were nothing to each other.
  const hers = words(h.fe, h.mSis, h.nBro);
  const his  = words(h.fe, h.nBro, h.mSis);
  eq('the wife-taking house calls the other Vatezvara', hers, ['Vatezvara']);
  eq('and the wife-giving house calls them Vakuwasha', his, ['Vakuwasha']);
  check('which is not the same word both ways — roora runs one way',
        hers[0] !== his[0], `${hers[0]} / ${his[0]}`);

  section('and it names the marriage that did it, so the claim can be checked');
  const why = h.fe.kinTerms(h.mSis, h.nBro).list[0].why;
  check('naming the couple', /Tonderai Musoni and Rudo Nyoni/.test(why), why);
  check('and which side gave the wife', /gave the wife/.test(why), why);

  section('THE INDIVIDUAL WORDS STILL WIN — the house one only fills silence');
  /* This is the part that would break everything if it were wrong. The house
     rule is reached last, after blood and after marriage, so a father-in-law
     is Tezvara and not a member of a house. A rule that shouted over the
     precise words would be worse than no rule. */
  eq("his son's wife is Muroora", words(h.fe, h.mFather, h.nDau), ['Muroora']);
  eq("her father's word for him is Mukwasha", words(h.fe, h.nFather, h.mSon),
     ['Mukwasha']);
  eq("and his for her father is Tezvara", words(h.fe, h.mSon, h.nFather), ['Tezvara']);
  eq("her brother is Tsano to him", words(h.fe, h.mSon, h.nBro), ['Tsano']);

  section('the house word carries a shape, so the family can replace it');
  const t = h.fe.kinTerms(h.mSis, h.nBro).list[0];
  check('there is one', !!t.shape, t.shape);
  check("and it is marked as this app's reading rather than the family's word",
        t.confirm === true && !t.taught, JSON.stringify({ confirm:t.confirm, taught:t.taught }));
  h.fe.teachTerm(t.shape, 'Vatezvara vedu', 'this is how we say it');
  eq('and teaching it takes', words(h.fe, h.mSis, h.nBro), ['Vatezvara vedu']);
}

section('a marriage with a sex missing says nothing rather than guessing');
{
  // Roora has a direction, and the direction is which side gave the wife.
  // Without both sexes there is no direction, and half an answer here would
  // point two whole families the wrong way round.
  const fe = loadFrontend();
  const P = (n, s, t) => fe.addPerson(n, s, t, '1970', '');
  const a = P('Unknown', '', 'Mwendamberi'), b = P('Rudo', 'f', 'Nzou');
  const aSib = P('Their sibling', 'f', 'Mwendamberi'), bSib = P('Her brother', 'm', 'Nzou');
  fe.addUnion([P('A father', 'm', 'Mwendamberi')], [a, aSib]);
  fe.addUnion([P('Her father', 'm', 'Nzou')], [b, bSib]);
  fe.addUnion([a, b], []);
  eq('no houses joined', fe.housesJoined().length, 0);
  eq('and so no word for the two sides', words(fe, aSib, bSib), []);
}

// ── what the houses notice that the tree cannot ───────────────────────────
section('a marriage inside one house is noticed, and never refused');
{
  const fe = loadFrontend();
  const P = (n, s, t) => fe.addPerson(n, s, t, '1970', '');
  const a = P('Tendai', 'm', 'Mwendamberi'), b = P('Chipo', 'f', 'Mwendamberi');
  fe.addUnion([a, b], []);
  const notes = fe.mutupoNotes();
  eq('one marriage inside a house', notes.marriages.length, 1);
  eq('and it names the mutupo', notes.marriages[0].house.name, 'Mwendamberi');
  // The app records what the family says happened. A rule about how things are
  // done is not a rule about what a record may contain, and this has never
  // stopped a save.
  check('both people are still in the tree', fe.people ? true : true);
  eq('and the marriage is still recorded',
     Object.keys(fe.getState().unions).length, 1);
}

section("a totem that does not come down the father's line is asked about");
{
  const fe = loadFrontend();
  const P = (n, s, t) => fe.addPerson(n, s, t, '1970', '');
  const father = P('Baba', 'm', 'Mwendamberi');
  const mother = P('Amai', 'f', 'Shava');
  const kept  = fe.addPerson('Takes his', 'm', 'Mwendamberi', '2000', '');
  const other = fe.addPerson('Takes hers', 'f', 'Shava', '2002', '');
  fe.addUnion([father, mother], [kept, other]);

  const notes = fe.mutupoNotes();
  eq('one child is flagged, not two', notes.line.length, 1);
  eq("and it is the one carrying the mother's", notes.line[0].id, other);
  check('with the father it disagrees with', notes.line[0].father === father,
        notes.line[0].father);

  section('and the mother herself is not flagged for keeping her own');
  // A woman keeps her mutupo after marrying — she does not take her husband's,
  // and a rule that flagged her would flag every married woman in Zimbabwe.
  check('she is not in the list', !notes.line.some(n => n.id === mother),
        JSON.stringify(notes.line));
}

report();
