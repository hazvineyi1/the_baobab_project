// Many families on one deployment, and the wall between them.
//
// REWRITTEN FOR PASSCODES. This suite used to assert the opposite of most of
// what it asserts now, and that is the point rather than a problem: the old
// model was that a family's link WAS its credential, so the suite proved that
// a link opened the family it named, from any browser, and that changing the
// link was the only way to take that back.
//
// Per-family passcodes replace that. A link is no longer a way in; an
// invitation is. So the same situations are here — a relative opening a link
// they were sent, a browser coming back later, a link that has gone somewhere
// it should not — with the answers the new model gives, which are mostly the
// opposite ones.
//
// Not part of `npm test` — needs Chromium and a live server. Run:
//
//   DATABASE_URL=... PORT=3940 node server.js &
//   MW_BASE_URL=http://127.0.0.1:3940/ APP_PASSPHRASE=... \
//     NODE_PATH=$(npm root -g) node test/browser/multifamily.js

const { chromium } = require('playwright');
const { BASE, EXE, openApp, onlyThisOrigin, enter, ready, settled } = require('./lib');

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

  // On an empty family the toolbar is hidden, so the way in is the line on the
  // planting screen; on a filled one it is the toolbar button. Both open the
  // same panel.
  const openFamilyPanel = async page => {
    if (await page.isVisible('#family')) await page.click('#family');
    else await page.click('#seedFamilyGo');
    await page.waitForSelector('#famInvite');
  };

  // ── the deployment's default family ──────────────────────────────────
  section('opening the address lands in a family');
  const home = await open();
  const homeTree = await home.page.evaluate(() => treeId);

  await openFamilyPanel(home.page);
  const words = await home.page.textContent('#form');
  is(/Bring a relative in/.test(words), true, 'the panel offers to invite somebody');
  is(/does not give them the family passcode/.test(words), true,
     'and says what an invitation is not');
  is(await home.page.isVisible('#famLink'), false,
     'no link is shown until one is made — there is no standing link any more');

  // ── starting a second family ─────────────────────────────────────────
  section('a relative of another house starts their own family');
  // Starting one hands back a passcode ONCE, in a prompt that has to be
  // acknowledged. The suite answers it the way a person would.
  let shownPasscode = null;
  home.page.on('dialog', d => {
    if (/passcode for/i.test(d.message())) {
      const m = d.message().match(/\n\n(\S+-\S+-\S+)\n\n/);
      if (m) shownPasscode = m[1];
      return d.accept('YES');
    }
    d.accept('');
  });

  await home.page.fill('#famName', TAG + ' family');
  await Promise.all([
    home.page.waitForNavigation({ waitUntil:'domcontentloaded' }).catch(() => {}),
    home.page.click('#famGo')
  ]);
  await ready(home.page);

  const newTree = await home.page.evaluate(() => treeId);
  is(newTree !== homeTree, true, 'it is a different tree');
  is(await home.page.evaluate(() => people().length), 0, 'and it starts empty');
  is(/^[a-z2-9]{6}-[a-z2-9]{6}-[a-z2-9]{6}$/.test(shownPasscode || ''), true,
     'a passcode was shown, once: ' + (shownPasscode ? shownPasscode.slice(0, 7) + '…' : 'none'));

  section('the session moved with them');
  is(await home.page.evaluate(async id =>
       (await fetch(`/api/tree/${id}/tree`)).status, homeTree), 404,
     'the family they came from is now closed to them');

  section('what they record stays in their own family');
  await home.page.evaluate(t => {
    state.rootId = addPerson('Chenjerai ' + t, 'm', 'Nzou', '1908', '');
    save();
  }, TAG);
  await home.page.waitForTimeout(1800);
  is(await home.page.evaluate(() => people().length), 1, 'recorded here');

  // ── an invitation, which is now the way in ───────────────────────────
  section('they invite a relative');
  await openFamilyPanel(home.page);
  await home.page.click('#famInvite');
  await home.page.waitForSelector('#famLink', { timeout: 10000 });
  const inviteLink = await home.page.inputValue('#famLink');
  is(/\/join\//.test(inviteLink), true, 'the panel hands back a one-time link');
  const joinPath = inviteLink.slice(inviteLink.indexOf('/join/'));

  section('a link preview does not spend it');
  // WhatsApp fetches a link before any human clicks it. A single-use
  // invitation consumed by a preview is one the relative never gets.
  const crawler = await browser.newContext();
  await onlyThisOrigin(crawler);
  const crawlPage = await crawler.newPage();
  await crawlPage.goto(BASE.replace(/\/$/, '') + joinPath, { waitUntil:'domcontentloaded' });
  is(/You have been invited/.test(await crawlPage.textContent('body')), true,
     'the crawler gets a page');
  is(await crawlPage.isVisible('button[type=submit]'), true,
     'with the taking-up left to a button');
  await crawler.close();

  section('the relative takes it up, from a browser that has never been here');
  const guest = await browser.newContext();
  await onlyThisOrigin(guest);
  const guestPage = await guest.newPage();
  await guestPage.goto(BASE.replace(/\/$/, '') + joinPath, { waitUntil:'domcontentloaded' });
  await Promise.all([
    guestPage.waitForNavigation({ waitUntil:'domcontentloaded' }).catch(() => {}),
    guestPage.click('button[type=submit]')
  ]);
  await ready(guestPage);
  is(await guestPage.evaluate(() => treeId), newTree, 'they land in the right family');
  is(await guestPage.evaluate(t => people().some(p => p.name.includes(t)), TAG), true,
     'and see what was recorded');

  section('and that browser comes back without the link');
  await guestPage.goto(BASE, { waitUntil:'domcontentloaded' });
  await ready(guestPage);
  is(await guestPage.evaluate(() => treeId), newTree,
     'the session remembered, rather than dropping into the deployment default');

  section('the same invitation does not work twice');
  const second = await browser.newContext();
  await onlyThisOrigin(second);
  const secondPage = await second.newPage();
  await secondPage.goto(BASE.replace(/\/$/, '') + joinPath, { waitUntil:'domcontentloaded' });
  await secondPage.click('button[type=submit]').catch(() => {});
  await secondPage.waitForTimeout(600);
  is(/cannot be used/.test(await secondPage.textContent('body')), true,
     'it says so, and offers nothing');
  await second.close();

  section('an invitation that has been withdrawn stops working');
  await openFamilyPanel(home.page);
  await home.page.click('#famInvite');
  await home.page.waitForSelector('#famLink', { timeout: 10000 });
  const doomed = await home.page.inputValue('#famLink');
  const doomedPath = doomed.slice(doomed.indexOf('/join/'));
  await home.page.waitForSelector('#famInviteList [data-revoke]', { timeout: 10000 });
  await home.page.click('#famInviteList [data-revoke]');
  await home.page.waitForTimeout(900);

  const withdrawn = await browser.newContext();
  await onlyThisOrigin(withdrawn);
  const wPage = await withdrawn.newPage();
  await wPage.goto(BASE.replace(/\/$/, '') + doomedPath, { waitUntil:'domcontentloaded' });
  await wPage.click('button[type=submit]').catch(() => {});
  await wPage.waitForTimeout(600);
  is(/cannot be used/.test(await wPage.textContent('body')), true,
     'withdrawn, and it says so without saying which invitation it was');
  await withdrawn.close();

  // ── what a link no longer does ───────────────────────────────────────
  section('A SHARING LINK IS NO LONGER A WAY IN');
  // The change that costs something, asserted rather than left implied: a
  // #/f/<key> link forwarded to somebody outside the family opens nothing.
  const newKey = await home.page.evaluate(() => familyKey);
  const outsider = await browser.newContext();
  await onlyThisOrigin(outsider);
  const outPage = await outsider.newPage();
  await enter(outPage, BASE + '#/f/' + newKey);       // signs in as the HOME family
  await settled(outPage);
  is(await outPage.evaluate(() => treeId) === newTree, false,
     'the link did not put them in that family');
  is(await outPage.evaluate(t => people().some(p => p.name.includes(t)), TAG), false,
     'and none of its people came with it');
  await outsider.close();

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

  // ── leaving ──────────────────────────────────────────────────────────
  section('signing out ends that browser and nothing else');
  await openFamilyPanel(guestPage);
  guestPage.on('dialog', d => d.accept());
  await Promise.all([
    guestPage.waitForNavigation({ waitUntil:'domcontentloaded' }).catch(() => {}),
    guestPage.click('#famOut')
  ]);
  await guestPage.waitForTimeout(500);
  is(/passcode/i.test(await guestPage.textContent('body')), true,
     'that browser is back at the door');
  is(await home.page.evaluate(() => people().length), 1,
     'and the family still has everything it had');
  await guest.close();

  await home.ctx.close();
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
