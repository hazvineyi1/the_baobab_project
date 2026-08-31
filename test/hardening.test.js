// Response headers, rate limits, and the partitions staying ahead.
//
// Three small things that share a property: each of them fails SILENTLY. A
// missing header is a page that still works; a missing rate limit is an
// endpoint that still answers; a missing partition is a write that still
// lands. Nothing goes red, nobody notices, and the defence is simply absent —
// which is exactly why they need a test rather than a look.
//
// The CSP is checked against what the real pages actually contain, not against
// a string: a policy that forbids what the page needs is worse than none,
// because it breaks the page instead of an attacker.

const http = require('http');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { check, eq, section, report, freshPool, newTree } = require('./helpers');
const { securityHeaders, withNonce, policy } = require('../security');
const { limiter, limitKeyOf, addressOf } = require('../auth');
const audit = require('../db/audit');

function listen(app) {
  return new Promise(r => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => r(s));
  });
}

function get(server, p = '/', headers = {}) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    http.get({ host:'127.0.0.1', port, path:p, headers }, res => {
      let text = '';
      res.on('data', c => text += c);
      res.on('end', () => resolve({ status:res.statusCode, headers:res.headers, text }));
    }).on('error', reject);
  });
}

// Pull one directive out of a policy string.
const directive = (csp, name) => {
  const found = csp.split(';').map(s => s.trim())
    .find(s => s === name || s.startsWith(name + ' '));
  return found === undefined ? null : found.slice(name.length).trim();
};

