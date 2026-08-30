// Nothing is ever deleted — in the page the family actually uses.
//
// The server has its own suite for this (test/setaside.test.js). These assert
// the same rule against the shipped frontend, because that is what people
// touch, and because the frontend has its own way of losing records: it holds
// the whole tree in one object and used to `delete` out of it.
//
// Loaded whole out of public/index.html, so these are what the family's
// browsers actually do.

const { check, eq, section, report, loadFrontend } = require('./helpers');

const fe = loadFrontend();

// Rudo records her father, her two brothers, and her father's second wife.
function buildFamily(){
  fe.setState({ people:{}, unions:{}, rootId:null, seq:1, notDuplicates:[], lexicon:{} });
  const st = fe.getState();
  const dad = fe.addPerson('Rufaro Moyo', 'm', 'Shumba', '1940', '');
  st.rootId = dad;
  const mum  = fe.grow('partner', dad, 'Chipo Moyo',  'f', 'Soko',   { born:'1945' });
  const kid1 = fe.grow('child',   dad, 'Garikai',     'm', 'Shumba', { born:'1968' });
  const kid2 = fe.grow('child',   dad, 'Tendai',      'm', 'Shumba', { born:'1971' });
  const gkid = fe.grow('child',   kid1,'Ruvarashe',   'f', 'Shumba', { born:'1995' });
  // Everyone above was entered by Rudo.
  for (const p of Object.values(st.people)) p.by = 'Rudo';
  return { dad, mum, kid1, kid2, gkid };
}

const names = () => fe.getState() &&
  Object.values(fe.getState().people).filter(p => !p.aside).map(p => p.name).sort();

(async () => {
  let f = buildFamily();
  const st = () => fe.getState();

  section('a reason is not optional');
  eq('setting aside with no reason does nothing', fe.setAside(f.kid2, ''), false);
  eq('nor does a reason of only spaces',          fe.setAside(f.kid2, '   '), false);
  eq('so he is still in the tree',                !!st().people[f.kid2].aside, false);

  section('setting somebody aside keeps every word of their record');
  fe.setMe(f.kid1);                       // Garikai is the one doing it
  eq('it succeeds with a reason',
     fe.setAside(f.kid2, 'Entered twice — same Tendai as the one above.'), true);
  const gone = st().people[f.kid2];
  check('the record is still there', !!gone);
  eq('with the name',        gone.name, 'Tendai');
  eq('with the birth year',  gone.born, '1971');
  eq('with the totem',       gone.totem, 'Shumba');
  eq('and whoever entered them', gone.by, 'Rudo');
  eq('the reason is kept verbatim', gone.aside.why,
     'Entered twice — same Tendai as the one above.');
  eq('and who did it',       gone.aside.by, 'Garikai');

  section('and they leave the tree everybody sees');
  eq('not counted among the living tree', names().includes('Tendai'), false);
  eq('everyone else still is', names(),
     ['Chipo Moyo', 'Garikai', 'Rufaro Moyo', 'Ruvarashe']);
  eq('present() reports them absent', fe.present(f.kid2), null);
  eq('they are not a sibling any more',
     fe.kinTerms(f.kid1, f.kid2), null);
  eq('and not a duplicate candidate',
     fe.duplicatePairs().some(d => d.a === f.kid2 || d.b === f.kid2), false);

  section('but their marriage and their parents are untouched');
  // The destructive version used to strip people out of unions and delete any
  // union left looking "pointless". That cannot be undone, so it is not done.
  const stillListed = Object.values(st().unions)
    .some(u => u.children.includes(f.kid2) || u.partners.includes(f.kid2));
  eq('the union still records them', stillListed, true);

  section('the notice goes to whoever recorded them');
  const rudo = fe.noticesFor('Rudo');
  eq('Rudo has one',        rudo.length, 1);
  eq('it is the right one', rudo[0].name, 'Tendai');
  eq('names are matched without case fuss', fe.noticesFor('rudo').length, 1);
  eq('somebody who recorded nothing has none', fe.noticesFor('Tapiwa').length, 0);
  eq('and nobody at all has none',             fe.noticesFor('').length, 0);

  section('anyone can put them back');
  eq('restoring succeeds', fe.restore(f.kid2), true);
  eq('they are in the tree again', names().includes('Tendai'), true);
  eq('the reason is gone with the state', !!st().people[f.kid2].aside, false);
  eq('and so is the notice', fe.noticesFor('Rudo').length, 0);
  eq('they are a brother again', fe.kinTerms(f.kid1, f.kid2).list.length > 0, true);

  section('setting aside somebody with descendants hides only them');
  fe.setAside(f.kid1, 'Not sure this is the right Garikai.');
  eq('Garikai is out',        names().includes('Garikai'), false);
  eq('his daughter is not',   names().includes('Ruvarashe'), true);
  eq('and she still records him as her father',
     Object.values(st().unions).some(u => u.partners.includes(f.kid1) &&
                                          u.children.includes(f.gkid)), true);
  fe.restore(f.kid1);

  section('a set-aside root hands the marker on rather than blanking the tree');
  eq('the root is the father to begin with', st().rootId, f.dad);
  fe.setAside(f.dad, 'Duplicate of the Rufaro recorded by his brother.');
  check('the root moved to somebody still in the tree',
        st().rootId !== f.dad && !!fe.present(st().rootId));
  eq('and the rest of the tree still has generations',
     Object.keys(fe.generations()).length > 0, true);
  fe.restore(f.dad);
  st().rootId = f.dad;

  section('merging a duplicate no longer destroys the record');
  f = buildFamily();
  fe.setMe(null);
  const dup = fe.addPerson('Sekuru Rufaro Moyo', 'm', 'Shumba', '1940', '');
  st().people[dup].by = 'Chenai';
  fe.mergePeople(f.dad, dup);
  const folded = st().people[dup];
  check('the folded record still exists', !!folded);
  eq('with its name',   folded.name, 'Sekuru Rufaro Moyo');
  eq('and its author',  folded.by, 'Chenai');
  check('set aside rather than deleted', !!folded.aside);
  eq('pointing at what it was folded into', folded.aside.mergedInto, f.dad);
  check('and saying so', /Folded into/.test(folded.aside.why));
  eq('it is out of the visible tree', !!fe.present(dup), false);
  eq('the survivor is still in it',   !!fe.present(f.dad), true);
  eq('Chenai is told what happened to hers', fe.noticesFor('Chenai').length, 1);
  eq('and it does not come back as a duplicate of the survivor',
     fe.duplicatePairs().some(d => d.a === dup || d.b === dup), false);

  section('every entry records who made it');
  fe.setState({ people:{}, unions:{}, rootId:null, seq:1, notDuplicates:[], lexicon:{} });
  const a = fe.addPerson('Anonymous', 'm', '', '', '');
  eq('with nobody claimed, the author is blank', fe.getState().people[a].by, '');
  fe.setMe(a);
  const b = fe.grow('child', a, 'Recorded By Me', 'f', '', {});
  eq('once you say who you are, it is stamped on what you add',
     fe.getState().people[b].by, 'Anonymous');
  check('and when', !!fe.getState().people[b].at);

  report();
})();
