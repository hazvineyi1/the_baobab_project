// Shared bits for the browser suites that drive a real server.
//
// Since the passphrase gate went in, every one of them has to get through it
// first. Doing that by filling in the real form rather than by forging a
// cookie means the suites also keep the gate honest: if it stops accepting a
// correct passphrase, every one of them fails rather than quietly bypassing it.

const BASE = process.env.MW_BASE_URL || 'http://127.0.0.1:3940/';
const EXE  = process.env.MW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PASSPHRASE = process.env.APP_PASSPHRASE || '';

// Only this origin. The sandbox cannot reach fonts.googleapis.com and waiting
// for it to time out on every navigation costs more than the whole suite.
async function onlyThisOrigin(ctx){
  await ctx.route('**', r =>
    r.request().url().startsWith(BASE) ? r.continue() : r.abort());
}

/* Open the app in a fresh context, going through the gate if there is one. */
async function openApp(browser, { url = BASE, viewport = { width:1280, height:940 } } = {}){
  const ctx = await browser.newContext({ viewport });
  await onlyThisOrigin(ctx);
  const page = await ctx.newPage();
  await enter(page, url);
  return { ctx, page };
}

/* Go to a url, passing the gate on the way if it asks. */
async function enter(page, url){
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (await page.$('input[name="passphrase"]')){
    if (!PASSPHRASE){
      throw new Error('the server has a passphrase gate but APP_PASSPHRASE is not set ' +
                      'for the test run');
    }
    await page.fill('input[name="passphrase"]', PASSPHRASE);
    await Promise.all([
      page.waitForNavigation({ waitUntil:'domcontentloaded' }).catch(() => {}),
      page.click('button[type="submit"]')
    ]);
    // The gate redirects to '/', so come back to where we were actually
    // going. Moving from '/' to '/#/f/key' is a hash-only change, which the
    // browser does not reload for — the page notices and reloads itself, so
    // this waits for that rather than racing it with a reload of its own.
    if (url !== BASE){
      await page.goto(url, { waitUntil:'domcontentloaded' });
      await page.waitForFunction(
        () => { try { return typeof store === 'string' &&
                             (!familyKeyFromUrl() || familyKeyFromUrl() === familyKey ||
                              store === 'stalled'); }
                catch (e) { return false; } }, null, { timeout: 20000 });
    }
  }
  return page;
}

const ready = page => page.waitForFunction(
  () => { try { return store === 'shared' && !!treeId; } catch (e) { return false; } },
  null, { timeout: 20000 });

const settled = page => page.waitForFunction(
  () => { try { return typeof store === 'string'; } catch (e) { return false; } },
  null, { timeout: 20000 });

module.exports = { BASE, EXE, PASSPHRASE, openApp, enter, onlyThisOrigin, ready, settled };
