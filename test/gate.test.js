// The passphrase gate.
//
// A gate is the one piece of this project where a bug is not a wrong answer
// but an open door, so these test the failures rather than the happy path:
// what happens when it is not configured, when somebody guesses, when a
// session is forged, when the passphrase changes.
//
// Driven over real HTTP against a real Express app, because half of what is
// being asserted lives in middleware ordering and cookie flags rather than in
// any function.

const http = require('http');
const express = require('express');
const { check, eq, section, report } = require('./helpers');
const { gate, COOKIE, MAX_ATTEMPTS, _internals } = require('../auth');

const PASS = 'ambuya-nyarai-1908';

function appWith(opts) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(gate({ log: () => {}, ...opts }));
  app.get('/health', (req, res) => res.send('ok'));
  app.get('/api/tree/x/tree', (req, res) => res.json({ secret: 'the family' }));
  app.get('/', (req, res) => res.send('<h1>the tree</h1>'));
  return app;
}

function listen(app) {
  return new Promise(resolve => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
}

function req(server, { path = '/', method = 'GET', cookie, body } = {}) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const payload = body ? new URLSearchParams(body).toString() : null;
    const r = http.request({
      host: '127.0.0.1', port, path, method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(payload ? { 'Content-Type': 'application/x-www-form-urlencoded',
                        'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, res => {
      let text = '';
      res.on('data', c => text += c);
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, text,
        setCookie: (res.headers['set-cookie'] || []).join('; ')
      }));
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const cookieFrom = res => {
  const m = /muti_gate=([^;]+)/.exec(res.setCookie || '');
  return m ? `${COOKIE}=${m[1]}` : null;
};

(async () => {
  // ── configured, and doing its job ─────────────────────────────────────
  const guarded = await listen(appWith({ passphrase: PASS, hasDatabase: true }));

  section('nothing is reachable without the passphrase');
  let r = await req(guarded, { path: '/' });
  eq('the tree is not served', r.status, 401);
  check('a passphrase form is served instead', /Passphrase/.test(r.text));
  check('and the tree itself is not in it', !/the tree<\/h1>/.test(r.text));

  r = await req(guarded, { path: '/api/tree/x/tree' });
  eq('the API refuses too', r.status, 401);
  check('as JSON, so a page can act on it', /not_signed_in/.test(r.text));
  check('and gives nothing away', !/the family/.test(r.text));

  section('the health check stays outside, or the deploy looks dead');
  r = await req(guarded, { path: '/health' });
  eq('it answers', r.status, 200);

  section('the right passphrase opens it');
  r = await req(guarded, { method: 'POST', path: '/gate', body: { passphrase: PASS } });
  eq('and redirects into the app', r.status, 303);
  const good = cookieFrom(r);
  check('handing over a session cookie', !!good);
  check('that a script on the page cannot read', /HttpOnly/i.test(r.setCookie));
  check('and that is not sent to other sites', /SameSite=Lax/i.test(r.setCookie));
  check('the passphrase itself is never in the cookie', !r.setCookie.includes(PASS));

  r = await req(guarded, { path: '/', cookie: good });
  eq('with it, the tree is served', r.status, 200);
  check('really the tree', /the tree<\/h1>/.test(r.text));
  eq('and the API answers',
     (await req(guarded, { path: '/api/tree/x/tree', cookie: good })).status, 200);

  section('a wrong passphrase says only that it is wrong');
  r = await req(guarded, { method: 'POST', path: '/gate', body: { passphrase: 'wrong' } });
  eq('refused', r.status, 401);
  check('no cookie handed out', !cookieFrom(r));
  check('and the message does not say whether it was close',
        /not recognised/.test(r.text) && !/length|character|close/i.test(r.text));

  section('a session cannot be forged or stretched');
  const forged = `${COOKIE}=${Date.now() + 999999}.${'a'.repeat(64)}`;
  eq('a made-up signature is refused',
     (await req(guarded, { path: '/', cookie: forged })).status, 401);
  const expired = `${COOKIE}=${_internals.issue(PASS).replace(/^\d+/, String(Date.now() - 1000))}`;
  eq('an expired one is refused',
     (await req(guarded, { path: '/', cookie: expired })).status, 401);
  eq('so is a cookie holding the passphrase itself',
     (await req(guarded, { path: '/', cookie: `${COOKIE}=${PASS}` })).status, 401);
  eq('and one signed with a different passphrase',
     (await req(guarded, { path: '/', cookie: `${COOKIE}=${_internals.issue('something else')}` })).status,
     401);

  section('changing the passphrase ends every session');
  const rotated = await listen(appWith({ passphrase: 'a-new-passphrase', hasDatabase: true }));
  eq('the old cookie no longer opens it',
     (await req(rotated, { path: '/', cookie: good })).status, 401);
  rotated.close();

  section('guessing is rate-limited');
  const brute = await listen(appWith({ passphrase: PASS, hasDatabase: true }));
  let sawLimit = false;
  for (let i = 0; i < MAX_ATTEMPTS + 3; i++) {
    const g = await req(brute, { method:'POST', path:'/gate', body:{ passphrase:'guess' + i } });
    if (g.status === 429) { sawLimit = true; break; }
  }
  check(`stopped within ${MAX_ATTEMPTS + 3} attempts`, sawLimit);
  const blocked = await req(brute, { method:'POST', path:'/gate', body:{ passphrase: PASS } });
  eq('and the correct passphrase is refused while cooling off', blocked.status, 429);
  brute.close();

  guarded.close();

  // ── not configured ────────────────────────────────────────────────────
  section('a deployment with a database and no passphrase fails CLOSED');
  const unset = await listen(appWith({ passphrase: '', hasDatabase: true }));
  r = await req(unset, { path: '/' });
  eq('the tree is not served', r.status, 503);
  check('and it says what to set', /APP_PASSPHRASE/.test(r.text));
  check('without serving the tree', !/the tree<\/h1>/.test(r.text));
  eq('the API is closed too', (await req(unset, { path:'/api/tree/x/tree' })).status, 503);
  eq('but the health check still answers', (await req(unset, { path:'/health' })).status, 200);
  unset.close();

  section('locally, with nothing to protect, it stays out of the way');
  const local = await listen(appWith({ passphrase: '', hasDatabase: false }));
  eq('the tree is served', (await req(local, { path: '/' })).status, 200);
  local.close();

  section('the secret is never handed back');
  const leaky = await listen(appWith({ passphrase: PASS, hasDatabase: true }));
  for (const path of ['/', '/gate', '/api/tree/x/tree']) {
    const res = await req(leaky, { path });
    check(`${path} does not contain the passphrase`, !res.text.includes(PASS));
  }
  const wrong = await req(leaky, { method:'POST', path:'/gate', body:{ passphrase:'nope' } });
  check('nor does a failed attempt', !wrong.text.includes(PASS));
  leaky.close();

  report();
})();
