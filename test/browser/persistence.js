// The shared tree must survive everything except a deliberate, announced act.
//
// Each check here reproduces a way the family's tree could be lost without
// anybody pressing a delete button. They are written against a mock server
// that can be told to misbehave, because the failures that erase data are
// exactly the ones a healthy server never produces.
//
// Not part of `npm test` — it needs Chromium and the mock server. Run:
//
//   node test/browser/mock-server.js &
//   NODE_PATH=$(npm root -g) node test/browser/persistence.js

const { chromium } = require('playwright');

const BASE = process.env.MW_BASE_URL || 'http://127.0.0.1:3931/';
const EXE  = process.env.MW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let pass = 0, fail = 0;
const ok  = m => { pass++; console.log('  ok   ' + m); };
const bad = (m, d) => { fail++; console.log('  FAIL ' + m + (d ? '  — ' + d : '')); };
const is  = (a, b, m) => a === b ? ok(m) : bad(m, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const section = t => console.log('\n' + t);

// A tree with four people in it, as the server would be holding it.
const FAMILY = JSON.stringify({
  people: {
    p1:{ id:'p1', name:'Sekuru Chenjerai', sex:'m', born:'1920', root:true },
    p2:{ id:'p2', name:'Baba Tendai',      sex:'m', born:'1950' },
    p3:{ id:'p3', name:'Amai Rudo',        sex:'f', born:'1955' },
    p4:{ id:'p4', name:'Farai',            sex:'m', born:'1980' }
  },
  unions: {
    u1:{ id:'u1', partners:['p1'],      children:['p2'] },
    u2:{ id:'u2', partners:['p2','p3'], children:['p4'] }
  },
  rootId:'p4', seq:9, notDuplicates:[], lexicon:{}
});

// This sandbox cannot reach fonts.googleapis.com, and waiting for it to time
// out on every navigation is slower than the whole suite. Nothing under test
// depends on the fonts loading.
async function offline(ctx){
  await ctx.route('**', route => {
    const u = route.request().url();
    if (u.startsWith('http://127.0.0.1:3931')) return route.continue();
    return route.abort();
  });
}
const go = (page, url) => page.goto(url, { waitUntil: 'domcontentloaded' });

const ctl = (page, mode) => page.evaluate(
  (m) => fetch('/__mode', { headers:{ 'x-mode': m } }).then(r => r.text()), mode);
const serverBlob = page => page.evaluate(() => fetch('/__blob').then(r => r.json()));
const seed = page => page.evaluate(
  b => fetch('/__seed', { method:'POST', body:b }).then(r => r.text()), FAMILY);

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });

  // Each check gets its own browser context, so one page's localStorage can
  // never stand in for the shared copy in the next.
  const fresh = async (mode) => {
    const ctx = await browser.newContext({ viewport:{ width:1280, height:900 } });
    await offline(ctx);
    const page = await ctx.newPage();
    page.on('pageerror', e => bad('page error', e.message));
    await go(page, BASE);
    await seed(page);
    await ctl(page, mode || 'ok');
    await go(page, BASE);
    await page.waitForFunction(() => typeof store === 'string');
    return { ctx, page };
  };

  // ── the tree is there when you arrive ─────────────────────────────────
  section('a second person opening the page sees the first person’s work');
  {
    const { ctx, page } = await fresh('ok');
    is(await page.evaluate(() => store), 'shared', 'the page knows it is on the shared tree');
    is(await page.evaluate(() => people().length), 4, 'all four relatives loaded');
    is(await page.evaluate(() => state.people.p1.root), true, 'the root flag came with them');

    // Add somebody, as the second person would.
    await page.evaluate(() => { grow('child', 'p4', 'Ruvarashe', 'f', '', { born:'2005' }); save(); });
    await page.waitForTimeout(700);
    const after = await serverBlob(page);
    is(JSON.parse(after.blob).people ? Object.keys(JSON.parse(after.blob).people).length : 0, 5,
       'the addition reached the server');
    await ctx.close();
  }

  section('and it is still there after that browser is gone');
  {
    // A brand-new context: no localStorage, nothing carried over. This is
    // what "someone logs out and someone else logs in" actually looks like.
    const ctx = await browser.newContext();
    await offline(ctx);
    const page = await ctx.newPage();
    await go(page, BASE);
    await page.waitForFunction(() => typeof store === 'string');
    is(await page.evaluate(() => people().length), 5, 'the next person sees five, not zero');
    is(await page.evaluate(() => localStorage.getItem('muti-baobab-v1')), null,
       'nothing was kept in this browser — the server is the copy');
    await ctx.close();
  }

  // ── the ways it used to be erased ─────────────────────────────────────
  section('a shared tree that will not parse is never overwritten');
  {
    const { ctx, page } = await fresh('corrupt');
    is(await page.evaluate(() => store), 'stalled', 'the page refuses to call itself connected');
    is(await page.isVisible('#stalled'), true, 'and says so on screen');
    const before = (await serverBlob(page)).writes;
    await page.evaluate(() => { grow('child', 'p4', 'Ghost', 'm', '', {}); save(); });
    await page.waitForTimeout(700);
    is((await serverBlob(page)).writes, before, 'no write was attempted');
    is(JSON.parse((await serverBlob(page)).blob).people.p1.name, 'Sekuru Chenjerai',
       'the family on the server is untouched');
    await ctx.close();
  }

  section('a server error is not treated as an empty tree');
  {
    const { ctx, page } = await fresh('error5');
    is(await page.evaluate(() => store), 'stalled', 'a 500 stalls the page');
    is(/answered 500/.test(await page.textContent('#stalled')), true, 'and the reason is shown');
    await page.evaluate(() => { grow('child', 'p4', 'Ghost', 'm', '', {}); save(); });
    await page.waitForTimeout(700);
    is((await serverBlob(page)).writes, 0, 'still no write');
    await ctx.close();
  }

  section('a retired endpoint stalls rather than silently going local');
  {
    const { ctx, page } = await fresh('gone410');
    is(await page.evaluate(() => store), 'stalled', 'a 410 stalls the page');
    is(/retired/.test(await page.textContent('#stalled')), true, 'and explains itself');
    await ctx.close();
  }

  section('a failed write stops, rather than forking into this browser');
  {
    const { ctx, page } = await fresh('ok');
    is(await page.evaluate(() => store), 'shared', 'starts connected');
    await ctl(page, 'writefail');
    await page.evaluate(() => { grow('child', 'p4', 'Tapiwa', 'm', '', {}); save(); });
    await page.waitForTimeout(900);
    is(await page.evaluate(() => store), 'stalled', 'the page notices the write failed');
    is(await page.isVisible('#stalled'), true, 'and says so');
    is(await page.evaluate(() => localStorage.getItem('muti-baobab-v1')), null,
       'the tree was NOT quietly copied into this browser instead');
    await ctx.close();
  }

  section('no API on this origin is genuinely local, and still works');
  {
    const ctx = await browser.newContext();
    await offline(ctx);
    const page = await ctx.newPage();
    await go(page, BASE);
    await ctl(page, 'notfound');
    await go(page, BASE);
    await page.waitForFunction(() => typeof store === 'string');
    is(await page.evaluate(() => store), 'local', 'a 404 means no server here');
    is(await page.isVisible('#stalled'), false, 'nothing is wrong, so nothing is said');
    await page.evaluate(() => { addPerson('Solo', 'm', '', '', ''); save(); });
    await page.waitForTimeout(700);
    is(await page.evaluate(() => !!localStorage.getItem('muti-baobab-v1')), true,
       'and it keeps the tree in this browser');
    await ctx.close();
  }

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
