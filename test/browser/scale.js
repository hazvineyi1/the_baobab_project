// Does the page stay usable as a family gets large?
//
// THE THING THIS EXISTS TO CATCH. render() used to run the duplicate scan —
// every person against every other one, walking the unions inside each
// comparison — on every redraw. It is quadratic with a rescan inside, so it
// does not degrade, it falls off a cliff: measured on this tree, 200 people
// took a second per frame, 400 took five and a half, 800 took thirty-five.
//
// The scan now runs on the server, which blocks candidates into buckets, and
// the page paints a cached answer. This suite builds a family big enough for
// the old code to have been unusable and asserts that a redraw is quick — and
// prints what the old path would have cost on the same tree, so the number is
// a measurement rather than a claim.
//
// It also checks the feature still WORKS, which is the half a speed test
// forgets: a scan that finds nothing is very fast.
//
// Not part of `npm test` — needs Chromium and a live server. Run:
//
//   DATABASE_URL=... PORT=3940 node server.js &
//   MW_BASE_URL=http://127.0.0.1:3940/ APP_PASSPHRASE=... \
//     NODE_PATH=$(npm root -g) node test/browser/scale.js

const { chromium } = require('playwright');
const { BASE, EXE, openApp, ready, settled } = require('./lib');

// Big enough that the old render path took seconds, small enough to build in
// a test. The cliff is steep: doubling this roughly quintuples the old cost.
const PEOPLE = 400;

// A redraw happens on every pan, zoom, selection and keystroke, so the budget
// is a frame's worth of room, not a page load's. Generous against the machine
// this runs on, and still two orders of magnitude under what it was.
const RENDER_BUDGET_MS = 400;

