// Two relatives editing the same tree at the same time.
//
// This is the claim the whole storage rewrite exists to make good on, and it
// cannot be checked anywhere but here: two real browsers, one server, one
// database. The old page sent the whole tree on every save, so whoever saved
// second replaced the first one's work with a copy of the tree that predated
// it — silently. These drive that exact sequence and assert it no longer
// happens.
//
// Not part of `npm test` — needs Chromium and a live server. Run:
//
//   DATABASE_URL=... PORT=3940 node server.js &
//   MW_BASE_URL=http://127.0.0.1:3940/ NODE_PATH=$(npm root -g) \
//     node test/browser/concurrent.js

const { chromium } = require('playwright');

const BASE = process.env.MW_BASE_URL || 'http://127.0.0.1:3940/';
const EXE  = process.env.MW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let pass = 0, fail = 0;
const ok  = m => { pass++; console.log('  ok   ' + m); };
const bad = (m, d) => { fail++; console.log('  FAIL ' + m + (d ? '  — ' + d : '')); };
const is  = (a, b, m) => a === b ? ok(m) : bad(m, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const section = t => console.log('\n' + t);

const ready = page => page.waitForFunction(
  () => { try { return store === 'shared' && !!treeId; } catch (e) { return false; } },
  null, { timeout: 20000 });

const names = page => page.evaluate(() => people().map(p => p.name).sort());
const settle = (page, ms = 1200) => page.waitForTimeout(ms);

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });

  const open = async (who) => {
    const ctx = await browser.newContext({ viewport:{ width:1280, height:900 } });
    await ctx.route('**', r => r.request().url().startsWith(BASE) ? r.continue() : r.abort());
    const page = await ctx.newPage();
    page.on('pageerror', e => bad(`page error (${who})`, e.message));
    await page.goto(BASE, { waitUntil:'domcontentloaded' });
    await ready(page);
    return { ctx, page };
  };

  // ── Rudo plants the family ───────────────────────────────────────────
  section('one person plants a tree');
  const a = await open('Rudo');
  await a.page.evaluate(() => {
    state.rootId = addPerson('Rufaro Moyo', 'm', 'Shumba', '1940', '');
    save();
  });
  await settle(a.page);
  is((await names(a.page)).length, 1, 'the first person is recorded');
  const rootId = await a.page.evaluate(() => Object.keys(state.people)[0]);
  is(/^[0-9a-f-]{36}$/.test(rootId), true,
     'and carries a server id, not a local one: ' + rootId);

  // ── Tendai opens the same tree in another browser ────────────────────
  section('a second person opens the same tree and sees it');
  const b = await open('Tendai');
  is((await names(b.page)).length, 1, 'the tree is there');
  is((await names(b.page))[0], 'Rufaro Moyo', 'with the right person in it');
  is(await b.page.evaluate(() => treeId), await a.page.evaluate(() => treeId),
     'both are on the same tree');

  // ── the old killer: simultaneous additions ───────────────────────────
  section('both add a different relative at the same time');
  // Neither page has seen the other's addition when it saves. Under the old
  // whole-tree save, whichever landed second erased the other.
  await Promise.all([
    a.page.evaluate(id => { grow('child', id, 'Garikai', 'm', '', { born:'1968' }); save(); }, rootId),
    b.page.evaluate(id => { grow('child', id, 'Tendai', 'm', '', { born:'1971' }); save(); }, rootId)
  ]);
  await settle(a.page, 2500);
  await settle(b.page, 2500);

  const afterA = await names(a.page), afterB = await names(b.page);
  is(afterA.length, 3, 'the first page holds all three: ' + afterA.join(', '));
  is(afterB.length, 3, 'so does the second: ' + afterB.join(', '));
  is(afterA.join(), ['Garikai', 'Rufaro Moyo', 'Tendai'].join(), 'nobody was erased');
  is(afterB.join(), afterA.join(), 'and both pages agree');

  // ── and the database agrees with both of them ────────────────────────
  section('the database holds one tree, not one page’s idea of it');
  const server = await a.page.evaluate(async () => {
    const r = await fetch(`/api/tree/${treeId}/tree`);
    const d = await r.json();
    return d.people.map(p => p.name).sort();
  });
  is(server.join(), ['Garikai', 'Rufaro Moyo', 'Tendai'].join(),
     'all three are in Postgres: ' + server.join(', '));

  // ── other people's work arrives without a reload ─────────────────────
  section('a change made elsewhere arrives on its own');
  await b.page.evaluate(id => { grow('partner', id, 'Chipo Moyo', 'f', '', { born:'1945' }); save(); }, rootId);
  await settle(b.page);
  await a.page.waitForFunction(
    () => people().some(p => p.name === 'Chipo Moyo'), null, { timeout: 15000 })
    .then(() => ok('the first page picked it up without reloading'),
          () => bad('the first page never saw it'));

  // ── editing the same person at once ──────────────────────────────────
  section('two corrections to the same person, at the same time');
  // Both pages are holding the same version token. The first write moves it;
  // the second must be refused rather than applied on top.
  await a.page.evaluate(id => { state.people[id].born = '1941'; save(); }, rootId);
  await settle(a.page, 1800);
  // The second page still holds the pre-edit version, and edits from there.
  await b.page.evaluate(id => {
    synced.people[id].v = '1970-01-01T00:00:00.000Z';   // a stale version token
    state.people[id].born = '1939';
    save();
  }, rootId);
  await settle(b.page, 2500);

  const bornOnServer = await a.page.evaluate(async () => {
    const r = await fetch(`/api/tree/${treeId}/tree`);
    const d = await r.json();
    return d.people.find(p => p.name === 'Rufaro Moyo').born;
  });
  is(bornOnServer, '1941', 'the first correction stands');
  is(await b.page.evaluate(id => state.people[id].born, rootId), '1941',
     'and the second page was refreshed to it rather than overwriting');
  is(await b.page.isVisible('#others'), true, 'the second editor was told');

  // ── nothing was lost anywhere ────────────────────────────────────────
  section('and after all of that, one tree that everybody agrees on');
  await settle(a.page, 1500);
  const finalA = await names(a.page), finalB = await names(b.page);
  is(finalA.join(), ['Chipo Moyo', 'Garikai', 'Rufaro Moyo', 'Tendai'].join(),
     'the first page: ' + finalA.join(', '));
  is(finalB.join(), finalA.join(), 'the second page agrees');

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
