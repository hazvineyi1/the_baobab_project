// Who is viewing, through the real server.
//
// THE FAULT THIS EXISTS FOR. Every Shona term this app produces is reckoned
// from one person. Amaiguru and Amainini turn on whose mother is older; Tete
// and Sekuru on which side of the family you stand; "my sister's children are
// my children" on whether the person asking is a woman. There is no such thing
// as a term without a viewer.
//
// And the viewer used to be a line in localStorage — a per-device preference,
// unset on a new phone, unset by clearing a browser, answered differently on
// the tablet in the next room. So the tree would trace a relationship
// perfectly and then describe it to nobody: "your sister Evelyn Mandaba's
// child", shown to somebody who has no sister Evelyn.
//
// It has to be a browser test. What is being asserted is a sequence across
// two page loads and a cookie — sign in, be asked, answer, and still be that
// person on the next load and from a different browser. Nothing headless
// carries a session across a reload.
//
//   DATABASE_URL=... PORT=3940 node server.js &
//   MW_BASE_URL=http://127.0.0.1:3940/ APP_PASSPHRASE=... \
//     NODE_PATH=$(npm root -g) node test/browser/viewer.js

const { chromium } = require('playwright');
const { BASE, EXE, openApp, ready, saved, sayWhoYouAre } = require('./lib');

