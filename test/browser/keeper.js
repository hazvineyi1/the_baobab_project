// The keeper's dashboard, in a real browser.
//
// The HTTP suite (test/admin.test.js) proves the rules. This proves the page:
// that every tab actually renders, that the one-time passcode really appears
// where a person can read it, and that the buttons do what they say. A
// dashboard that throws on load is a dashboard whose rules nobody can use.
//
// Not part of `npm test` — needs Chromium and a live server with an admin
// passphrase. Run:
//
//   DATABASE_URL=... MW_ADMIN_PASSPHRASE=... PORT=3940 node server.js &
//   MW_BASE_URL=http://127.0.0.1:3940/ MW_ADMIN_PASSPHRASE=... \
//     NODE_PATH=$(npm root -g) node test/browser/keeper.js

const { chromium } = require('playwright');
const { BASE, EXE, onlyThisOrigin } = require('./lib');

const ADMIN = process.env.MW_ADMIN_PASSPHRASE || '';

let pass = 0, fail = 0;
const ok  = m => { pass++; console.log('  ok   ' + m); };
const bad = (m, d) => { fail++; console.log('  FAIL ' + m + (d ? '  — ' + d : '')); };
const is  = (a, b, m) => a === b ? ok(m) : bad(m, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const section = t => console.log('\n' + t);

(async () => {
  if (!ADMIN) {
    console.error('MW_ADMIN_PASSPHRASE must be set for this suite');
    process.exit(2);
  }
  const browser = await chromium.launch({ executablePath: EXE });
  const ctx = await browser.newContext({ viewport:{ width:1200, height:1000 } });
  await onlyThisOrigin(ctx);
  const page = await ctx.newPage();

  // Any exception on this page is a failure, not a warning: it is the only
  // screen where a silent error means the keeper is looking at stale numbers
  // and does not know it.
  page.on('pageerror', e => bad('page error', e.message));

  section('the keeper signs in and lands on the dashboard');
  await page.goto(BASE + 'gate', { waitUntil:'domcontentloaded' });
  await page.fill('input[name="passphrase"]', ADMIN);
  await Promise.all([
    page.waitForNavigation({ waitUntil:'domcontentloaded' }).catch(() => {}),
    page.click('button[type=submit]')
  ]);
  is(new URL(page.url()).pathname, '/admin', 'taken to /admin, not to a family');
  await page.waitForSelector('#tiles .tile', { timeout: 15000 });

  section('the overview has numbers and a chart');
  const tiles = await page.$$eval('#tiles .tile .n', ns => ns.map(n => n.textContent.trim()));
  is(tiles.length >= 6, true, `${tiles.length} tiles`);
  is(tiles.every(t => /^[\d,]+$/.test(t)), true, 'every one of them a number: ' + tiles.join(' '));
  await page.waitForSelector('#charts .strip', { timeout: 10000 });
  is((await page.$$('#charts .strip')).length, 3, 'three separate measures, three strips');
  is((await page.$$('#charts .strip .bars .b')).length, 42, 'fourteen days each');
  // Each strip carries its own peak, which is what a shared axis would have
  // carried — and the reason there is no shared axis.
  const peaks = await page.$$eval('#charts .peak', ps => ps.map(p => p.textContent));
  is(peaks.every(p => /peak \d/.test(p)), true, 'each names its own scale');

  section('a family can be found and opened');
  await page.click('nav button[data-tab="families"]');
  await page.waitForSelector('#famTable tbody tr', { timeout: 10000 });
  const rows = await page.$$('#famTable tbody tr');
  is(rows.length > 0, true, `${rows.length} families listed`);
  await page.click('#famTable tbody tr:first-child button[data-open]');
  await page.waitForSelector('#famDetail .kv', { timeout: 10000 });
  const detail = await page.textContent('#famDetail');
  is(/People/.test(detail), true, 'the detail says how many people');
  is(/Passcode/.test(detail), true, 'and where the passcode stands');

  section('THE ONE-TIME PASSCODE IS SHOWN, ONCE, WHERE IT CAN BE READ');
  page.on('dialog', d => d.accept('the family telephoned'));
  await page.click('#famDetail button[data-act="passcode"]');
  await page.waitForSelector('.reveal .code', { timeout: 15000 });
  const shown = (await page.textContent('.reveal .code')).trim();
  is(/^[a-z2-9]{6}-[a-z2-9]{6}-[a-z2-9]{6}$/.test(shown), true,
     'it is a passcode: ' + shown.slice(0, 7) + '…');
  is(/only time/i.test(await page.textContent('.reveal')), true,
     'and it says this is the only time');
  await page.click('#revealDone');
  is(await page.isVisible('.reveal'), false, 'acknowledging it puts it away');
  // And it really is gone — not merely hidden.
  is((await page.content()).includes(shown), false,
     'the passcode is not left lying in the page');

  section('closing a family, and reopening it');
  await page.waitForSelector('#famDetail button[data-act="suspend"]', { timeout: 10000 });
  await page.click('#famDetail button[data-act="suspend"]');
  await page.waitForSelector('#famDetail button[data-act="restore"]', { timeout: 10000 });
  is(/closed/.test(await page.textContent('#famDetail')), true, 'it shows as closed');
  await page.click('#famDetail button[data-act="restore"]');
  await page.waitForSelector('#famDetail button[data-act="suspend"]', { timeout: 10000 });
  is(/open/.test(await page.textContent('#famDetail')), true, 'and open again');

  section('the record reads as who, when, where, what');
  await page.click('nav button[data-tab="activity"]');
  await page.waitForSelector('#evTable tbody tr', { timeout: 10000 });
  const heads = await page.$$eval('#evTable thead th', ts => ts.map(t => t.textContent.trim()));
  is(heads.slice(0, 5).join(' '), 'When What Family Who Where', 'the columns say so');
  const firstRow = await page.textContent('#evTable tbody tr:first-child');
  is(/passcode|family|gate|invite|appeal|session|tree/.test(firstRow), true,
     'and the newest line is one of the kinds it records');

  section('and can be filtered down to one kind');
  await page.selectOption('#evKind', 'passcode');
  await page.click('#evGo');
  await page.waitForTimeout(900);
  const kinds = await page.$$eval('#evTable tbody tr td:nth-child(2)',
    ts => ts.map(t => t.textContent.trim()));
  is(kinds.length > 0 && kinds.every(k => k.startsWith('passcode')), true,
     'passcodes only: ' + [...new Set(kinds)].join(', '));

  section('who is signed in');
  await page.click('nav button[data-tab="sessions"]');
  await page.waitForSelector('#sesTable tbody tr', { timeout: 10000 });
  const sessions = await page.textContent('#sesTable');
  is(/the keeper/.test(sessions), true, 'the keeper\'s own session is in the list');
  is(/muti_gate|token/.test(sessions), false, 'and no cookie or token is shown');

  section('appeals');
  await page.click('nav button[data-tab="appeals"]');
  await page.waitForTimeout(900);
  is((await page.textContent('#apList')).length > 0, true, 'the queue renders');

  section('storage says what is actually being held');
  await page.click('nav button[data-tab="storage"]');
  await page.waitForSelector('#stTable tbody tr', { timeout: 10000 });
  const storage = await page.textContent('#stTable');
  is(/audit_events/.test(storage), true, 'the record is listed');
  is(/audit_events_\d{6}/.test(storage), true,
     'and shows as monthly partitions rather than one table');

  section('signing out ends the keeper\'s session');
  await Promise.all([
    page.waitForNavigation({ waitUntil:'domcontentloaded' }).catch(() => {}),
    page.click('#signOut')
  ]);
  await page.waitForTimeout(400);
  is(/passcode/i.test(await page.textContent('body')), true, 'back at the door');
  await page.goto(BASE + 'admin', { waitUntil:'domcontentloaded' });
  is(await page.$('#tiles .tile'), null, 'and the dashboard does not open again');

  await ctx.close();
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
