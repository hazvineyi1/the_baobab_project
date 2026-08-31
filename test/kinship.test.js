// The Shona rules, as the family stated them.
//
// These are not derived from the code — they were given in plain words and are
// written here as plain words, so that a person who knows the system can read
// this file and say whether the app is right. The engine is loaded whole out
// of the shipped page, so these assert what the family's browsers actually do.
//
// Every row here corrects something the engine originally got wrong.

const { check, eq, section, report, loadFrontend } = require('./helpers');

const fe = loadFrontend();

// A family with both sides recorded, and one ego of each sex.
function buildFamily(){
  fe.setState({ people:{}, unions:{}, rootId:null, seq:1, notDuplicates:[], lexicon:{} });
  const st = fe.getState();
  const gf = fe.addPerson('Sekuru Tateguru', 'm', '', '1900', '');
  st.rootId = gf;
  fe.grow('partner', gf, 'Mbuya Chenai', 'f', 'Moyo', { born:'1904' });
  const dad  = fe.grow('child',   gf,  'Baba Rufaro',  'm', 'Shumba', { born:'1940' });
  const tete = fe.grow('sibling', dad, 'Tete Chipo',   'f', 'Shumba', { born:'1944', position:'younger' });
  const mum  = fe.grow('partner', dad, 'Amai Nyasha',  'f', 'Soko',   { born:'1946' });
  fe.grow('parent', mum, 'Sekuru Zvino', 'm', 'Soko', { born:'1918' });
  const mbro = fe.grow('sibling', mum, 'Farai Dube',   'm', 'Soko',   { born:'1950', position:'younger' });
  const mbw  = fe.grow('partner', mbro,'Rudo Dube',    'f', 'Nzou',   { born:'1954' });
  const mbs  = fe.grow('child',   mbro,'Tinashe Dube', 'm', 'Soko',   { born:'1980' });
  const mbd  = fe.grow('child',   mbro,'Vimbai Dube',  'f', 'Soko',   { born:'1982' });
  const man  = fe.grow('child',   dad, 'Garikai',      'm', 'Shumba', { born:'1975' });
  const woman= fe.grow('sibling', man, 'Tsitsi',       'f', 'Shumba', { born:'1977', position:'younger' });
  const tk   = fe.grow('child',   tete,'Tapiwa Ncube', 'm', 'Shumba', { born:'1974' });
  const tgk  = fe.grow('child',   tk,  'Anesu Ncube',  'f', 'Shumba', { born:'2000' });
  return { gf, dad, tete, mum, mbro, mbw, mbs, mbd, man, woman, tk, tgk };
}

const terms = (from, to) => {
  const k = fe.kinTerms(from, to);
  return k && k.list.length ? k.list.map(t => t.term) : [];
};

(async () => {
  const f = buildFamily();

  section("your father's sister");
  eq('to a man she is Tete', terms(f.man, f.tete), ['Tete']);
  eq('to a woman she is Tete and also a sister — Mukoma, same sex and senior',
     terms(f.woman, f.tete), ['Tete', 'Mukoma']);

  section("your father's sister's child");
  eq('to a man, Muzukuru', terms(f.man, f.tk), ['Muzukuru']);
  eq('to a woman, wholly her child — not also Muzukuru, because his mother is her sister',
     terms(f.woman, f.tk), ['Mwanakomana']);

  section("your father's sister's grandchild");
  // The two readings meet here, which is the check that the rules are coherent:
  // a man reaches Muzukuru down the father's-sister skew, and a woman reaches it
  // because her child's child is her grandchild. Same word, different route.
  eq('Muzukuru to a man', terms(f.man, f.tgk), ['Muzukuru']);
  eq('Muzukuru to a woman too', terms(f.woman, f.tgk), ['Muzukuru']);

  section("your mother's brother, and his children");
  eq('he is Sekuru to a man', terms(f.man, f.mbro), ['Sekuru']);
  eq('and Sekuru to a woman', terms(f.woman, f.mbro), ['Sekuru']);
  eq('his son is Sekuru too, to a man', terms(f.man, f.mbs), ['Sekuru']);
  eq('and to a woman', terms(f.woman, f.mbs), ['Sekuru']);
  /* CHANGED ON THE FAMILY'S INSTRUCTION, and recorded here rather than quietly
     edited, because the previous word was not wrong by accident — it was what
     this app had been told before.

     It said Amai: his daughters are mothers to you. The family building this
     tree has since said, in these words, "my brothers sons are sekuru to my
     children and his daughters are mainini to my children". Same house, same
     reasoning, junior form — which is the distinction they drew and the app
     had flattened. */
  eq('his DAUGHTER is not — she is Amainini, a woman of your mother\'s house, to a man',
     terms(f.man, f.mbd), ['Amainini']);
  eq('and to a woman', terms(f.woman, f.mbd), ['Amainini']);

  section("your mother's brother's wife");
  eq('to a man she is Ambuya, and also a wife', terms(f.man, f.mbw), ['Ambuya', 'Mukadzi']);
  eq('to a woman she is Ambuya only', terms(f.woman, f.mbw), ['Ambuya']);

  section('no English kin term ever appears');
  const ENGLISH = /\b(aunt|uncle|cousin|niece|nephew|in-?law|grand(ma|pa|mother|father|son|daughter))\b/i;
  const ids = Object.keys(fe.getState().people);
  let leaked = [];
  for (const a of ids) for (const b of ids){
    if (a === b) continue;
    for (const t of terms(a, b)) if (ENGLISH.test(t)) leaked.push(t);
  }
  eq('across every pair in the family', [...new Set(leaked)], []);

  section('the overlaps are the family’s to correct');
  // Even a word the app supplied itself can be overridden, keyed on the shape,
  // so a family that says it differently is not stuck with this app's choice.
  const before = terms(f.woman, f.tete);
  fe.teachTerm('overlap:fathers-sister:woman-looking:sister', 'Hanzvadzi');
  eq('teaching replaces the word the app chose',
     terms(f.woman, f.tete), ['Tete', 'Hanzvadzi']);
  fe.forgetTerm('overlap:fathers-sister:woman-looking:sister');
  eq('and removing it restores the default', terms(f.woman, f.tete), before);

  section('a man is unaffected by a woman’s overlaps');
  eq("his father's sister is still only Tete", terms(f.man, f.tete), ['Tete']);

  report();
})();