(async () => {
  const app = express();
  app.use(securityHeaders());
  app.get('/', (req, res) => res.type('html').send('<h1>hi</h1>'));
  app.get('/preview.jpg', (req, res) => res.type('jpeg').send(Buffer.from([0xff, 0xd8])));
  app.get('/nonce', (req, res) => res.type('html').send(
    withNonce('<script>console.log(1)</script>', req.cspNonce)));
  const server = await listen(app);

  // ── the headers ──────────────────────────────────────────────────────────
  section('every response carries the headers, not just the pages somebody remembered');
  for (const p of ['/', '/preview.jpg', '/nonce']) {
    const r = await get(server, p);
    check(`${p}: a policy`, !!r.headers['content-security-policy']);
    eq(`${p}: nosniff`, r.headers['x-content-type-options'], 'nosniff');
    eq(`${p}: not framed`, r.headers['x-frame-options'], 'DENY');
    eq(`${p}: no referrer`, r.headers['referrer-policy'], 'no-referrer');
  }

  section('the referrer header is off, which is what protects an invitation');
  // /join/<token> puts the token in the PATH, because the server has to see
  // it. Without this, following any outbound link from that page would hand
  // the invitation to wherever it went.
  const j = await get(server, '/');
  eq('no-referrer', j.headers['referrer-policy'], 'no-referrer');

  section('the preview card is the one thing meant to be fetched from elsewhere');
  eq('and says so',
     (await get(server, '/preview.jpg')).headers['cross-origin-resource-policy'],
     'cross-origin');
  eq('while everything else does not',
     (await get(server, '/')).headers['cross-origin-resource-policy'],
     'same-origin');

  section('HSTS is promised only when the request actually arrived over TLS');
  eq('not over plain http', (await get(server, '/')).headers['strict-transport-security'],
     undefined);
  const tls = await get(server, '/', { 'x-forwarded-proto': 'https' });
  check('but yes behind a proxy that terminated it',
        /max-age=\d+/.test(tls.headers['strict-transport-security'] || ''));

  // ── the nonce ────────────────────────────────────────────────────────────
  section('the nonce is per response, not per boot');
  const a = await get(server, '/nonce');
  const b = await get(server, '/nonce');
  const nonceOf = r => (r.text.match(/nonce="([^"]+)"/) || [])[1];
  check('the script carries one', !!nonceOf(a));
  check('and the next response carries a different one', nonceOf(a) !== nonceOf(b),
        'a reused nonce is one an attacker reads off a page and puts in the next');
  check('the one in the page is the one in the policy',
        a.headers['content-security-policy'].includes(`'nonce-${nonceOf(a)}'`));

  section('an injected script has no nonce, which is the whole point');
  const csp = a.headers['content-security-policy'];
  const script = directive(csp, 'script-src');
  check('scripts are not simply allowed inline', !script.includes("'unsafe-inline'"), script);
  check('and nothing may be evaluated from a string', !script.includes("'unsafe-eval'"));
  eq('objects are refused outright', directive(csp, 'object-src'), "'none'");
  eq('and nothing may reset the base url', directive(csp, 'base-uri'), "'none'");
  eq('nobody frames this', directive(csp, 'frame-ancestors'), "'none'");
  eq('a form on this page can only post back to it', directive(csp, 'form-action'), "'self'");
  eq('and the page only ever talks to its own origin', directive(csp, 'connect-src'), "'self'");

  // ── the policy against the REAL pages ────────────────────────────────────
  //
  // A policy that forbids what the page needs breaks the page rather than an
  // attacker, so this checks it against what the shipped files contain.
  section('the policy allows what the shipped pages actually need');
  const pages = {
    'public/index.html': fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8'),
    'admin/dashboard.html': fs.readFileSync(path.join(__dirname, '..', 'admin', 'dashboard.html'), 'utf8')
  };
  for (const [name, html] of Object.entries(pages)) {
    // A nonce covers <script> blocks. It does NOT cover onclick="..." — so if
    // one is ever added, the policy silently stops it working. Better to fail
    // here, loudly, than there.
    const handlers = html.match(/\son(click|change|input|keydown|submit|load|error)="/g) || [];
    eq(`${name}: no inline event handlers for the nonce to miss`, handlers, []);
    eq(`${name}: nothing is evaluated from a string`,
       (html.match(/\beval\(|new Function\s*\(/g) || []), []);
    // Exactly one script, and withNonce finds it.
    const tags = (html.match(/<script(\s|>)/g) || []).length;
    check(`${name}: has ${tags} script tag(s), all reachable by the nonce`,
          tags === (withNonce(html, 'X').match(/<script nonce="X">/g) || []).length);
  }

  section('the external resources the page really loads are the ones allowed');
  const externals = [...new Set(
    (pages['public/index.html'].match(/https:\/\/[a-z0-9.-]+/g) || [])
  )].filter(u => !u.includes('%ORIGIN%'));
  const allowed = policy('x');
  for (const u of externals) {
    check(`${u} is allowed somewhere in the policy`, allowed.includes(u), allowed);
  }

  server.close();

  // ── rate limits ──────────────────────────────────────────────────────────
  section('the limiter counts per address and forgets after the window');
  const lim = limiter(3, 50);
  check('under the limit', !lim.tooMany('a'));
  lim.note('a'); lim.note('a'); lim.note('a');
  check('over it', lim.tooMany('a'));
  check('and another address is unaffected', !lim.tooMany('b'));
  await new Promise(r => setTimeout(r, 70));
  check('and it forgets', !lim.tooMany('a'));

  section('a limit on a route behind the gate counts the session, not the wifi');
  // Forty relatives at a gathering share one address. Counting them together
  // would refuse most of them at the moment this project is meant to be
  // working, so the session is the unit and the address is only the backstop.
  const atTheHall = { headers:{ 'x-forwarded-for':'41.0.0.9' }, socket:{} };
  const one = { ...atTheHall, muti:{ session:{ id:'session-one' } } };
  const two = { ...atTheHall, muti:{ session:{ id:'session-two' } } };
  check('two relatives on one wifi are counted apart',
        limitKeyOf(one) !== limitKeyOf(two));
  eq('and their address is still the same one', addressOf(one), addressOf(two));
  eq('with no session at all it falls back to the address',
     limitKeyOf(atTheHall), '41.0.0.9');

  // ── partitions ───────────────────────────────────────────────────────────
  const pool = await freshPool();
  const treeId = await newTree(pool, 'partitions');

  section('the record is partitioned by month');
  const parts = async () => (await pool.query(
    `SELECT c.relname FROM pg_class c
       JOIN pg_inherits i ON i.inhrelid = c.oid
       JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = 'audit_events' ORDER BY 1`)).rows.map(r => r.relname);

  await audit.ensurePartitions(pool, () => {});
  const have = await parts();
  check('there is a default, so a write can never fail for want of one',
        have.includes('audit_events_default'));
  const months = have.filter(n => /^audit_events_\d{6}$/.test(n));
  check(`and months ahead of today (${months.length})`, months.length >= 3, months.join(' '));

  section('a month that has one is used instead of the default');
  await audit.record(pool, { kind:'gate.ok', ok:true, treeId, ip:'41.0.0.1' });
  const thisMonth = 'audit_events_' +
    new Date().toISOString().slice(0, 7).replace('-', '');
  const landed = await pool.query(
    `SELECT count(*)::int n FROM ${thisMonth}`);
  check(`the row is in ${thisMonth}`, landed.rows[0].n >= 1);
  const inDefault = await pool.query(
    `SELECT count(*)::int n FROM audit_events_default`);
  eq('and not in the default', inDefault.rows[0].n, 0);

  /* THE SLOW BUG. Partitions used to be made at boot and never again, so a
     process running past the last one prepared started writing everything
     into the default — silently, since nothing fails. This drops the months
     ahead to reproduce that state, then asserts the daily check puts them
     back. */
  section('a long-running process keeps them ahead of the calendar');
  for (const m of months.slice(1)) await pool.query(`DROP TABLE ${m}`);
  const thin = (await parts()).filter(n => /^audit_events_\d{6}$/.test(n));
  eq('starting from only this month', thin.length, 1);
  await audit.ensurePartitions(pool, () => {});
  const back = (await parts()).filter(n => /^audit_events_\d{6}$/.test(n));
  check(`the check puts them back (${back.length})`, back.length >= 3, back.join(' '));

  section('and the timer that runs it never holds the process open');
  const timer = audit.keepPartitionsAhead(pool, () => {});
  check('a timer was started', !!timer);
  // If this did not unref, this test file would sit here for a day.
  check('and it is unref\'d — this suite exits rather than waiting a day',
        timer.hasRef ? timer.hasRef() === false : true);
  clearInterval(timer);
  eq('it checks daily', audit.PARTITION_CHECK_MS, 24 * 60 * 60 * 1000);

  section('retention drops whole months, and never the default');
  await pool.query(`SELECT mw_ensure_audit_partition(clock_timestamp() - INTERVAL '3 months')`);
  const before = await parts();
  check('an old month exists to drop', before.length > back.length + 1);
  await pool.query(`SELECT mw_drop_audit_before(clock_timestamp() - INTERVAL '1 month')`);
  const after = await parts();
  check('it is gone', after.length < before.length);
  check('the default is untouched — it may hold rows from any month at all',
        after.includes('audit_events_default'));
  check('and this month is untouched', after.includes(thisMonth));

  await pool.end();
  report();
})();
