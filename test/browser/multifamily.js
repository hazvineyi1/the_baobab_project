// Two families on one deployment, in the browser.
//
// The point of the whole cross-tree feature was that a family had to be able
// to have a tree of their own before there was ever a second family to match
// against. These drive that: someone starts a family, gets a link, and what
// they record is not visible to the deployment's other family.
//
// Also asserts the thing that makes it usable at all — that a link opens the
// family it names, and that a browser remembers which family it was in.
//
// Not part of `npm test` — needs Chromium and a live server. Run:
//
//   DATABASE_URL=... PORT=3940 node server.js &
//   MW_BASE_URL=http://127.0.0.1:3940/ NODE_PATH=$(npm root -g) \
//     node test/browser/multifamily.js

const { chromium } = require('playwright');

const { BASE, EXE, openApp, enter, onlyThisOrigin, ready, settled } = require('./lib');

let pass = 0, fail = 0;
const ok  = m => { pass++; console.log('  ok   ' + m); };
const bad = (m, d) => { fail++; console.log('  FAIL ' + m + (d ? '  — ' + d : '')); };
const is  = (a, b, m) => a === b ? ok(m) : bad(m, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const section = t => console.log('\n' + t);

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const TAG = 'Fam' + Date.now().toString(36).slice(-5);

  const open = async (url) => {
    const { ctx, page } = await openApp(browser, { url: url || BASE });
    page.on('pageerror', e => bad('page error', e.message));
    await ready(page);
    return { ctx, page };
  };

  // ── the deployment's default family ──────────────────────────────────
  section('opening the address lands in a family with a shareable link');
  const home = await open();
  const homeTree = await home.page.evaluate(() => treeId);
  const homeKey  = await home.page.evaluate(() => familyKey);
  is(/^[a-z2-9]{20,}$/.test(homeKey || ''), true, 'it has a key: ' + homeKey);
  // On an empty family the toolbar is hidden, so the way in is the line on
  // the planting screen; on a filled one it is the toolbar button. Both must
  // open the same panel.
  const openFamilyPanel = async page => {
    if (await page.isVisible('#family')) await page.click('#family');
    else await page.click('#seedFamilyGo');
    await page.waitForSelector('#famLink');
  };
  is(await home.page.isVisible('#seedFamily') || await home.page.isVisible('#family'),
     true, 'and a way to see it');
  await openFamilyPanel(home.page);
  const shown = await home.page.inputValue('#famLink');
  is(shown.includes('#/f/' + homeKey), true, 'the panel shows the link: ' + shown);
  const words = await home.page.textContent('#form');
  is(/invitation, not a password/.test(words), true,
     'and says plainly what holding it means');

  // ── starting a second family ─────────────────────────────────────────
  section('a relative of another house starts their own family');
  await home.page.fill('#famName', TAG + ' family');
  await Promise.all([
    home.page.waitForNavigation({ waitUntil:'domcontentloaded' }).catch(() => {}),
    home.page.click('#famGo')
  ]);
  await ready(home.page);
  const newTree = await home.page.evaluate(() => treeId);
  const newKey  = await home.page.evaluate(() => familyKey);
  is(newTree !== homeTree, true, 'it is a different tree');
  is(newKey !== homeKey, true, 'with a different key');
  is(await home.page.evaluate(() => people().length), 0, 'and it starts empty');
  // An empty family is exactly when the link needs sending round, and it is
  // also when the toolbar is hidden — so the way to it has to be on this
  // screen too.
  is(await home.page.isVisible('#seedFamily'), true,
     'the empty family still offers its link');
  is((await home.page.evaluate(() => location.hash)), '#/f/' + newKey,
     'the address names the family you are in');

  section('what they record stays in their own family');
  await home.page.evaluate(t => {
    state.rootId = addPerson('Chenjerai ' + t, 'm', 'Nzou', '1908', '');
    save();
  }, TAG);
  await home.page.waitForTimeout(1800);
  is(await home.page.evaluate(() => people().length), 1, 'recorded here');
  const inOldFamily = await home.page.evaluate(async ([id, t]) => {
    const d = await fetch(`/api/tree/${id}/tree`).then(r => r.json());
    return d.people.some(p => p.name.includes(t));
  }, [homeTree, TAG]);
  is(inOldFamily, false, 'and nowhere near the other family');

  section('the link opens the family it names, from a browser that has never seen it');
  const guest = await open(BASE + '#/f/' + newKey);
  is(await guest.page.evaluate(() => treeId), newTree, 'the guest lands in the right family');
  is(await guest.page.evaluate(t => people().some(p => p.name.includes(t)), TAG), true,
     'and sees what was recorded');

  section('and that browser comes back to it without the link');
  // The same browser, going to the bare address — a relative who bookmarked
  // the site rather than the link, or who typed it from memory.
  await guest.page.goto(BASE, { waitUntil:'domcontentloaded' });
  await ready(guest.page);
  is(await guest.page.evaluate(() => treeId), newTree,
     'it remembered, rather than dropping into the deployment default');
  await guest.ctx.close();

  section('a link that names no family says so, and saves nothing');
  const lost = await browser.newContext();
  await onlyThisOrigin(lost);
  const lostPage = await lost.newPage();
  await enter(lostPage, BASE + '#/f/zzzzzzzzzzzzzzzzzzzzzz');
  await settled(lostPage);
  is(await lostPage.evaluate(() => store), 'stalled', 'the page stalls rather than guessing');
  is(/No family answers to that link/.test(await lostPage.textContent('#stalled')), true,
     'and explains why');
  await lost.close();

  section('changing the link locks the old one out');
  home.page.on('dialog', d => d.accept());
  await openFamilyPanel(home.page);
  await home.page.waitForSelector('#famRotate');
  await Promise.all([
    home.page.waitForNavigation({ waitUntil:'domcontentloaded' }).catch(() => {}),
    home.page.click('#famRotate')
  ]);
  await ready(home.page);
  const rotated = await home.page.evaluate(() => familyKey);
  is(rotated !== newKey, true, 'a new key was issued');
  is(await home.page.evaluate(() => treeId), newTree, 'the same family, though');
  is(await home.page.evaluate(t => people().some(p => p.name.includes(t)), TAG), true,
     'with everybody still in it');

  const stale = await browser.newContext();
  await onlyThisOrigin(stale);
  const stalePage = await stale.newPage();
  await enter(stalePage, BASE + '#/f/' + newKey);
  await settled(stalePage);
  is(await stalePage.evaluate(() => store), 'stalled', 'the old link no longer opens it');
  await stale.close();

  await home.ctx.close();
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
