#!/usr/bin/env node
// Runs the test harnesses that live OUTSIDE this repository.
//
// Five of the suites the project depends on were written against the baobab
// frontend and the passphrase gate, neither of which is committed here:
//
//   kin.js      25 kinship-term checks against a hand-built family
//   dupes.js    25 duplicate-detection checks
//   buds.js     every bud present, on screen and clickable, desktop and phone
//   drive2.js   birth order and multiple partners
//   test_gate.sh  21 curl checks against the passphrase gate
//
// This finds them, runs them if they are present, and — crucially — reports
// SKIPPED rather than passed when they are not. A suite that silently reports
// nothing when its file is missing is worse than no suite at all: it turns an
// untested build into a green one.
//
// Where it looks, in order:
//   $MW_HARNESS_DIR      if set
//   ./harness/           committed alongside the repo
//   /tmp/                where they currently live on the author's machine
//
// Usage:
//   node test/external.js                 # against a server this starts
//   MW_BASE_URL=https://... node test/external.js   # against a running one

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const HARNESSES = [
  { file: 'kin.js',       kind: 'node',  what: '25 kinship-term checks' },
  { file: 'dupes.js',     kind: 'node',  what: '25 duplicate-detection checks' },
  { file: 'buds.js',      kind: 'node',  what: 'bud presence and clickability, desktop and phone' },
  { file: 'drive2.js',    kind: 'node',  what: 'birth order and multiple partners' },
  { file: 'test_gate.sh', kind: 'shell', what: '21 passphrase-gate checks' }
];

const SEARCH_DIRS = [
  process.env.MW_HARNESS_DIR,
  path.join(__dirname, '..', 'harness'),
  '/tmp'
].filter(Boolean);

// Playwright needs to be told which browser to use in this environment; the
// harnesses take an executablePath, and this is the one that exists here.
function chromiumPath() {
  if (process.env.MW_CHROMIUM) return process.env.MW_CHROMIUM;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter(Boolean);
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root); } catch { continue; }
    for (const e of entries.filter(x => x.startsWith('chromium-')).sort().reverse()) {
      for (const rel of ['chrome-linux/chrome', 'chrome-linux/headless_shell']) {
        const p = path.join(root, e, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const find = file => {
  for (const dir of SEARCH_DIRS) {
    const p = path.join(dir, file);
    if (fs.existsSync(p)) return p;
  }
  return null;
};

// ---------------------------------------------------------------------------

async function startServer() {
  const url = process.env.MW_BASE_URL;
  if (url) return { url, stop: () => {} };

  if (!process.env.DATABASE_URL && !process.env.TEST_DATABASE_URL) {
    throw new Error(
      'Set MW_BASE_URL to point at a running server, or DATABASE_URL so one can be started.');
  }
  const port = Number(process.env.MW_PORT || 3910);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port),
           DATABASE_URL: process.env.DATABASE_URL || process.env.TEST_DATABASE_URL },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(base + '/health');
      if (r.ok) return { url: base, stop: () => child.kill() };
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  child.kill();
  throw new Error(`server did not start within 15s:\n${log}`);
}

function runHarness(h, file, baseUrl, chromium) {
  const env = {
    ...process.env,
    // The harnesses were written before this wiring existed, so pass the base
    // URL under every name one of them might reasonably read.
    BASE_URL: baseUrl, MW_BASE_URL: baseUrl, URL: baseUrl, APP_URL: baseUrl,
    ...(chromium ? { CHROMIUM_PATH: chromium, PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: chromium } : {})
  };
  const cmd = h.kind === 'shell' ? 'bash' : process.execPath;
  const res = spawnSync(cmd, [file], { env, stdio: 'inherit', timeout: 300_000 });
  if (res.error) return { status: 'error', detail: res.error.message };
  return res.status === 0 ? { status: 'passed' } : { status: 'failed', detail: `exit ${res.status}` };
}

(async () => {
  const chromium = chromiumPath();
  const found = HARNESSES.map(h => ({ ...h, path: find(h.file) }));
  const present = found.filter(h => h.path);

  console.log('External harnesses');
  console.log(`  searched: ${SEARCH_DIRS.join(', ')}`);
  console.log(`  chromium: ${chromium || 'NOT FOUND — Playwright suites cannot run'}`);
  console.log('');

  if (!present.length) {
    for (const h of found) console.log(`  SKIPPED  ${h.file.padEnd(14)} not found — ${h.what}`);
    console.log(`\n0 run, ${found.length} skipped.`);
    console.log(
      '\nThese suites are not in this repository. They test the baobab frontend and\n' +
      'the passphrase gate, neither of which is committed. Drop them into ./harness/\n' +
      '(or set MW_HARNESS_DIR) and this will run them.\n' +
      '\nNothing here has been verified against them. Do not read this as a pass.');
    process.exit(0);   // not a failure: nothing was claimed
  }

  const server = await startServer();
  console.log(`  server:   ${server.url}\n`);

  const results = [];
  try {
    for (const h of found) {
      if (!h.path) { results.push({ ...h, status: 'skipped' }); continue; }
      console.log(`\n--- ${h.file} — ${h.what} ---`);
      results.push({ ...h, ...runHarness(h, h.path, server.url, chromium) });
    }
  } finally { server.stop(); }

  console.log('\n' + '='.repeat(60));
  for (const r of results) {
    const tag = { passed: 'ok     ', failed: 'FAIL   ', error: 'ERROR  ', skipped: 'SKIPPED' }[r.status];
    console.log(`  ${tag}  ${r.file.padEnd(14)} ${r.detail || r.what}`);
  }
  const failed = results.filter(r => r.status === 'failed' || r.status === 'error').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  const passed = results.filter(r => r.status === 'passed').length;
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (skipped) console.log('Skipped suites were NOT verified. They are not a pass.');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('\nHARNESS RUNNER ERROR: ' + e.message); process.exit(2); });