let pass = 0, fail = 0;
const ok  = m => { pass++; console.log('  ok   ' + m); };
const bad = (m, d) => { fail++; console.log('  FAIL ' + m + (d ? '  — ' + d : '')); };
const is  = (a, b, m) => a === b ? ok(m) : bad(m, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const section = t => console.log('\n' + t);

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });

  /* A family of its own, so this suite never has to guess which names it will
     be offered. Started through the app, which is also the one case that goes
     straight through the question: a family with nobody in it has nobody to
     be. */
  const TAG = 'Who' + Date.now().toString(36).slice(-5);
  const first = await openApp(browser, { viewport:{ width:1180, height:900 } });
  await ready(first.page);

  section('a family with nobody in it is not asked, because there is nobody to be');
  const made = await first.page.evaluate(async t => {
    const r = await fetch('/api/trees', {
      method:'POST', headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ name: 'The ' + t + ' family' })
    });
    return r.ok ? await r.json() : { error: r.status };
  }, TAG);
  is(!!made.id, true, 'a family was started: ' + JSON.stringify(made).slice(0, 90));
  is(typeof made.passcode === 'string', true, 'with a passcode shown once');

  // Starting a family moves the session into it, so a reload lands there.
  await first.page.reload({ waitUntil:'domcontentloaded' });
  await ready(first.page);
  is(await first.page.$('#whoQ'), null, 'nothing is asked of an empty family');

  section('the founder puts the family in, themselves included');
  await first.page.evaluate(t => {
    const dad = addPerson('Sydney ' + t, 'm', 'Mwendamberi', '1940', '2013');
    state.rootId = dad;
    const mum = grow('partner', dad, 'Evelyn ' + t, 'f', 'Moyondizvo', { born:'1954' });
    grow('child', dad, 'Ida ' + t,       'f', 'Mwendamberi', { born:'1972' });
    grow('child', dad, 'Bertha ' + t,    'f', 'Mwendamberi', { born:'1975' });
    grow('child', dad, 'Hazvineyi ' + t, 'f', 'Mwendamberi', { born:'1979' });
    save();
  }, TAG);
  await saved(first.page);
  is((await first.page.evaluate(() => people().length)), 5, 'five people recorded');

  // ── the question ─────────────────────────────────────────────────────────
  section('A SECOND RELATIVE SIGNS IN WITH THE SAME PASSCODE AND IS ASKED');
  const ctx = await browser.newContext({ viewport:{ width:1180, height:900 } });
  await ctx.route('**', r => r.request().url().startsWith(BASE) ? r.continue() : r.abort());
  const page = await ctx.newPage();
  page.on('pageerror', e => bad('page error', e.message));
  await page.goto(BASE, { waitUntil:'domcontentloaded' });
  await page.fill('input[name="passphrase"]', made.passcode);
  await Promise.all([
    page.waitForNavigation({ waitUntil:'domcontentloaded' }).catch(() => {}),
    page.click('button[type="submit"]')
  ]);

  await page.waitForSelector('#whoQ', { timeout: 15000 });
  ok('the tree is not shown until they say who they are');
  const offered = await page.$$eval('#whoList [data-who]', bs => bs.map(b => b.textContent.trim()));
  is(offered.length >= 5, true, 'the names to answer with are there: ' + offered.join(' | '));

  section('and NOTHING else about them — a roster, not the family');
  // The refusal carries what the question needs. Dates, totems and marriages
  // are what the answer unlocks, and sending them with the question would
  // make the question a formality.
  const shown = await page.textContent('#form');
  is(/1975|Mwendamberi|Moyondizvo/.test(shown), false,
     'no birth years and no mitupo in the question: ' + shown.slice(0, 140));

  section('answering opens the family, read from where they stand');
  const bertha = await page.$(`#whoList [data-who]:has-text("Bertha")`);
  await bertha.click();
  await page.waitForSelector('#whoQ', { state:'detached', timeout: 10000 });
  await ready(page);
  is(await page.$('#whoQ'), null, 'the question is done with');
  is(await page.evaluate(() => people().length), 5, 'and the whole family is here');
  is(await page.evaluate(() => (state.people[meId] || {}).name || '').then(n => /Bertha/.test(n)),
     true, 'the app is reckoning from Bertha');

  section('the words on screen are HERS, not the founder\'s');
  const hers = await page.evaluate(t => {
    const ida = people().find(p => p.name.startsWith('Ida ' + t));
    return (relationship(meId, ida.id) || {}).term;
  }, TAG);
  is(hers, 'Mukoma', 'her older sister is Mukoma: ' + hers);

  section('AND IT SURVIVES A RELOAD, which localStorage alone never could');
  await page.reload({ waitUntil:'domcontentloaded' });
  await ready(page);
  is(await page.$('#whoQ'), null, 'not asked again');
  is(await page.evaluate(() => (state.people[meId] || {}).name || '').then(n => /Bertha/.test(n)),
     true, 'still Bertha');

  section('and a browser that has never heard of her is told by the SESSION');
  // The cookie goes with the context, so this is the same session in a page
  // whose storage was never written to. Under the old arrangement this is
  // exactly where the viewer was lost.
  const fresh = await ctx.newPage();
  await fresh.goto(BASE, { waitUntil:'domcontentloaded' });
  await fresh.evaluate(() => { try { localStorage.removeItem('muti-baobab-me'); } catch (e) {} });
  await fresh.reload({ waitUntil:'domcontentloaded' });
  await ready(fresh);
  is(await fresh.$('#whoQ'), null, 'still not asked');
  is(await fresh.evaluate(() => (state.people[meId] || {}).name || '').then(n => /Bertha/.test(n)),
     true, 'the session knew, with nothing in storage to help it');
  await fresh.close();

  // ── an invitation that names who it is for ───────────────────────────────
  section('AN INVITATION MADE FOR A NAMED RELATIVE OPENS AS THEM');
  // The only thing here that makes who-is-viewing somebody else's word rather
  // than the holder's own. A shared passcode cannot do it: the secret is the
  // same for everybody who has it.
  // Made through the panel a relative actually uses, not by calling the API:
  // an attestation nobody can reach from the app is an attestation nobody
  // makes.
  await page.click('#family');
  await page.waitForSelector('#famFor', { timeout: 10000 });
  await page.fill('#famFor', 'Hazvineyi');
  await page.waitForSelector('#famForList [data-for]', { timeout: 5000 });
  await page.click('#famForList [data-for]');
  const willOpenAs = await page.textContent('#famForList');
  is(/It will open as/.test(willOpenAs), true,
     'the panel says what naming somebody does: ' + willOpenAs.trim().slice(0, 80));

  const answered = page.waitForResponse(r => r.url().includes('/api/invites') &&
                                             r.request().method() === 'POST');
  await page.click('#famInvite');
  const link = await (await answered).json();
  is(!!link.path, true, 'a link was made: ' + JSON.stringify(link).slice(0, 120));
  is(!!link.forPerson && /Hazvineyi/.test(link.forPerson.name), true,
     'and it knows who it is for');
  is(/opens as/.test(link.notice || ''), true,
     'and says so where it is handed over: ' + (link.notice || ''));

  await page.waitForSelector('#famInviteList', { timeout: 5000 });
  await page.waitForTimeout(600);
  is(/opens as/.test(await page.textContent('#famInviteList')), true,
     'and the list of invitations says which one is which');
  await page.click('#famNo');

  const guestCtx = await browser.newContext({ viewport:{ width:1180, height:900 } });
  await guestCtx.route('**', r => r.request().url().startsWith(BASE) ? r.continue() : r.abort());
  const guest = await guestCtx.newPage();
  await guest.goto(BASE + link.path.replace(/^\//, ''), { waitUntil:'domcontentloaded' });
  const join = await guest.$('button[type="submit"]');
  if (join) await Promise.all([
    guest.waitForNavigation({ waitUntil:'domcontentloaded' }).catch(() => {}),
    join.click()
  ]);
  await ready(guest);
  is(await guest.$('#whoQ'), null, 'never asked — somebody else already said');
  is(await guest.evaluate(() => (state.people[meId] || {}).name || '').then(n => /Hazvineyi/.test(n)),
     true, 'and it opened as the person the link named');

  section('and that cannot be re-answered, which is the whole value of it');
  await guest.click('#who');
  await guest.waitForTimeout(400);
  is(await guest.evaluate(() => (state.people[meId] || {}).name || '').then(n => /Hazvineyi/.test(n)),
     true, 'still the person the link named');
  is(await guest.evaluate(() => $('who').classList.contains('fixed')), true,
     'and the button says it is settled rather than pretending it can change');
  const told = await guest.textContent('#live');
  is(/link was made for/.test(told), true, 'saying why: ' + told);

  await guestCtx.close();
  await ctx.close();
  await first.ctx.close();
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
