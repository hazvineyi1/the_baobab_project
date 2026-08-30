// The colour palettes.
//
// A palette is twenty CSS variables in two modes. The failure it invites is
// quiet rather than loud: a palette that forgets one variable does not break,
// it inherits that one colour from whatever was declared before it — so a
// green palette gets a brass accent, or a dark mode keeps one light value and
// a single word on the page becomes unreadable. Nothing throws, and it is
// easy to miss on the screen you happen to look at.
//
// So these read the CSS out of the shipped page and check what cannot be
// eyeballed: that every palette carries every token in both modes, that the
// two pairings the layout depends on stay legible, and that the swatches
// shown in the chooser are the colours somebody would actually get.

const fs = require('fs');
const path = require('path');
const { check, eq, section, report, loadFrontend } = require('./helpers');

const fe = loadFrontend();
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const css = html.split('</style>')[0];

const TOKENS = ['sky','sky-far','soil','soil-deep','horizon','bark','bark-lit',
  'bark-dark','bark-thin','root','pod','pod-edge','pod-hi','ink','muted',
  'gold','gold-soft','leaf','shadow','lift'];

/* Pull the declarations out of one selector's block. */
function blockFor(selector){
  const at = css.indexOf(selector + '{');
  if (at < 0) return null;
  const body = css.slice(at + selector.length + 1, css.indexOf('}', at));
  const out = {};
  for (const decl of body.split(';')){
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const k = decl.slice(0, i).trim();
    if (k.startsWith('--')) out[k.slice(2)] = decl.slice(i + 1).trim();
  }
  return out;
}

// ── contrast, the way the accessibility guidelines define it ──────────────
const hex = c => {
  const m = /^#([0-9a-f]{6})$/i.exec(String(c).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const luminance = rgb => {
  const [r, g, b] = rgb.map(v => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const x = hex(a), y = hex(b);
  if (!x || !y) return 0;
  const l1 = luminance(x), l2 = luminance(y);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
};

(async () => {
  const palettes = fe.PALETTES;

  section('the chooser offers what was asked for');
  check('at least four palettes to choose from', palettes.length >= 4,
        palettes.map(p => p.label).join(', '));
  check('including a black and grey one',
        palettes.some(p => /black.*grey/i.test(p.note)),
        palettes.map(p => p.note).join(' | '));
  eq('the default is the one the project was designed around',
     palettes[0].label, 'Baobab');
  eq('and it is the empty value, so no attribute is set for it',
     palettes[0].v, '');

  section('every palette defines every colour, in both light and dark');
  // The default palette lives in the bare :root rules; the rest in their own.
  const blocks = { Baobab: { light: blockFor(':root'), dark: blockFor(':root[data-theme="dark"]') } };
  for (const p of palettes.slice(1)){
    blocks[p.label] = {
      light: blockFor(`:root[data-palette="${p.v}"]`),
      dark:  blockFor(`:root[data-palette="${p.v}"][data-theme="dark"]`)
    };
  }
  for (const [name, modes] of Object.entries(blocks)){
    for (const mode of ['light', 'dark']){
      const b = modes[mode];
      if (!b){ check(`${name} (${mode}) has a block`, false); continue; }
      const missing = TOKENS.filter(t => !b[t]);
      eq(`${name} (${mode}) carries all ${TOKENS.length}`, missing, []);
    }
  }

  section('a palette in dark mode outranks every light rule');
  // Specificity, not source order, is what keeps a palette's light values from
  // leaking into dark mode. Asserted as the shape of the selectors, since that
  // is what produces it.
  for (const p of palettes.slice(1)){
    check(`${p.label} has a dark rule for the device setting`,
          css.includes(`:root[data-palette="${p.v}"]:not([data-theme="light"])`));
    check(`${p.label} has a dark rule for the forced setting`,
          css.includes(`:root[data-palette="${p.v}"][data-theme="dark"]`));
  }

  section('names stay readable on their cards');
  // The pairings the layout actually depends on. A palette that fails one of
  // these is not a matter of taste — a word on the page cannot be read.
  for (const [name, modes] of Object.entries(blocks)){
    for (const mode of ['light', 'dark']){
      const b = modes[mode];
      if (!b) continue;
      const inkOnPod = contrast(b.ink, b.pod);
      check(`${name} (${mode}): a name against its card — ${inkOnPod.toFixed(1)}:1`,
            inkOnPod >= 7, 'wanted 7:1 or better');
      const mutedOnPod = contrast(b.muted, b.pod);
      check(`${name} (${mode}): dates and totems — ${mutedOnPod.toFixed(1)}:1`,
            mutedOnPod >= 4.5, 'wanted 4.5:1 or better');
    }
  }

  section('and the two inverted pairings hold too');
  for (const [name, modes] of Object.entries(blocks)){
    for (const mode of ['light', 'dark']){
      const b = modes[mode];
      if (!b) continue;
      // --leaf is a background carrying --sky as its text (the relationship
      // ribbon), and --gold carries --pod (a term the family taught).
      const skyOnLeaf = contrast(b.sky, b.leaf);
      check(`${name} (${mode}): the relationship ribbon — ${skyOnLeaf.toFixed(1)}:1`,
            skyOnLeaf >= 4.5, 'wanted 4.5:1 or better');
      const podOnGold = contrast(b.pod, b.gold);
      check(`${name} (${mode}): a taught term — ${podOnGold.toFixed(1)}:1`,
            podOnGold >= 4.5, 'wanted 4.5:1 or better');
    }
  }

  section('the swatches show the colours you would actually get');
  // They are quoted in the script rather than read off the page, because a
  // swatch has to show a palette that is not currently applied. Quoted values
  // drift; this is what notices.
  for (const p of palettes){
    const b = blocks[p.label];
    if (!b || !b.light || !b.dark) continue;
    eq(`${p.label}: the light swatch is [sky, bark, accent]`,
       p.swatch.map(c => c.toUpperCase()),
       [b.light.sky, b.light.bark, b.light.gold].map(c => c.toUpperCase()));
    eq(`${p.label}: and the dark swatch too`,
       p.dark.map(c => c.toUpperCase()),
       [b.dark.sky, b.dark.bark, b.dark.gold].map(c => c.toUpperCase()));
  }

  section('every palette is described, not just named');
  for (const p of palettes){
    check(`${p.label} says what it looks like`, !!(p.note && p.note.length > 5), p.note);
  }
  eq('and the light settings are still three',
     fe.THEMES.map(t => t.label), ['Auto', 'Day', 'Night']);

  report();
})();
