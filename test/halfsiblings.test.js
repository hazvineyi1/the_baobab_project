// Brothers and sisters who do not share both parents.
//
// THE BUG THIS IS ABOUT. Adding a sibling attached them to the anchor's own
// mother and father, without asking. In a family with one marriage that is
// right and nobody notices. In a family with two it is wrong, and wrong
// silently — the tree ends up asserting a mother nobody ever named, and the
// assertion looks exactly like something the family said.
//
// Underneath it was worse: the kinship engine could not name a half sibling at
// all. Two children of one father by different mothers came back as unrelated
// — not cousins, not relatives, strangers. For a Shona family that is not a
// small gap. A man's children by two wives are mukoma and munin'ina to each
// other, and the tree had no word for them.
//
// These run the shipped frontend's own functions, in a stubbed DOM, so what is
// asserted is what the page actually does.

const { check, eq, section, report, loadFrontend } = require('./helpers');

/* Sekuru Sydney, two wives, a child by each — the shape in every polygamous
   family and the shape that was being recorded wrongly. */
function twoWives() {
  const fe = loadFrontend();
  const father = fe.addPerson('Sydney Kanzara', 'm', 'Mwendamberi', '1940', '2013');
  const first  = fe.addPerson('Evelyn Mandaba', 'f', 'Moyondizvo', '1954', '');
  const second = fe.addPerson('Rudo Mandaba',   'f', 'Shava',      '1961', '');
  const older  = fe.addPerson('Bertha Dadirai', 'f', 'Mwendamberi', '1975', '');
  const younger= fe.addPerson('Terence Kurauwone', 'm', 'Mwendamberi', '1981', '');
  // addUnion hands back the union itself; these tests want its id.
  const u1 = fe.addUnion([father, first],  [older]).id;
  const u2 = fe.addUnion([father, second], [younger]).id;
  return { fe, father, first, second, older, younger, u1, u2 };
}

const termOf = (fe, a, b) => {
  const r = fe.relationship(a, b);
  return r ? (r.term || null) : null;
};
const whyOf = (fe, a, b) => {
  const r = fe.relationship(a, b);
  return r ? r.why : '';
};