let pass = 0, fail = 0;
const ok  = m => { pass++; console.log('  ok   ' + m); };
const bad = (m, d) => { fail++; console.log('  FAIL ' + m + (d ? '  — ' + d : '')); };
const is  = (a, b, m) => a === b ? ok(m) : bad(m, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const section = t => console.log('\n' + t);

/* A family of PEOPLE people in generations of eight, with a handful of
   deliberate duplicates planted in it — the same name entered twice with a
   title on one of them, which is the commonest way a real family produces
   one. Without those the scan would have nothing to find and a speed test
   would prove nothing. */
function buildOps(n, tag) {
  const NAMES = ['Chenjerai','Rufaro','Tendai','Garikai','Nyarai','Farai','Tapiwa',
                 'Chipo','Munashe','Tariro','Shingai','Rudo','Takudzwa','Anesu'];
  const ops = [];
  const ids = [];
  for (let i = 0; i < n; i++) {
    const ref = '$p' + i;
    ids.push(ref);
    ops.push({ op:'addPerson', ref, name: `${NAMES[i % NAMES.length]}${i} ${tag}`,
               sex: i % 2 ? 'f' : 'm', totem: 'Nzou', born: String(1900 + (i % 90)) });
  }
  // Couples and their children, so the tree has real shape to walk rather
  // than being a list — the union walking is half of what made it slow.
  let u = 0;
  for (let i = 0; i + 1 < n; i += 2) {
    const uref = '$u' + (u++);
    ops.push({ op:'addUnion', ref: uref });
    ops.push({ op:'addPartner', unionId: uref, personId: ids[i] });
    ops.push({ op:'addPartner', unionId: uref, personId: ids[i + 1] });
    const kid = i + 2 + (i % 6);
    if (kid < n) ops.push({ op:'addChild', unionId: uref, personId: ids[kid] });
  }
  return ops;
}

function plantedDuplicates(tag) {
  // Two records of one woman: the same name, one of them with the title her
  // grandchildren would use, and both married to the same man.
  return [
    { op:'addPerson', ref:'$dupA', name:`Ambuya Chiedza ${tag}`, sex:'f', totem:'Shava', born:'1931' },
    { op:'addPerson', ref:'$dupB', name:`Chiedza ${tag}`,        sex:'f', totem:'Shava', born:'1931' },
    { op:'addPerson', ref:'$hus',  name:`Mudhara Zvikomborero ${tag}`, sex:'m', totem:'Nzou', born:'1928' },
    { op:'addUnion', ref:'$du1' },
    { op:'addPartner', unionId:'$du1', personId:'$hus' },
    { op:'addPartner', unionId:'$du1', personId:'$dupA' },
    { op:'addUnion', ref:'$du2' },
    { op:'addPartner', unionId:'$du2', personId:'$hus' },
    { op:'addPartner', unionId:'$du2', personId:'$dupB' }
  ];
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const { ctx, page } = await openApp(browser, { viewport:{ width:1280, height:960 } });
  page.on('pageerror', e => bad('page error', e.message));
  await ready(page);

  const TAG = 'Big' + Date.now().toString(36).slice(-5);

  section(`building a family of ${PEOPLE + 3}`);
  // Its own family, so the numbers mean something and nobody else's tree gets
  // four hundred strangers in it.
  const made = await page.evaluate(async name => {
    const r = await fetch('/api/trees', {
      method:'POST', headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ name })
    });
    const d = await r.json();
    return { id: d.id, key: d.key };
  }, TAG + ' family');
  is(/^[0-9a-f-]{36}$/.test(made.id), true, 'a family to fill');

  const ops = buildOps(PEOPLE, TAG).concat(plantedDuplicates(TAG));
  // ONE batch, not several. A $ref is minted inside the batch that declares
  // it — that is what makes a batch all-or-nothing — so a union split from the
  // people it joins would be a union referring to names that no longer exist.
  await page.evaluate(async ([id, all]) => {
    const r = await fetch(`/api/tree/${id}/ops`, {
      method:'POST', headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ ops: all })
    });
    if (!r.ok) throw new Error('ops answered ' + r.status + ' ' + (await r.text()).slice(0, 200));
  }, [made.id, ops]);

  section('the page opens on it');
  await page.goto(BASE + '#/f/' + made.key, { waitUntil:'domcontentloaded' });
  await ready(page);
  await settled(page);
  const count = await page.evaluate(() => people().length);
  is(count, PEOPLE + 3, `${count} people on the page`);

  section('A REDRAW IS QUICK');
  // Several, and the median: the first one after a load pays for layout that
  // has nothing to do with this.
  const times = await page.evaluate(() => {
    const runs = [];
    for (let i = 0; i < 7; i++) {
      const t = performance.now();
      render();
      runs.push(performance.now() - t);
    }
    return runs.sort((a, b) => a - b);
  });
  const median = times[3];
  console.log(`       renders (ms): ${times.map(t => t.toFixed(0)).join(' ')}`);
  is(median < RENDER_BUDGET_MS, true,
     `median redraw ${median.toFixed(0)}ms, under the ${RENDER_BUDGET_MS}ms budget`);

  section('and what the old path would have cost on this same tree');
  // duplicatePairs() is still there — it is the reference the server's blocked
  // scan is tested against. This calls it directly to measure what render()
  // used to do on every frame.
  const oldCost = await page.evaluate(() => {
    const t = performance.now();
    const n = duplicatePairs().length;
    return { ms: performance.now() - t, n };
  });
  console.log(`       the exhaustive scan: ${oldCost.ms.toFixed(0)}ms for ${oldCost.n} pairs`);
  is(oldCost.ms > median, true,
     `it costs ${(oldCost.ms / Math.max(median, 0.01)).toFixed(0)}× a redraw — ` +
     `which is why it is not in one`);

  section('THE FEATURE STILL WORKS — a fast scan that finds nothing is not a fix');
  await page.waitForFunction(() => dupes && dupes.from === 'server', { timeout: 20000 });
  is(await page.evaluate(() => dupes.from), 'server', 'the answer came from the server');
  const likely = await page.evaluate(() => dupes.likely.length);
  is(likely >= 1, true, `${likely} likely duplicate(s) found`);
  is(await page.isVisible('#dupes'), true, 'and the chip says so');

  section('the planted pair is the one it found');
  await page.click('#dupes');
  await page.waitForSelector('#form .pair', { timeout: 10000 });
  const panel = await page.textContent('#form');
  is(/Chiedza/.test(panel), true, 'the woman entered twice is named');
  is(/Very likely one person/.test(panel), true,
     'and called likely — on the shared husband, not on the name');
  is(/both married to/.test(panel), true, 'with the reason given');

  section('the panel opens from a cache, so it opens at once');
  await page.click('#dNo');
  const openMs = await page.evaluate(async () => {
    const t = performance.now();
    openDuplicates();
    return performance.now() - t;
  });
  console.log(`       opening the panel: ${openMs.toFixed(0)}ms`);
  is(openMs < 500, true, `${openMs.toFixed(0)}ms — it reads, it does not scan`);
  await page.click('#dNo');

  section('an edit makes the answer stale, and it is asked again');
  await page.evaluate(() => { dupes = { pairs:[], likely:[], from:'stale', scanning:false, tooBig:false }; });
  await page.evaluate(t => { addPerson('Someone Else ' + t, 'm', 'Nzou', '1970', ''); save(); }, TAG);
  await page.waitForFunction(() => dupes.from === 'server', { timeout: 20000 });
  is(await page.evaluate(() => dupes.from), 'server', 'the scan ran again after the edit');
  is(await page.evaluate(() => dupes.likely.length) >= 1, true,
     'and still finds the pair');

  await ctx.close();
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
