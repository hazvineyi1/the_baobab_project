// Rooting, in a real browser.
//
// The frontier logic is asserted headlessly in test/frontier.test.js. What
// cannot be asserted there is the part the family actually touches: that a
// rooted person is offered a way through rather than a dead end, that one tap
// lifts the root and asks for the parent, and that the Roots panel keeps
// declared roots and open ends visibly apart.
//
// Not part of `npm test` — it needs Chromium. Run it against a static server:
//
//   npx http-server public -p 3930 -s &
//   NODE_PATH=$(npm root -g) node test/browser/roots.js
//
// Point it elsewhere with MW_BASE_URL / MW_CHROMIUM.
const { chromium } = require('playwright');

const BASE = process.env.MW_BASE_URL || 'http://127.0.0.1:3930/';
const EXE  = process.env.MW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log('  ok   ' + m); };
const bad = (m, d) => { fail++; console.log('  FAIL ' + m + (d ? '  — ' + d : '')); };
const is  = (a, b, m) => a === b ? ok(m) : bad(m, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', e => bad('page error', e.message));

  // A four-person line: Sekuru -> Baba -> Me, plus Amai married in with no
  // parents of her own. Sekuru is declared the root; Amai is an open end.
  await page.goto(BASE);
  await page.evaluate(() => {
    const P = (id, name, sex, born, root) =>
      ({ id, name, sex, born, root: root || false });
    const state = {
      people: {
        p1: P('p1', 'Sekuru Chenjerai', 'm', '1920', true),
        p2: P('p2', 'Baba Tendai', 'm', '1950'),
        p3: P('p3', 'Amai Rudo', 'f', '1955'),
        p4: P('p4', 'Farai', 'm', '1980')
      },
      unions: {
        u1: { id: 'u1', partners: ['p1'], children: ['p2'] },
        u2: { id: 'u2', partners: ['p2', 'p3'], children: ['p4'] }
      },
      rootId: 'p4', seq: 9
    };
    localStorage.setItem('muti-baobab-v1', JSON.stringify(state));
  });
  await page.reload();
  await page.waitForFunction(() => { try { return people().length === 4; } catch (e) { return false; } });

  // ── the frontier split ────────────────────────────────────────────────
  const f = await page.evaluate(() => frontier());
  is(f.roots.map(r => r.name).join(','), 'Sekuru Chenjerai', 'Sekuru is the only declared root');
  is(f.open.map(r => r.name).join(','),  'Amai Rudo',        'Amai is the only open end');
  // "Below" counts descendants, not the household: Amai married in, she did
  // not come down from Sekuru. Baba and Farai are the line.
  is(f.roots[0].below, 2, 'two people below the root');
  is(f.roots[0].depth, 2, 'two generations deep');
  is(await page.evaluate(() => isOpenEnd('p2')), false, 'Baba has parents, so not an open end');
  is(await page.evaluate(() => isOpenEnd('p1')), false, 'a declared root is not an open end');

  // ── the deepen bud ────────────────────────────────────────────────────
  const budsOn = async (id) => {
    await page.evaluate(i => { sel = i; render(); revealBuds(); }, id);
    await page.waitForTimeout(120);
    return page.$$eval('#buds .bud', bs => bs.map(b => b.dataset.bud));
  };
  const rootBuds = await budsOn('p1');
  is(rootBuds.includes('deepen'), true,  'rooted person offers Deepen the root');
  is(rootBuds.includes('parent'), false, 'rooted person does not also offer Parent');
  const openBuds = await budsOn('p3');
  is(openBuds.includes('parent'), true,  'an open end offers Parent');
  is(openBuds.includes('deepen'), false, 'an open end offers no Deepen');
  const midBuds = await budsOn('p2');
  is(midBuds.includes('deepen'), false, 'somebody with parents offers no Deepen');
  is(midBuds.includes('parent'), true,  'and can still take a second parent');

  // ── one tap lifts the root and asks for the parent ────────────────────
  await budsOn('p1');
  await page.click('#buds .bud[data-bud="deepen"]');
  await page.waitForSelector('#form');
  is(await page.evaluate(() => state.people.p1.root), false, 'the tap lifted the root');
  const cap = (await page.textContent('#form .cap') || '').toLowerCase();
  is(/parent|before|father|mother/.test(cap), true, 'the parent form opened: ' + JSON.stringify(cap));
  // save() is debounced, so give it its window rather than racing it.
  const saved = await page.waitForFunction(
    () => JSON.parse(localStorage.getItem('muti-baobab-v1')).people.p1.root === false,
    null, { timeout: 3000 }).then(() => true, () => false);
  is(saved, true, 'the lift was saved');

  // Add the parent and check the tree actually deepened.
  await page.fill('#fName', 'Tateguru Nyika');
  await page.click('#fGo');
  await page.waitForTimeout(200);
  is(await page.evaluate(() => people().length), 5, 'the ancestor was added');
  is(await page.evaluate(() => isOpenEnd('p1')), false, 'p1 now has a parent');
  is(await page.evaluate(() => frontier().open.some(e => e.name === 'Tateguru Nyika')), true,
     'the new ancestor is now the open end');

  // ── the Roots panel ───────────────────────────────────────────────────
  await page.evaluate(() => { state.people.p1.root = false; state.people.p3.root = true; render(); });
  await page.click('#roots');
  await page.waitForSelector('#form');
  const panel = await page.textContent('#form');
  is(/Where the tree stops/.test(panel), true, 'the panel is titled');
  is(/Rooted/.test(panel) && /Amai Rudo/.test(panel), true, 'Amai shows under Rooted');
  is(/Open ends/.test(panel) && /Tateguru Nyika/.test(panel), true, 'Tateguru shows under Open ends');
  const rows = await page.$$eval('#form .askrow em', es => es.map(e => e.textContent));
  is(rows.includes('deepen') && rows.includes('trace back'), true,
     'roots say deepen, open ends say trace back');
  is(/<b>1<\/b> rooted/.test(await page.innerHTML('#form')), true, 'the tally counts one root');

  // Tapping a row travels to that person.
  await page.click('#form .askrow[data-goto="p3"]');
  await page.waitForTimeout(200);
  is(await page.evaluate(() => sel), 'p3', 'the row selected the person');

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
