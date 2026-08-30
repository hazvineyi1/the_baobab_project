// The tree must survive everything except a deliberate, announced act.
//
// Each check reproduces a way the family's work could be lost without anybody
// pressing a delete button. They run against the REAL server with failures
// injected into the network, because the failures that lose data are exactly
// the ones a healthy server never produces — and mocking the server instead
// would test the mock.
//
// Not part of `npm test` — needs Chromium and a live server. Run:
//
//   DATABASE_URL=... PORT=3940 node server.js &
//   MW_BASE_URL=http://127.0.0.1:3940/ NODE_PATH=$(npm root -g) \
//     node test/browser/persistence.js

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

  // `broken` names which request to sabotage, and how.
  const open = async (broken) => {
    const ctx = await browser.newContext({ viewport:{ width:1280, height:900 } });
    await ctx.route('**', route => {
      const url = route.request().url();
      if (!url.startsWith(BASE)) return route.abort();
      const path = url.slice(BASE.length - 1);
      if (broken && broken.match.test(path)) return broken.act(route);
      return route.continue();
    });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil:'domcontentloaded' });
    await page.waitForFunction(() => typeof store === 'string', null, { timeout: 20000 });
    return { ctx, page };
  };

  const serverNames = async (page) => page.evaluate(async (base) => {
    const h = await fetch('/api/home').then(r => r.json());
    const d = await fetch(`/api/tree/${h.treeId}/tree`).then(r => r.json());
    return d.people.map(p => p.name).sort();
  }, BASE);

  // ── the tree is there, and it persists ────────────────────────────────
  section('what one person records, the next person finds');
  {
    const { ctx, page } = await open(null);
    is(await page.evaluate(() => store), 'shared', 'the page is on the shared tree');
    const before = (await page.evaluate(() => people().length));
    await page.evaluate(() => { addPerson('Mbuya Nyarai', 'f', 'Moyo', '1930', ''); save(); });
    await page.waitForTimeout(1500);
    is((await page.evaluate(() => people().length)), before + 1, 'the addition is on screen');
    is((await serverNames(page)).includes('Mbuya Nyarai'), true, 'and reached the database');
    await ctx.close();

    // A brand-new browser: no localStorage, nothing carried over. This is what
    // "someone logs out and someone else logs in" actually looks like.
    const two = await open(null);
    is((await two.page.evaluate(() => people().map(p => p.name)))
        .includes('Mbuya Nyarai'), true, 'a fresh browser sees it');
    is(await two.page.evaluate(() => localStorage.getItem('muti-baobab-v1')), null,
       'and kept nothing locally — the database is the copy');
    await two.ctx.close();
  }

  // ── the ways it could be lost ─────────────────────────────────────────
  section('a tree that will not parse is never written over');
  {
    const { ctx, page } = await open({
      match: /\/api\/tree\/[^/]+\/tree/,
      act: route => route.fulfill({ status:200, contentType:'application/json',
                                    body:'{ truncated half way' })
    });
    is(await page.evaluate(() => store), 'stalled', 'the page refuses to call itself connected');
    is(await page.isVisible('#stalled'), true, 'and says so on screen');
    await page.evaluate(() => { addPerson('Ghost', 'm', '', '', ''); save(); });
    await page.waitForTimeout(1200);
    await ctx.close();

    const check = await open(null);
    is((await check.page.evaluate(() => people().map(p => p.name))).includes('Ghost'), false,
       'nothing was written');
    is((await check.page.evaluate(() => people().map(p => p.name))).includes('Mbuya Nyarai'), true,
       'and the family on the server is untouched');
    await check.ctx.close();
  }

  section('a server error is not mistaken for an empty tree');
  {
    const { ctx, page } = await open({
      match: /\/api\/tree\/[^/]+\/tree/,
      act: route => route.fulfill({ status:500, body:'boom' })
    });
    is(await page.evaluate(() => store), 'stalled', 'a 500 stalls the page');
    is(await page.evaluate(() => people().length), 0, 'it holds no tree');
    is(/could not be read/.test(await page.textContent('#stalled')), true, 'and says why');
    await ctx.close();
  }

  section('a connection that drops does not fork the tree into this browser');
  {
    const { ctx, page } = await open({
      match: /\/api\/home/, act: route => route.abort()
    });
    is(await page.evaluate(() => store), 'stalled', 'no answer at all stalls the page');
    is(await page.evaluate(() => localStorage.getItem('muti-baobab-v1')), null,
       'and nothing was quietly kept here instead');
    await ctx.close();
  }

  section('a failed write stops, rather than looking like a save');
  {
    const { ctx, page } = await open({
      match: /\/ops$/, act: route => route.fulfill({ status:500, body:'nope' })
    });
    is(await page.evaluate(() => store), 'shared', 'it starts connected');
    await page.evaluate(() => { addPerson('Unsaved', 'm', '', '', ''); save(); });
    await page.waitForTimeout(1500);
    is(await page.evaluate(() => store), 'stalled', 'the page notices the write failed');
    is(await page.isVisible('#stalled'), true, 'and says so');
    is(await page.evaluate(() => localStorage.getItem('muti-baobab-v1')), null,
       'the tree was NOT quietly copied into this browser instead');
    await ctx.close();

    const check = await open(null);
    is((await check.page.evaluate(() => people().map(p => p.name))).includes('Unsaved'), false,
       'and the failed addition did not reach the database');
    await check.ctx.close();
  }

  section('no API on this origin is genuinely local, and still works');
  {
    const { ctx, page } = await open({
      match: /\/api\/home/, act: route => route.fulfill({ status:404, body:'nf' })
    });
    is(await page.evaluate(() => store), 'local', 'a 404 means no server here');
    is(await page.isVisible('#stalled'), false, 'nothing is wrong, so nothing is said');
    await page.evaluate(() => { addPerson('Solo', 'm', '', '', ''); save(); });
    await page.waitForTimeout(1200);
    is(await page.evaluate(() => !!localStorage.getItem('muti-baobab-v1')), true,
       'and it keeps the tree in this browser');
    await ctx.close();
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
