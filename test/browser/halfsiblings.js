// Half siblings, through the real server.
//
// test/halfsiblings.test.js proves the logic in a stubbed DOM. This proves the
// part that only a real database can: that a correction actually SAVES.
//
// union_children.person_id is the primary key — that is how the
// one-set-of-parents rule is made unbreakable rather than merely checked — so
// addChild refuses anybody who already has parents recorded. Moving a child
// therefore only works if the removal reaches the server before the addition,
// and the ordering that guarantees it lives in diffOps. Nothing but a round
// trip against the real constraint can show that it holds.
//
// Not part of `npm test` — needs Chromium and a live server. Run:
//
//   DATABASE_URL=... PORT=3940 node server.js &
//   MW_BASE_URL=http://127.0.0.1:3940/ APP_PASSPHRASE=... \
//     NODE_PATH=$(npm root -g) node test/browser/halfsiblings.js

const { chromium } = require('playwright');
const { BASE, EXE, openApp, ready, settled, saved } = require('./lib');

let pass = 0, fail = 0;
const ok  = m => { pass++; console.log('  ok   ' + m); };
const bad = (m, d) => { fail++; console.log('  FAIL ' + m + (d ? '  — ' + d : '')); };
const is  = (a, b, m) => a === b ? ok(m) : bad(m, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const section = t => console.log('\n' + t);

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const { ctx, page } = await openApp(browser, { viewport:{ width:1280, height:960 } });
  page.on('pageerror', e => bad('page error', e.message));
  await ready(page);

  const TAG = 'Two' + Date.now().toString(36).slice(-5);

  section('a man with two wives, and a child by each');
  await page.evaluate(t => {
    const father = addPerson('Sydney ' + t, 'm', 'Mwendamberi', '1940', '2013');
    state.rootId = father;
    grow('partner', father, 'Evelyn ' + t, 'f', 'Moyondizvo', { born:'1954' });
    grow('child',   father, 'Bertha ' + t, 'f', 'Mwendamberi', { born:'1975' });
    // A second marriage, and a child in it.
    const second = grow('partner', father, 'Rudo ' + t, 'f', 'Shava', { born:'1961' });
    const u2 = unionsOf(father).find(u => u.partners.includes(second));
    grow('child', father, 'Terence ' + t, 'm', 'Mwendamberi',
         { born:'1981', unionId: u2.id });
    save();
  }, TAG);
  await saved(page);

  const idOf = who => page.evaluate(([w, t]) =>
    (people().find(p => p.name.startsWith(w + ' ' + t)) || {}).id, [who, TAG]);
  const bertha = await idOf('Bertha');
  const terence = await idOf('Terence');
  const father = await idOf('Sydney');
  const evelyn = await idOf('Evelyn');
  is(!!bertha && !!terence, true, 'the two children are recorded');

  section('the tree names them brother and sister across the two marriages');
  const named = await page.evaluate(([a, b]) => {
    const r = relationship(a, b);
    return r ? { term: r.term, why: r.why } : null;
  }, [bertha, terence]);
  is(named && named.term, 'Hanzvadzi', 'she has a word for him: ' + JSON.stringify(named));
  is(/child by another marriage/.test(named.why), true, 'and it says why');

  section('ADDING A SIBLING ASKS WHOSE CHILD, INSTEAD OF ASSUMING');
  await page.evaluate(id => { sel = id; render(); openForm('sibling', id); }, bertha);
  await page.waitForSelector('#fWhose', { timeout: 10000 });
  const offered = await page.$$eval('#fWhose button', bs => bs.map(b => b.textContent.trim()));
  is(offered[0], 'Same mother and father', 'the first answer is the one it used to assume');
  is(offered.some(o => /by another mother/.test(o)), true,
     'and a different mother is offerable: ' + offered.join(' | '));

  section('choosing it records a different mother — not the one nobody named');
  await page.fill('#fName', 'Munyaradzi ' + TAG);
  await page.click('#fSex button[data-sex="m"]');   // no sex, no sibling word
  await page.click(`#fWhose button:has-text("by another mother")`);
  await page.fill('#fBorn', '1990');
  await page.click('#fGo');
  await saved(page);

  const munya = await idOf('Munyaradzi');
  const parentsOfMunya = await page.evaluate(id => {
    const u = parentUnionOf(id);
    return u ? u.partners.slice() : null;
  }, munya);
  is(parentsOfMunya.includes(father), true, 'their father is the same man');
  is(parentsOfMunya.includes(evelyn), false,
     'and Bertha\'s mother is NOT recorded as theirs');
  is(await page.evaluate(([a, b]) => (relationship(a, b) || {}).term, [bertha, munya]),
     'Hanzvadzi', 'and they are still brother and sister');

  section('it survives a reload — the server took it, not just the page');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await ready(page);
  await saved(page);
  const munya2 = await idOf('Munyaradzi');
  const after = await page.evaluate(id => {
    const u = parentUnionOf(id);
    return u ? u.partners.length : -1;
  }, munya2);
  is(after, 1, 'one parent recorded, the other left unnamed because it is unknown');

  // ── the correction ───────────────────────────────────────────────────────
  section('a sibling recorded the OLD way can be put right');
  // Recorded as a full sibling of Bertha, which is what the app used to do to
  // every one of them.
  await page.evaluate(([id, t]) => {
    grow('sibling', id, 'Ida ' + t, 'f', 'Mwendamberi', { born:'1972' });
    save();
  }, [bertha, TAG]);
  await saved(page);
  const ida = await idOf('Ida');
  is(await page.evaluate(([a, b]) => parentUnionOf(a).id === parentUnionOf(b).id,
                         [ida, bertha]), true,
     'recorded in Bertha\'s marriage, as before');

  section('the card offers the correction');
  await page.evaluate(id => { sel = id; render(); openCard(id); }, ida);
  await page.waitForSelector('#cParents', { timeout: 10000 });
  is(await page.$eval('#cParents button[aria-pressed="true"]', b => b.textContent.trim()),
     'Same mother and father', 'and shows what the tree says now');

  section('MAKING IT — and the move surviving the one-set-of-parents rule');
  await page.click(`#cParents button:has-text("by another mother")`);
  await saved(page);
  is(await page.evaluate(([a, b]) => parentUnionOf(a).id !== parentUnionOf(b).id,
                         [ida, bertha]), true,
     'no longer in Bertha\'s marriage');
  is(await page.evaluate(([id, m]) => !parentUnionOf(id).partners.includes(m),
                         [ida, evelyn]), true,
     'and Evelyn is no longer recorded as her mother');

  section('and THAT survives a reload, which is the whole point');
  // If diffOps had sent addChild before removeChild, the server would have
  // refused the batch and the page would be holding a change the database
  // never took.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await ready(page);
  await saved(page);
  const ida2 = await idOf('Ida');
  const bertha2 = await idOf('Bertha');
  is(await page.evaluate(([a, b]) => parentUnionOf(a).id !== parentUnionOf(b).id,
                         [ida2, bertha2]), true,
     'the server kept the move');
  is(await page.evaluate(([id, f]) => parentUnionOf(id).partners.includes(f),
                         [ida2, father]), true,
     'with her father still recorded');
  is(await page.evaluate(id => !!people().find(p => p.id === id), ida2), true,
     'and nobody was deleted to do it');

  section('EVEN a family with one marriage is asked');
  /* This was written the other way round first — on the reasoning that one
     marriage means nothing to choose between, so nothing to ask. It is wrong,
     and it is wrong in exactly the case that started all this: a family with
     one marriage recorded is not a family with one marriage, it is a family
     that has recorded one. The second wife is the person who has not been
     entered yet, and the sibling being added may well be hers.

     So the question is asked wherever parents are recorded at all. It costs
     nothing when the answer is the obvious one — that answer is already
     selected — and it is the only way the tree stops asserting a mother
     nobody named. */
  const simple = await openApp(browser, { viewport:{ width:1280, height:900 } });
  await ready(simple.page);
  const TAG2 = 'One' + Date.now().toString(36).slice(-4);
  await simple.page.evaluate(t => {
    const f = addPerson('Farai ' + t, 'm', 'Nzou', '1930', '');
    state.rootId = f;
    grow('partner', f, 'Chipo ' + t, 'f', 'Shava', { born:'1935' });
    grow('child', f, 'Tendai ' + t, 'm', 'Nzou', { born:'1960' });
    save();
  }, TAG2);
  await saved(simple.page);
  const tendai = await simple.page.evaluate(t =>
    (people().find(p => p.name.startsWith('Tendai ' + t)) || {}).id, TAG2);
  await simple.page.evaluate(id => { sel = id; render(); openForm('sibling', id); }, tendai);
  await simple.page.waitForTimeout(400);
  const asked = await simple.page.$('#fWhose');
  is(!!asked, true, 'the question is there');
  const simpleOffered = await simple.page.$$eval('#fWhose button',
    bs => bs.map(b => b.textContent.trim()));
  is(simpleOffered[0], 'Same mother and father',
     'with the obvious answer already chosen, so it costs nothing: ' +
     simpleOffered.join(' | '));
  is(simpleOffered.some(o => /by another mother/.test(o)), true,
     'and the wife nobody has entered yet is still offerable');
  await simple.ctx.close();

  await ctx.close();
  console.log(`\n  ${pass} passed, ${fail} failed`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
