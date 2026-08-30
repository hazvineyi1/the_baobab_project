// Setting somebody aside, in a real browser.
//
// The rule is asserted headlessly in test/setaside.frontend.test.js. What can
// only be checked here is the part a relative actually meets: that the ✕ asks
// WHY instead of asking yes/no, that it refuses to proceed without an answer,
// that the person who recorded the entry is told, and that anybody can put it
// back. Also that Clear — one tap from erasing a shared tree — no longer can.
//
// Not part of `npm test` — it needs Chromium. Run:
//
//   npx http-server public -p 3930 -s &
//   NODE_PATH=$(npm root -g) node test/browser/setaside.js

const { chromium } = require('playwright');

const BASE = process.env.MW_BASE_URL || 'http://127.0.0.1:3930/';
const EXE  = process.env.MW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let pass = 0, fail = 0;
const ok  = m => { pass++; console.log('  ok   ' + m); };
const bad = (m, d) => { fail++; console.log('  FAIL ' + m + (d ? '  — ' + d : '')); };
const is  = (a, b, m) => a === b ? ok(m) : bad(m, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const section = t => console.log('\n' + t);

// Rudo entered everyone. Garikai is the one looking.
const FAMILY = {
  people: {
    p1:{ id:'p1', name:'Rufaro Moyo', sex:'m', born:'1940', by:'Rudo', root:true },
    p2:{ id:'p2', name:'Garikai',     sex:'m', born:'1968', by:'Rudo' },
    p3:{ id:'p3', name:'Tendai',      sex:'m', born:'1971', by:'Rudo' },
    p4:{ id:'p4', name:'Ruvarashe',   sex:'f', born:'1995', by:'Rudo' }
  },
  unions: {
    u1:{ id:'u1', partners:['p1'], children:['p2','p3'] },
    u2:{ id:'u2', partners:['p2'], children:['p4'] }
  },
  rootId:'p1', seq:9, notDuplicates:[], lexicon:{}
};

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const ctx = await browser.newContext({ viewport:{ width:1400, height:950 } });
  await ctx.route('**', r => r.request().url().startsWith(BASE) ? r.continue() : r.abort());
  const page = await ctx.newPage();
  page.on('pageerror', e => bad('page error', e.message));

  await page.goto(BASE, { waitUntil:'domcontentloaded' });
  await page.evaluate(f => localStorage.setItem('muti-baobab-v1', JSON.stringify(f)), FAMILY);
  await page.goto(BASE, { waitUntil:'domcontentloaded' });
  await page.waitForFunction(() => { try { return people().length === 4; } catch(e){ return false; } });
  // Garikai is the one looking, so what he sets aside is stamped with his name.
  await page.evaluate(() => { setMe('p2'); });

  const select = async id => {
    await page.evaluate(i => { sel = i; render(); revealBuds(); }, id);
    await page.waitForTimeout(150);
  };

  section('the ✕ asks why, instead of asking yes or no');
  await select('p3');
  await page.click('.pod[data-id="p3"] .rm[data-rm="p3"]');
  await page.waitForSelector('#form');
  const form = await page.textContent('#form');
  is(/Set aside/.test(form), true, 'the form is headed Set aside, not Remove');
  is(/Nothing is deleted/.test(form), true, 'and says outright that nothing is deleted');
  is(/Rudo/.test(form), true, 'it names who recorded them and will be told');
  is(await page.isVisible('#saWhy'), true, 'and there is a box for the reason');

  section('and it will not proceed without one');
  await page.click('#saGo');
  await page.waitForTimeout(200);
  is(await page.isVisible('#form'), true, 'the form stays open');
  is(await page.evaluate(() => !!state.people.p3.aside), false, 'and nobody was set aside');
  await page.fill('#saWhy', '   ');
  await page.click('#saGo');
  await page.waitForTimeout(200);
  is(await page.evaluate(() => !!state.people.p3.aside), false, 'spaces do not count as a reason');

  section('with a reason, they leave the tree and the record stays');
  await page.fill('#saWhy', 'Entered twice — same Tendai as his brother recorded.');
  await page.click('#saGo');
  await page.waitForTimeout(400);
  is(await page.evaluate(() => !!state.people.p3.aside), true, 'they are set aside');
  is(await page.evaluate(() => state.people.p3.name), 'Tendai', 'the record keeps its name');
  is(await page.evaluate(() => state.people.p3.aside.by), 'Garikai', 'stamped with who did it');
  is(await page.evaluate(() => state.people.p3.aside.why),
     'Entered twice — same Tendai as his brother recorded.', 'and with the reason');
  is(await page.evaluate(() => people().length), 3, 'the tree is one smaller');
  is(await page.isVisible('.pod[data-id="p3"]'), false, 'their pod is off the canvas');
  is(await page.textContent('#count'), '3', 'and the tally agrees');

  section('the record survives a reload — it was saved, not just hidden');
  await page.goto(BASE, { waitUntil:'domcontentloaded' });
  await page.waitForFunction(() => { try { return people().length === 3; } catch(e){ return false; } });
  is(await page.evaluate(() => !!state.people.p3), true, 'the person is still in the stored tree');
  is(await page.evaluate(() => state.people.p3.aside.why),
     'Entered twice — same Tendai as his brother recorded.', 'with the reason intact');

  section('the person who recorded them is told');
  await page.evaluate(() => { setMe('p1'); });      // nobody named Rudo yet
  is(await page.evaluate(() => noticesFor('Rudo').length), 1, 'Rudo has one notice');
  // Now look as Rudo: rename the selected person so meName() is Rudo.
  await page.evaluate(() => { state.people.p1.name = 'Rudo'; setMe('p1'); render(); });
  await page.waitForTimeout(200);
  is(await page.isVisible('#aside'), true, 'the bar shows a Set aside button');
  const label = await page.textContent('#aside');
  is(/1 of yours/.test(label), true, 'calling out that one is hers: ' + JSON.stringify(label));
  is(await page.evaluate(() => $('aside').classList.contains('notice')), true,
     'and it is marked as a notice');

  section('the panel says who, why, and offers it back');
  await page.click('#aside');
  await page.waitForSelector('#form');
  const panel = await page.textContent('#form');
  is(/Tendai/.test(panel), true, 'it names the person');
  is(/Entered twice/.test(panel), true, 'it gives the reason');
  is(/Garikai/.test(panel), true, 'and who set them aside');
  is(/Yours/.test(panel), true, 'under a heading saying these are hers');
  is((await page.$$('#form .askrow[data-back="p3"]')).length, 1, 'with a way to put them back');

  section('anyone can put them back');
  await page.click('#form .askrow[data-back="p3"]');
  await page.waitForTimeout(400);
  is(await page.evaluate(() => !!state.people.p3.aside), false, 'they are restored');
  is(await page.evaluate(() => people().length), 4, 'the tree is whole again');
  is(await page.isVisible('.pod[data-id="p3"]'), true, 'their pod is back on the canvas');
  is(await page.isVisible('#aside'), false, 'and the notice button is gone');

  section('Clear no longer erases a shared tree');
  page.on('dialog', d => d.accept());
  await page.click('#clear');
  await page.waitForTimeout(500);
  is(await page.evaluate(() => people().length), 0, 'the tree is emptied');
  is(await page.evaluate(() => Object.keys(state.people).length), 4,
     'but all four records are still there');
  is(await page.evaluate(() => asidePeople().length), 4, 'every one of them set aside');
  is(await page.isVisible('#bar'), true, 'the bar stays, so they are reachable');
  await page.click('#aside');
  await page.waitForSelector('#form');
  is((await page.$$('#form .askrow[data-back]')).length, 4, 'all four can be put back');
  await page.click('#form .askrow[data-back="p1"]');
  await page.waitForTimeout(300);
  is(await page.evaluate(() => people().length), 1, 'and putting one back works');

  section('an emptied tree is not shown as a fresh one');
  // The welcome screen sits above everything. Shown here it would cover the
  // only panel that can bring these records back.
  await page.evaluate(() => {
    for (const p of people()) p.aside = { by:'x', at:new Date().toISOString(), why:'test' };
    render();
  });
  await page.waitForTimeout(200);
  is(await page.evaluate(() => people().length), 0, 'nobody is in the tree');
  is(await page.isVisible('#seed'), false, 'the plant-your-first-person screen stays away');
  is(await page.isVisible('#aside'), true, 'the way back is on screen');
  is(/set aside/i.test(await page.textContent('#hint')), true, 'and the hint points at it');

  console.log(`\n  ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
