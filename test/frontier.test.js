// Where the tree stops, and what kind of stop it is.
//
// The project's whole point is that the lines keep going down until two
// families meet in the same ancestor. So the app has to be able to say where
// the recording ran out — and, more importantly, to tell apart the two ways
// that happens:
//
//   a ROOT      somebody said "this is as far back as we can trace"
//   an OPEN END nobody has said anything; no parents are recorded
//
// Collapsing those two into "has no parents" would be the bug: it would hide
// the difference between work that was done and work nobody has started.
//
// Loaded out of the shipped page, so these assert what the family's browsers
// actually do.

const { eq, section, report, loadFrontend } = require('./helpers');

const fe = loadFrontend();

// Three generations down one line, with a wife married in from outside.
//
//   Sekuru Tateguru ── Mbuya Chenai
//          │
//     Baba Rufaro ── Amai Nyasha        (Amai's own parents unrecorded)
//          │
//        Garikai ── Tsitsi
//          │
//        Ruvarashe
function buildLine(){
  fe.setState({ people:{}, unions:{}, rootId:null, seq:1, notDuplicates:[], lexicon:{} });
  const st = fe.getState();
  const gf  = fe.addPerson('Sekuru Tateguru', 'm', '', '1900', '');
  st.rootId = gf;
  const gm  = fe.grow('partner', gf,  'Mbuya Chenai', 'f', 'Moyo',   { born:'1904' });
  const dad = fe.grow('child',   gf,  'Baba Rufaro',  'm', 'Shumba', { born:'1940' });
  const mum = fe.grow('partner', dad, 'Amai Nyasha',  'f', 'Soko',   { born:'1946' });
  const man = fe.grow('child',   dad, 'Garikai',      'm', 'Shumba', { born:'1975' });
  const wf  = fe.grow('partner', man, 'Tsitsi',       'f', 'Nzou',   { born:'1977' });
  const kid = fe.grow('child',   man, 'Ruvarashe',    'f', 'Shumba', { born:'2004' });
  return { gf, gm, dad, mum, man, wf, kid };
}

const names = list => list.map(e => e.name);

(async () => {
  const f = buildLine();
  const st = fe.getState();

  section('an open end is a question nobody has asked');
  eq('the topmost ancestor has no parents, so he is an open end',
     fe.isOpenEnd(f.gf), true);
  eq('so is a wife who married in from a family nobody has recorded',
     fe.isOpenEnd(f.mum), true);
  eq('somebody whose parents are recorded is not an open end',
     fe.isOpenEnd(f.dad), false);

  section('a root is a statement, and it silences the question');
  fe.toggleRoot(f.gf);
  eq('the rooted ancestor is no longer counted as an open end',
     fe.isOpenEnd(f.gf), false);
  eq('he is listed as a root instead', names(fe.frontier().roots), ['Sekuru Tateguru']);
  eq('and the wives nobody has traced are still open',
     names(fe.frontier().open).sort(), ['Amai Nyasha', 'Mbuya Chenai', 'Tsitsi'].sort());

  section('how far the line has been traced');
  const root = fe.frontier().roots[0];
  // Wives married in are not below him — they came from their own families.
  eq('three descendants below the root', root.below, 3);
  eq('three generations deep',           root.depth, 3);
  eq('the youngest person recorded carries nobody below them',
     fe.descendantsOf(f.kid).count, 0);
  // A wife counts her husband's children as below her — they are hers too.
  eq('a wife who married in still has the children below her',
     fe.descendantsOf(f.wf).count, 1);

  section('unrooting reopens the question');
  fe.toggleRoot(f.gf);
  eq('no roots left',              fe.frontier().roots.length, 0);
  eq('and he is an open end again', fe.isOpenEnd(f.gf), true);

  section('deepening a root moves the frontier up a generation');
  fe.toggleRoot(f.gf);
  const older = fe.grow('parent', f.gf, 'Tateguru Nyika', 'm', 'Shumba', { born:'1870' });
  eq('the old root now has a parent, so it is no longer an open end',
     fe.isOpenEnd(f.gf), false);
  eq('the new ancestor is the open end', fe.frontier().open.some(e => e.id === older), true);
  // The root flag is a claim about tracing, not about topology: adding a
  // parent above a rooted person does not silently clear it. Lifting it is
  // the user's act, which is why the bud does it before opening the form.
  eq('the old root keeps the flag until somebody lifts it',
     st.people[f.gf].root, true);

  section('the biggest line is listed first');
  fe.toggleRoot(f.gf);
  fe.toggleRoot(f.kid);
  fe.toggleRoot(older);
  eq('the ancestor with the most below him leads',
     names(fe.frontier().roots)[0], 'Tateguru Nyika');
  eq('and the one with nobody below comes last',
     names(fe.frontier().roots).pop(), 'Ruvarashe');

  report();
})();
