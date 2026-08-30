// Choosing how the tree looks, in a real browser.
//
// The palette definitions are checked headlessly in test/palettes.test.js —
// every token present, everything legible. What can only be checked here is
// the part somebody touches: that picking a palette changes the page at once,
// that it survives a reload, that light and dark stay independent of it, and
// that the swatches redraw to the face you would actually get.
//
// Not part of `npm test` — it needs Chromium. Run:
//
//   npx http-server public -p 3930 -s &
//   NODE_PATH=$(npm root -g) node test/browser/look.js

const { chromium } = require('playwright');

const BASE = process.env.MW_BASE_URL || 'http://127.0.0.1:3930/';
const EXE  = process.env.MW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let pass = 0, fail = 0;
const ok  = m => { pass++; console.log('  ok   ' + m); };
const bad = (m, d) => { fail++; console.log('  FAIL ' + m + (d ? '  — ' + d : '')); };
const is  = (a, b, m) => a === b ? ok(m) : bad(m, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const section = t => console.log('\n' + t);

const FAMILY = JSON.stringify({
  people:{ p1:{id:'p1',name:'Sekuru Chenjerai',sex:'m',totem:'Nzou',born:'1908',root:true},
           p2:{id:'p2',name:'Baba Rufaro',sex:'m',totem:'Nzou',born:'1940'} },
  unions:{ u1:{id:'u1',partners:['p1'],children:['p2']} },
  rootId:'p1', seq:9, notDuplicates:[], lexicon:{}
});

// What the page is actually painted with right now.
const token = (page, name) => page.evaluate(
  n => getComputedStyle(document.documentElement).getPropertyValue('--' + n).trim(), name);

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const ctx = await browser.newContext({ viewport:{ width:1180, height:820 },
                                         colorScheme: 'light' });
  await ctx.route('**', r => r.request().url().startsWith(BASE) ? r.continue() : r.abort());
  const page = await ctx.newPage();
  page.on('pageerror', e => bad('page error', e.message));

  await page.goto(BASE, { waitUntil:'domcontentloaded' });
  await page.evaluate(f => localStorage.setItem('muti-baobab-v1', f), FAMILY);
  await page.goto(BASE, { waitUntil:'domcontentloaded' });
  await page.waitForFunction(() => { try { return people().length === 2; } catch(e){ return false; } });

  section('the tree starts in the palette it was designed around');
  is(await page.evaluate(() => document.documentElement.dataset.palette), undefined,
     'no palette attribute is set for the default');
  is(await token(page, 'gold'), '#8A5A16', 'and it is wearing antique brass');
  is(await page.textContent('#look'), 'Baobab', 'the button names it');

  section('the chooser shows every palette, with its colours');
  await page.click('#look');
  await page.waitForSelector('#form .pal');
  const rows = await page.$$eval('#form .pal', bs =>
    bs.map(b => ({ v: b.dataset.palette, label: b.querySelector('u').childNodes[0].textContent,
                   chips: [...b.querySelectorAll('.chips i')].length })));
  is(rows.length >= 5, true, `${rows.length} palettes offered`);
  is(rows.every(r => r.chips === 3), true, 'each showing three colours');
  is(rows.some(r => r.v === 'stone'), true, 'including the black and grey one');
  is(await page.$eval('#form .pal[data-palette=""]', b => b.classList.contains('on')), true,
     'and the current one is marked');

  section('picking one changes the page at once');
  await page.click('#form .pal[data-palette="stone"]');
  await page.waitForTimeout(250);
  is(await page.evaluate(() => document.documentElement.dataset.palette), 'stone',
     'the page is in Stone');
  is(await token(page, 'gold'), '#2F3338', 'the accent is graphite now');
  is(await token(page, 'sky'), '#F4F4F5', 'and the sky behind the tree is grey');
  is(await page.textContent('#look'), 'Stone', 'the button follows');
  is(await page.$eval('#form .pal[data-palette="stone"]', b => b.classList.contains('on')), true,
     'and so does the mark in the panel');

  section('it survives a reload, because it is the family’s own choice');
  await page.reload({ waitUntil:'domcontentloaded' });
  await page.waitForFunction(() => { try { return people().length === 2; } catch(e){ return false; } });
  is(await page.evaluate(() => document.documentElement.dataset.palette), 'stone',
     'still Stone');
  is(await token(page, 'gold'), '#2F3338', 'still graphite');

  section('light and dark are a separate choice from the colours');
  await page.click('#look');
  await page.waitForSelector('#form .pal');
  await page.click('#form [data-theme="dark"]');
  await page.waitForTimeout(250);
  is(await page.evaluate(() => document.documentElement.dataset.theme), 'dark', 'now dark');
  is(await page.evaluate(() => document.documentElement.dataset.palette), 'stone',
     'and STILL Stone — choosing night did not throw the colours away');
  is(await token(page, 'sky'), '#0B0C0E', 'wearing the dark face of Stone');
  is(await token(page, 'gold'), '#C9CDD3', 'with its accent inverted');

  section('and the swatches redraw to the face you would get');
  const darkChip = await page.$eval('#form .pal[data-palette="msasa"] .chips i',
                                    i => i.style.background);
  is(/16, 10, 8|#100A08/i.test(darkChip), true,
     'the Msasa swatch shows its night sky: ' + darkChip);
  await page.click('#form [data-theme="light"]');
  await page.waitForTimeout(250);
  const lightChip = await page.$eval('#form .pal[data-palette="msasa"] .chips i',
                                     i => i.style.background);
  is(/245, 238, 233|#F5EEE9/i.test(lightChip), true,
     'and its day sky once the setting changes: ' + lightChip);

  section('going back to the default clears the attribute rather than naming it');
  await page.click('#form .pal[data-palette=""]');
  await page.waitForTimeout(250);
  is(await page.evaluate(() => document.documentElement.dataset.palette), undefined,
     'no attribute');
  is(await token(page, 'gold'), '#8A5A16', 'and antique brass is back');

  section('every palette actually paints something different');
  const seen = new Set();
  for (const v of ['', 'stone', 'msasa', 'miombo', 'indigo']){
    await page.click(`#form .pal[data-palette="${v}"]`);
    await page.waitForTimeout(150);
    seen.add([await token(page, 'sky'), await token(page, 'gold'),
              await token(page, 'bark')].join('|'));
  }
  is(seen.size, 5, 'five palettes, five distinct looks');

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
