// Tapping a line, in a real browser.
//
// THE THING THIS EXISTS FOR. The canvas could only ever answer one question —
// what is this person to ME — so a line between two OTHER people, a mother and
// her son standing right there joined by it, had no way of being asked about.
// Reported as "the relationships are not reading properly": they were reading
// perfectly, and there was nowhere to read them.
//
// It has to be a browser test. Everything hard about this is hit-testing and
// pointer sequencing: a press on a line and the release after it land on
// different elements, so no click is ever raised, and the tap has to be
// tracked from down to up. Nothing headless would see any of that.
//
//   npx http-server public -p 3930 -s &
//   NODE_PATH=$(npm root -g) node test/browser/lines.js

const { chromium } = require('playwright');

const BASE = process.env.MW_BASE_URL || 'http://127.0.0.1:3930/';
const EXE  = process.env.MW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

let pass = 0, fail = 0;
const ok  = m => { pass++; console.log('  ok   ' + m); };
const bad = (m, d) => { fail++; console.log('  FAIL ' + m + (d ? '  — ' + d : '')); };
const is  = (a, b, m) => a === b ? ok(m) : bad(m, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const section = t => console.log('\n' + t);

/* Bertha and her son, with no husband recorded for her — the shape that was
   reported, and the one where the parent link hangs off a marriage with a
   single person in it. */
const FAMILY = JSON.stringify({
  people:{
    p1:{id:'p1',name:'Sydney Kanzara Musoni',sex:'m',totem:'Mwendamberi',born:'1940',died:'2013',root:true},
    p2:{id:'p2',name:'Evelyn Mandaba',sex:'f',totem:'Moyondizvo',born:'1954'},
    p3:{id:'p3',name:'Bertha Dadirai Musoni',sex:'f',totem:'Mwendamberi',born:'1975'},
    p4:{id:'p4',name:'Hazvineyi Belinda Musoni',sex:'f',totem:'Mwendamberi',born:'1979'},
    p6:{id:'p6',name:'Sydney Kurauwone Musoni',sex:'m',totem:'Shava',born:'1997'}
  },
  unions:{ u1:{id:'u1',partners:['p1','p2'],children:['p3','p4']},
           u2:{id:'u2',partners:['p3'],children:['p6']} },
  rootId:'p1', seq:9, notDuplicates:[], lexicon:{}
});

// The point halfway along a line, in screen coordinates — a curve's bounding
// box centre can be well off the curve itself.
const midpointOf = (page, selector) => page.evaluate(sel => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const m = el.getPointAtLength(el.getTotalLength() / 2);
  const t = el.getScreenCTM();
  return { x: m.x * t.a + m.y * t.c + t.e, y: m.x * t.b + m.y * t.d + t.f };
}, selector);

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const ctx = await browser.newContext({ viewport:{ width:1000, height:820 } });
  await ctx.route('**', r => r.request().url().startsWith(BASE) ? r.continue() : r.abort());
  const page = await ctx.newPage();
  page.on('pageerror', e => bad('page error', e.message));

  await page.goto(BASE, { waitUntil:'domcontentloaded' });
  await page.evaluate(f => { localStorage.setItem('muti-baobab-v1', f);
                             localStorage.setItem('muti-baobab-me', 'p4'); }, FAMILY);
  await page.goto(BASE, { waitUntil:'domcontentloaded' });
  await page.waitForFunction(() => { try { return people().length === 5; } catch (e) { return false; } });
  await page.waitForTimeout(700);

  section('every line carries the people it joins');
  const pairs = await page.$$eval('#canvas .hit',
    ns => ns.map(n => n.dataset.from + '<-' + n.dataset.to));
  is(pairs.includes('p6<-p3'), true,
     'the mother and her son are one of them: ' + pairs.join(' '));
  is(pairs.includes('p1<-p2'), true, 'and so are two partners');
  is(pairs.includes('p3<-p1,p2'), true,
     'a child of a marriage carries BOTH parents, since the line joins them all');

  section('TAPPING THE LINE SAYS WHAT THEY ARE TO EACH OTHER');
  const pt = await midpointOf(page, '#canvas .hit[data-from="p6"]');
  is(!!pt, true, 'the line is on screen');
  await page.mouse.click(pt.x, pt.y);
  await page.waitForSelector('#form', { timeout: 5000 });
  const panel = await page.textContent('#form');
  is(/Mwanakomana/.test(panel), true, 'he is her son: ' + panel.slice(0, 90));
  is(/Amai/.test(panel), true, 'and she is his mother');
  is(/Sydney Kurauwone Musoni is Bertha Dadirai Musoni/.test(panel), true,
     'said with both names, in that order');

  section('and it is worded about them, not about the reader');
  // "your son" is right on the card, where the person asking IS the person
  // being reckoned from. On a line between two other people it is a lie.
  is(/\byour\b/.test(panel), false,
     'nothing is called "your" anything: ' + panel.slice(0, 160));
  // And the trace is dropped where it only restates the link: "Amai — his
  // mother or father" is a worse line than "Amai" by itself.
  is(/mother or father/.test(panel), false,
     'the vaguer wording the word came from is not repeated under it');

  section('and it answers about THOSE two, not about you');
  // The old ribbon could only ever say what somebody was to the person marked
  // as "You". Hazvineyi is marked here, and she is in neither answer.
  is(/Hazvineyi/.test(panel), false, 'nobody else is dragged into it');

  section('a partner line reads as a marriage');
  await page.click('#form .btn.ghost:has-text("Close")');
  const bond = await midpointOf(page, '#canvas .hit[data-from="p1"]');
  await page.mouse.click(bond.x, bond.y);
  await page.waitForSelector('#form', { timeout: 5000 });
  const married = await page.textContent('#form');
  is(/Mukadzi/.test(married), true, 'she is his wife: ' + married.slice(0, 80));
  is(/Murume/.test(married), true, 'and he is her husband');

  section('dragging along a line pans instead of opening anything');
  // A tap and a drag start identically. Only the release tells them apart, and
  // getting that wrong would make the tree impossible to move.
  await page.click('#form .btn.ghost:has-text("Close")');
  await page.waitForTimeout(200);
  const before = await page.evaluate(() => ({ x: pos.x, y: pos.y }));
  const drag = await midpointOf(page, '#canvas .hit[data-from="p6"]');
  await page.mouse.move(drag.x, drag.y);
  await page.mouse.down();
  await page.mouse.move(drag.x + 120, drag.y + 60, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  is(await page.$('#form'), null, 'no panel opened');
  const after = await page.evaluate(() => ({ x: pos.x, y: pos.y }));
  is(after.x !== before.x || after.y !== before.y, true, 'and the tree moved');

  section('NOTHING says a relationship until it is asked for');
  // The ribbon used to appear beside whoever was selected, saying what they
  // are to you, whether or not anybody wanted to know. That was the crowding.
  await page.click('.pod[data-id="p3"]');
  await page.waitForTimeout(400);
  is(await page.$('#buds .term'), null, 'selecting a person says nothing on its own');
  is(await page.$('#form'), null, 'and opens no panel');
  is(await page.$eval('.pod[data-id="p3"]', el => el.classList.contains('sel')), true,
     'it selects them, and that is all');
  // But what the ribbon said is still reachable, one tap away.
  await page.click('.pod[data-id="p3"] .rm[data-card="p3"]');
  await page.waitForSelector('#form', { timeout: 5000 });
  is(/Bertha Dadirai Musoni/.test(await page.textContent('#form')), true,
     'the card behind the pod still says what she is to you');
  await page.click('#form .btn.ghost:has-text("Close")');
  await page.waitForTimeout(200);

  section('the person marked as You is ringed on the canvas');
  is(await page.$eval('.pod.you', el => el.dataset.id), 'p4', 'the ring is on them');
  is(await page.$eval('.pod.you .badge', el => el.textContent.trim()), 'You',
     'and it says so');

  await ctx.close();
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
