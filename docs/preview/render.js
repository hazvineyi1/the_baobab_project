// Renders public/preview.jpg — the card that appears when somebody shares a
// link to this project in WhatsApp, Facebook, Slack or iMessage.
//
// Kept so the image can be remade rather than only replaced. It needs the
// baobab mask beside it:
//
//   cp public/baobab.webp docs/preview/
//   NODE_PATH=$(npm root -g) node docs/preview/render.js
//   mv docs/preview/preview.jpg public/
//
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage({ viewport:{ width:1200, height:630 }, deviceScaleFactor:1 });
  await p.goto('file://' + __dirname + '/card.html', { waitUntil:'load' });
  await p.waitForTimeout(400);
  await p.screenshot({ path: __dirname + '/preview.jpg', type:'jpeg', quality:88 });
  await b.close();
})();
