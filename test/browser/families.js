// Two families meeting, in the browser.
//
// The scoring is asserted headlessly in test/crosstree.test.js. What can only
// be checked here is the thing the project is actually for: a person opens
// their own tree, is shown a household they have never heard of that recorded
// the same grandfather, says "that is the same man", and the two families are
// joined without either losing anything.
//
// Not part of `npm test` — needs Chromium and a live server. Run:
//
//   DATABASE_URL=... PORT=3940 node server.js &
//   MW_BASE_URL=http://127.0.0.1:3940/ NODE_PATH=$(npm root -g) \
//     node test/browser/families.js

const { chromium } = require('playwright');

const BASE = process.env.MW_BASE_URL || 'http://127.0.0.1:3940/';
const EXE  = process.env.MW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let pass = 0, fail = 0;
const ok  = m => { pass++; console.log('  ok   ' + m); };
const bad = (m, d) => { fail++; console.log('  FAIL ' + m + (d ? '  — ' + d : '')); };
const is  = (a, b, m) => a === b ? ok(m) : bad(m, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const section = t => console.log('\n' + t);

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const ctx = await browser.newContext({ viewport:{ width:1280, height:960 } });
  await ctx.route('**', r => r.request().url().startsWith(BASE) ? r.continue() : r.abort());
  const page = await ctx.newPage();
  page.on('pageerror', e => bad('page error', e.message));
  await page.goto(BASE, { waitUntil:'domcontentloaded' });
  await page.waitForFunction(() => { try { return store === 'shared' && !!treeId; }
                                     catch (e) { return false; } }, null, { timeout:20000 });

  // A surname unique to this run. The home tree is shared and will already
  // hold other families — a suite that only passes against an empty database
  // is one that will lie later.
  const TAG = 'Mutasa' + Date.now().toString(36).slice(-5);
  const mineCount = () => page.evaluate(t => people().filter(p => p.name.includes(t)).length, TAG);

  section('this family records their grandfather and his household');
  await page.evaluate(t => {
    const gf = addPerson('Chenjerai ' + t, 'm', 'Nzou', '1908', '');
    state.rootId = gf;
    grow('partner', gf, 'Tariro ' + t, 'f', 'Shava', { born:'1914' });
    grow('child',   gf, 'Farai ' + t,  'm', 'Nzou',  { born:'1940' });
    save();
  }, TAG);
  await page.waitForTimeout(2000);
  is(await mineCount(), 3, 'three people recorded');

  section('somewhere else, another family records the same old man');
  // Entered directly against the API, as a second household on the same
  // deployment would be — a different tree, no shared ids with this one.
  const otherTree = await page.evaluate(async tag => {
    const t = await fetch('/api/trees', {
      method:'POST', headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ name:'Chikwanha' })
    }).then(r => r.json());
    await fetch(`/api/tree/${t.id}/ops`, {
      method:'POST', headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ ops: [
        { op:'addPerson', ref:'$old',  name:'Sekuru Chenjerai ' + tag, sex:'m',
          totem:'Nzou', born:'1908' },
        { op:'addPerson', ref:'$wife', name:'Tariro ' + tag, sex:'f', totem:'Shava', born:'1915' },
        { op:'addPerson', ref:'$son',  name:'Munashe ' + tag, sex:'m', totem:'Nzou', born:'1944' },
        { op:'addUnion', ref:'$u' },
        { op:'addPartner', unionId:'$u', personId:'$old' },
        { op:'addPartner', unionId:'$u', personId:'$wife' },
        { op:'addChild',   unionId:'$u', personId:'$son' }
      ] })
    });
    return t.id;
  }, TAG);
  is(/^[0-9a-f-]{36}$/.test(otherTree), true, 'the second family exists');

  section('the button appears, and the panel finds them');
  await page.evaluate(() => render());
  await page.waitForTimeout(300);
  is(await page.isVisible('#families'), true, 'Other families is offered');
  await page.click('#families');
  await page.waitForSelector('#form .askrow', { timeout: 15000 });
  const panel = await page.textContent('#form');
  is(panel.includes('Chenjerai ' + TAG), true, 'the grandfather is named');
  is(/Chikwanha/.test(panel), true, 'and so is the family who also recorded him');
  is(/same totem/.test(panel), true, 'the totem is given as a reason');
  is(/Might be the same person/.test(panel), true, 'offered as a maybe, not a fact');

  section('saying "same person" proposes a link and merges nothing');
  const before = await page.evaluate(() => people().length);
  await page.click(`#form .askrow:has-text("Chenjerai ${TAG}") .mini[data-link]`);
  await page.waitForTimeout(1500);
  await page.waitForSelector('#form', { timeout: 10000 });
  const after = await page.textContent('#form');
  is(/Waiting on an answer/.test(after), true, 'it is now waiting on the other family');
  is(await page.evaluate(() => people().length), before, 'this tree gained nobody');
  const theirCount = await page.evaluate(async id =>
    (await fetch(`/api/tree/${id}/tree`).then(r => r.json())).people.length, otherTree);
  is(theirCount, 3, 'and the other family lost nobody');

  section('the other family agrees, and both are joined');
  const linkId = await page.evaluate(async t => {
    const d = await fetch(`/api/tree/${treeId}/links`).then(r => r.json());
    return (d.links.find(l => l.mine.name.includes(t)) || {}).id;
  }, TAG);
  is(!!linkId, true, 'the link was recorded against this run’s grandfather');
  await page.evaluate(async ([id, link]) => {
    await fetch(`/api/tree/${id}/ops`, {
      method:'POST', headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ ops: [{ op:'decideLink', linkId: link, status:'confirmed' }] })
    });
  }, [otherTree, linkId]);
  await page.click('#fmNo');
  await page.click('#families');
  await page.waitForSelector('#form .askrow', { timeout: 15000 });
  const joined = await page.textContent('#form');
  is(/both families agree/.test(joined), true, 'the panel says both families agree');
  is(/Already decided/.test(joined), true, 'under the settled heading');

  section('and each family still holds its own records');
  is(await page.evaluate(() => people().length), before, 'this tree is unchanged');
  is(await page.evaluate(async id =>
       (await fetch(`/api/tree/${id}/tree`).then(r => r.json())).people.length, otherTree), 3,
     'and so is theirs');
  is(await page.evaluate(t => people().some(p => p.name === 'Munashe ' + t), TAG), false,
     'their people did not appear in this tree');

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