(async () => {
  // ── the kinship gap ──────────────────────────────────────────────────────
  section('a father\'s children by two wives are brother and sister');
  {
    const { fe, older, younger } = twoWives();
    eq('she has a word for him', termOf(fe, older, younger), 'Hanzvadzi');
    eq('and he for her', termOf(fe, younger, older), 'Hanzvadzi');
    check('and it says which parent they share',
          /father Sydney/.test(whyOf(fe, older, younger)), whyOf(fe, older, younger));
    check('and that they are brother and sister rather than cousins',
          /brother or sister/.test(whyOf(fe, older, younger)));
  }

  section('the seniority words work across two marriages');
  // Same sex, so the word depends on who is older. Birth ORDER cannot answer
  // it — they are in different marriages — so it falls to birth years, which
  // is what olderThan already does.
  {
    const fe = loadFrontend();
    const father = fe.addPerson('Sydney', 'm', 'Nzou', '1940', '');
    const w1 = fe.addPerson('Evelyn', 'f', 'Shava', '1954', '');
    const w2 = fe.addPerson('Rudo', 'f', 'Shava', '1961', '');
    const elder   = fe.addPerson('Takunda', 'm', 'Nzou', '1975', '');
    const younger = fe.addPerson('Josiah',  'm', 'Nzou', '1983', '');
    fe.addUnion([father, w1], [elder]);
    fe.addUnion([father, w2], [younger]);
    eq('the younger calls the elder Mukoma', termOf(fe, younger, elder), 'Mukoma');
    eq('and the elder calls the younger Munin\'ina', termOf(fe, elder, younger), "Munin'ina");
  }

  section('with no birth years it says the word is one of two, not nothing');
  {
    const fe = loadFrontend();
    const father = fe.addPerson('Sydney', 'm', 'Nzou', '', '');
    const w1 = fe.addPerson('Evelyn', 'f', 'Shava', '', '');
    const w2 = fe.addPerson('Rudo', 'f', 'Shava', '', '');
    const a = fe.addPerson('Takunda', 'm', 'Nzou', '', '');
    const b = fe.addPerson('Josiah', 'm', 'Nzou', '', '');
    fe.addUnion([father, w1], [a]);
    fe.addUnion([father, w2], [b]);
    const r = fe.relationship(a, b);
    eq('no single word yet', r.term, null);
    eq('but it names both candidates', r.choice, "Mukoma or Munin'ina");
    check('and says a birth year is what is missing', /birth years/.test(r.why));
  }

  section('sharing a MOTHER by different fathers is the same answer');
  {
    const fe = loadFrontend();
    const mother = fe.addPerson('Evelyn', 'f', 'Moyondizvo', '1954', '');
    const h1 = fe.addPerson('Sydney', 'm', 'Nzou', '1940', '');
    const h2 = fe.addPerson('Farai',  'm', 'Shava', '1950', '');
    const a = fe.addPerson('Bertha',  'f', 'Nzou', '1975', '');
    const b = fe.addPerson('Chipo',   'f', 'Shava', '1982', '');
    fe.addUnion([h1, mother], [a]);
    fe.addUnion([h2, mother], [b]);
    eq('older to younger', termOf(fe, a, b), "Munin'ina");
    check('through the mother', /mother Evelyn/.test(whyOf(fe, a, b)), whyOf(fe, a, b));
  }

  section('people who share NO parent are still not siblings');
  // The guard that matters: the check is "a shared partner", so two children
  // of two entirely separate marriages must not be swept in.
  {
    const fe = loadFrontend();
    const a = fe.addPerson('Bertha', 'f', 'Nzou', '1975', '');
    const b = fe.addPerson('Chipo', 'f', 'Shava', '1982', '');
    fe.addUnion([fe.addPerson('X','m','Nzou','1940',''), fe.addPerson('Y','f','Shava','1945','')], [a]);
    fe.addUnion([fe.addPerson('P','m','Nzou','1940',''), fe.addPerson('Q','f','Shava','1945','')], [b]);
    const r = fe.relationship(a, b);
    check('no sibling word between strangers',
          !r || !['Hanzvadzi', 'Mukoma', "Munin'ina"].includes(r.term),
          r ? r.term : 'null');
  }

  section('full siblings are unchanged');
  {
    const fe = loadFrontend();
    const f = fe.addPerson('Sydney', 'm', 'Nzou', '1940', '');
    const m = fe.addPerson('Evelyn', 'f', 'Shava', '1954', '');
    const a = fe.addPerson('Bertha', 'f', 'Nzou', '1975', '');
    const b = fe.addPerson('Terence', 'm', 'Nzou', '1981', '');
    fe.addUnion([f, m], [a, b]);
    eq('still Hanzvadzi', termOf(fe, a, b), 'Hanzvadzi');
    check('and still says so the old way',
          /your (older|younger) brother or sister/.test(whyOf(fe, a, b)), whyOf(fe, a, b));
  }

  // ── the question, instead of the assumption ──────────────────────────────
  section('with parents recorded, a sibling has more than one possible answer');
  {
    const { fe, older, father, second } = twoWives();
    const opts = fe.parentageOptions(older);
    const labels = opts.map(o => o.label);
    check('the first is the marriage she is already in',
          labels[0] === 'Same mother and father', labels.join(' | '));
    check('the father\'s other marriage is offered by both names',
          labels.some(l => /Sydney and Rudo/.test(l)), labels.join(' | '));
    check('and so is a marriage nobody has named yet',
          labels.some(l => /Sydney, by another mother/.test(l)), labels.join(' | '));
    check('the mother\'s side too',
          labels.some(l => /Evelyn, by another father/.test(l)), labels.join(' | '));
  }

  section('with NO parents recorded there is nothing to assume, so nothing is asked');
  {
    const fe = loadFrontend();
    const a = fe.addPerson('Bertha', 'f', 'Nzou', '1975', '');
    eq('no question', fe.parentageOptions(a), []);
    // And growing a sibling still works: they share whoever their parents
    // turn out to be.
    const b = fe.grow('sibling', a, 'Terence', 'm', 'Nzou', {});
    eq('they are recorded as brother and sister', termOf(fe, a, b), 'Hanzvadzi');
    eq('in the same marriage', fe.parentUnionOf(a).id, fe.parentUnionOf(b).id);
  }

  section('THE ASSUMPTION IS GONE: a sibling by another mother is recorded as one');
  {
    const { fe, older, father, first } = twoWives();
    const half = fe.grow('sibling', older, 'Munyaradzi', 'm', 'Mwendamberi',
                         { born:'1990', share:'p:' + father });
    check('they are not in her marriage',
          fe.parentUnionOf(half).id !== fe.parentUnionOf(older).id);
    check('their father is the same man',
          fe.parentUnionOf(half).partners.includes(father));
    check('and her mother is NOT recorded as theirs',
          !fe.parentUnionOf(half).partners.includes(first),
          'this is the assertion nobody in the family ever made');
    eq('and the tree still calls them brother and sister',
       termOf(fe, older, half), 'Hanzvadzi');
  }

  section('choosing an existing marriage puts them in it');
  {
    const { fe, older, younger, u2 } = twoWives();
    const another = fe.grow('sibling', older, 'Victor', 'm', 'Mwendamberi',
                            { born:'1986', share:'u:' + u2 });
    eq('into the second marriage', fe.parentUnionOf(another).id, u2);
    eq('so they are full siblings of the child already there',
       fe.parentUnionOf(another).id, fe.parentUnionOf(younger).id);
  }

  section('choosing "same mother and father" is still the old behaviour');
  {
    const { fe, older, u1 } = twoWives();
    const full = fe.grow('sibling', older, 'Hazvineyi', 'f', 'Mwendamberi',
                         { born:'1978', share:'u:' + u1 });
    eq('same marriage', fe.parentUnionOf(full).id, u1);
  }

  // ── correcting what is already recorded ──────────────────────────────────
  section('a sibling recorded wrongly can be moved without being deleted');
  {
    const { fe, older, younger, father, first, u1, u2 } = twoWives();
    // Recorded the old way: attached to the first marriage as though the
    // first wife were their mother.
    const wrong = fe.grow('sibling', older, 'Ida Murraye', 'f', 'Mwendamberi',
                          { born:'1972' });
    eq('as it would have been before', fe.parentUnionOf(wrong).id, u1);

    const marriages = fe.unionsOf(wrong).length;
    check('moved', fe.setParentage(wrong, 'p:' + father));
    check('their mother is no longer asserted',
          !fe.parentUnionOf(wrong).partners.includes(first));
    eq('their father still is', fe.parentUnionOf(wrong).partners[0], father);
    check('nobody was removed from the tree', !!fe.getState().people[wrong]);
    eq('and they kept their own marriages', fe.unionsOf(wrong).length, marriages);
    eq('the marriage they came from still holds the others',
       fe.getState().unions[u1].children.includes(older), true);
    eq('and no longer holds them',
       fe.getState().unions[u1].children.includes(wrong), false);
  }

  section('moving to where they already are changes nothing');
  {
    const { fe, older, u1 } = twoWives();
    eq('refused as a no-op', fe.setParentage(older, 'u:' + u1), false);
    eq('and they are where they were', fe.parentUnionOf(older).id, u1);
  }

  section('the card shows what the tree currently says');
  {
    const { fe, older, u1 } = twoWives();
    eq('the marriage they are in', fe.parentageOf(older), 'u:' + u1);
  }

  // ── the ops a move turns into ────────────────────────────────────────────
  section('A MOVE IS SENT AS THE REMOVAL FIRST, OR IT CANNOT WORK');
  // union_children.person_id is the primary key, so a person is the child of
  // exactly one union and addChild REFUSES anybody who already has parents.
  // A single pass over the unions cannot promise the removal comes first —
  // it depends which union happens to be walked first — so they are collected
  // and ordered deliberately.
  {
    const { fe, older, father, u1 } = twoWives();
    const before = JSON.parse(JSON.stringify(fe.getState()));
    fe.setParentage(older, 'p:' + father);
    const ops = fe.diffOps(before, fe.getState());
    const kinds = ops.map(o => o.op);
    const drop = kinds.indexOf('removeChild');
    const add  = kinds.indexOf('addChild');
    check('both are there', drop >= 0 && add >= 0, kinds.join(' '));
    check(`removeChild before addChild (${kinds.join(' ')})`, drop < add,
          'the other way round is refused by the one-set-of-parents rule');
  }

  section('and the new marriage is created before anybody is put in it');
  {
    const { fe, older, father } = twoWives();
    const before = JSON.parse(JSON.stringify(fe.getState()));
    fe.setParentage(older, 'p:' + father);
    const ops = fe.diffOps(before, fe.getState());
    const kinds = ops.map(o => o.op);
    check('addUnion first', kinds.indexOf('addUnion') < kinds.indexOf('addChild'),
          kinds.join(' '));
    check('and its partner named before the child arrives',
          kinds.indexOf('addPartner') < kinds.indexOf('addChild'), kinds.join(' '));
  }

  section('an ordinary edit still produces the ops it always did');
  {
    const fe = loadFrontend();
    const f = fe.addPerson('Sydney', 'm', 'Nzou', '1940', '');
    const m = fe.addPerson('Evelyn', 'f', 'Shava', '1954', '');
    fe.addUnion([f, m], []);
    const before = JSON.parse(JSON.stringify(fe.getState()));
    fe.grow('child', f, 'Bertha', 'f', 'Nzou', { born:'1975' });
    const kinds = fe.diffOps(before, fe.getState()).map(o => o.op);
    eq('a person and a child link', kinds, ['addPerson', 'addChild']);
  }

  report();
})();
