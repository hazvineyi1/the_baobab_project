// Choosing whether a living relative is in the public record.
//
// The model is asserted headlessly in test/visibility.test.js. What only this
// can check is the part a person actually meets: that the choice is on the
// card where the decision gets made, that it says in plain words what will
// happen, and — the one that matters — that choosing "Public" really does put
// a living person in front of the world, and choosing "Private" really does
// take them back.
//
// Not part of `npm test` — needs Chromium and a live server with
// MW_PUBLIC_READ=on. Run:
//
//   DATABASE_URL=... APP_PASSPHRASE=... MW_PUBLIC_READ=on PORT=3940 node server.js &
//   MW_BASE_URL=http://127.0.0.1:3940/ NODE_PATH=$(npm root -g) \
//     node test/browser/visibility.js

const { chromium } = require('playwright');
const { BASE, EXE, openApp, ready } = require('./lib');

let pass = 0, fail = 0;
const ok  = m => { pass++; console.log('  ok   ' + m); };
const bad = (m, d) => { fail++; console.log('  FAIL ' + m + (d ? '  — ' + d : '')); };
const is  = (a, b, m) => a === b ? ok(m) : bad(m, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const section = t => console.log('\n' + t);

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const { ctx, page } = await openApp(browser);
  page.on('pageerror', e => bad('page error', e.message));
  await ready(page);

  const TAG = 'Vis' + Date.now().toString(36).slice(-5);
  const YEAR = new Date().getFullYear();

  section('a family records an ancestor and a living son');
  await page.evaluate(([t, y]) => {
    const old = addPerson('Chenjerai ' + t, 'm', 'Nzou', '1908', '1974');
    state.rootId = old;
    grow('child', old, 'Garikai ' + t, 'm', 'Nzou', { born: String(y - 40) });
    save();
  }, [TAG, YEAR]);
  await page.waitForTimeout(1800);

  // What the world can see, asked without any passphrase at all.
  const worldSees = () => page.evaluate(async t => {
    const d = await fetch(`/public/tree/${treeId}`).then(r => r.json());
    return d.people.map(p => p.name).filter(n => n.includes(t));
  }, TAG);

  section('by default the dead are published and the living are not');
  let world = await worldSees();
  is(world.some(n => n.startsWith('Chenjerai')), true, 'the ancestor is public: ' + world.join(', '));
  is(world.some(n => n.startsWith('Garikai')), false, 'the living son is not');

  // Open a person's card by name — local ids from before the first save are
  // replaced by the server's, so nothing here may hold on to them.
  const card = async who => {
    await page.evaluate(([w, t]) => {
      const p = people().find(x => x.name.startsWith(w + ' ' + t));
      sel = p.id; render(); openCard(p.id);
    }, [who, TAG]);
    await page.waitForSelector('#cVis');
    return page.textContent('#form');
  };

  section('and the card says so, in words rather than settings');
  const shown = await card('Garikai');
  is(/In the public record/.test(shown), true, 'the choice is on the card');
  is(/Only this family can see them/.test(shown), true, 'saying what is true now');
  is(/Recorded as living/.test(shown), true, 'and why');
  is(/should be asked before they are published/.test(shown), true,
     'and that it is a decision about a person');
  is((await page.$$('#cVis button')).length, 3, 'three choices');
  is(await page.$eval('#cVis button[data-vis=""]', b => b.getAttribute('aria-pressed')), 'true',
     'with the usual rule in force');

  section('choosing Public really does publish a living person');
  await page.click('#cVis button[data-vis="public"]');
  await page.waitForTimeout(1800);
  world = await worldSees();
  is(world.some(n => n.startsWith('Garikai')), true,
     'the world can now see him: ' + world.join(', '));

  section('and it is recorded who chose');
  const afterPublic = await card('Garikai');
  is(await page.$eval('#cVis button[data-vis="public"]', b => b.getAttribute('aria-pressed')), 'true',
     'the card shows the choice');
  is(/Anyone in the world can find them/.test(afterPublic), true,
     'and states the consequence');

  section('choosing Private takes them back out');
  await page.click('#cVis button[data-vis="private"]');
  await page.waitForTimeout(1800);
  world = await worldSees();
  is(world.some(n => n.startsWith('Garikai')), false, 'gone from the public record again');
  is(await page.evaluate(t => people().some(p => p.name.startsWith('Garikai ' + t)), TAG), true,
     'but still entirely present to his own family');

  section('a family can withhold a dead relative too');
  is(/Recorded as no longer living/.test(await card('Chenjerai')), true,
     'the card knows he has died');
  await page.click('#cVis button[data-vis="private"]');
  await page.waitForTimeout(1800);
  world = await worldSees();
  is(world.length, 0, 'an explicit choice wins in either direction');

  section('and the usual rule can be restored');
  await card('Chenjerai');
  await page.click('#cVis button[data-vis=""]');
  await page.waitForTimeout(1800);
  world = await worldSees();
  is(world.some(n => n.startsWith('Chenjerai')), true, 'the ancestor is public once more');

  section('the tree marks who the world cannot see');
  await page.evaluate(() => closeForm());
  await page.waitForTimeout(300);
  const marked = await page.evaluate(t => {
    const son = people().find(p => p.name.startsWith('Garikai ' + t));
    const pod = document.querySelector(`.pod[data-id="${son.id}"]`);
    return !!(pod && pod.querySelector('.shut'));
  }, TAG);
  is(marked, true, 'a quiet mark on the private one');

  await ctx.close();
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
