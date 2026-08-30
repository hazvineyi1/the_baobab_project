// The passphrase gate.
//
// One shared passphrase for the whole deployment. It is not a user system and
// does not pretend to be: it answers "may this person use this instance at
// all", nothing finer. Who somebody is inside the tree is a separate question
// that the app answers separately, and access to a particular family's tree is
// a third (see the tree key in db/home.js).
//
// THE SECRET LIVES IN THE ENVIRONMENT AND NOWHERE ELSE.
// It is never written to this repository, never logged, never echoed in an
// error, and never sent to the browser. The repository is public.
//
// WHAT IT ACTUALLY DEFENDS AGAINST. A family tree is not a bank, and the
// realistic threat is not a determined attacker — it is the open internet:
// crawlers, scrapers, and anybody who is sent the link. A shared passphrase
// stops all of that. It does not stop somebody who has been given the
// passphrase and should not have been, and it cannot: a shared secret is only
// as private as the people sharing it. That is the honest limit, and it is
// stated here rather than left for somebody to discover.
//
// The specific mistakes this is written to avoid:
//
//   * comparing with === , which leaks the passphrase one character at a time
//     through response timing. timingSafeEqual, on hashes so that length is
//     not leaked either.
//   * sending the passphrase on every request, so that it sits in every proxy
//     log between the family and the server. It is exchanged once for a
//     signed, expiring cookie.
//   * a cookie that can be forged. It is HMAC-signed with a key derived from
//     the passphrase, so changing the passphrase invalidates every session,
//     and no second secret has to be configured or kept in step.
//   * unlimited guessing. Attempts are rate-limited per address.
//   * failing OPEN when the passphrase is not configured, which is how a
//     deployment ends up publicly readable without anybody noticing.

const crypto = require('crypto');

const COOKIE = 'muti_gate';
const SESSION_DAYS = 30;

// Attempts allowed per address before a cool-off. Generous enough that a
// family typing a passphrase from memory is never locked out, small enough
// that guessing is hopeless.
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;

// Whitespace at either end is not part of anybody's passphrase, and it is
// what phone keyboards add: a multi-word passphrase autocorrected on a phone
// arrives with a trailing space more often than not, and the family would have
// no way of telling that from a wrong passphrase. Trimmed on both sides, so a
// stray space in the environment variable cannot lock everybody out either.
const normalise = s => String(s == null ? '' : s).trim();

const sha256 = s => crypto.createHash('sha256').update(normalise(s), 'utf8').digest();

// Equal-length digests, compared in constant time. Hashing first means the
// comparison never depends on the length of either input.
function sameSecret(a, b) {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

/* The session token: <expiry>.<signature>. There is nothing else in it,
   because there is nothing else to say — the gate knows only that somebody
   got through it. */
function sign(passphrase, expiresAt) {
  const key = crypto.createHmac('sha256', sha256(passphrase))
                    .update('muti-gate-session-v1').digest();
  return crypto.createHmac('sha256', key).update(String(expiresAt)).digest('hex');
}

function issue(passphrase) {
  const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  return `${expiresAt}.${sign(passphrase, expiresAt)}`;
}

function valid(passphrase, token) {
  if (typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const expiresAt = Number(token.slice(0, dot));
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  const got = token.slice(dot + 1);
  const want = sign(passphrase, expiresAt);
  if (got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got, 'utf8'), Buffer.from(want, 'utf8'));
}

// Cookies, without pulling in a parser for one value.
function readCookie(header, name) {
  if (!header) return null;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      try { return decodeURIComponent(part.slice(eq + 1).trim()); }
      catch { return null; }
    }
  }
  return null;
}

const attempts = new Map();       // address -> { n, until }

function tooManyAttempts(addr) {
  const a = attempts.get(addr);
  if (!a) return false;
  if (Date.now() > a.until) { attempts.delete(addr); return false; }
  return a.n >= MAX_ATTEMPTS;
}

function noteFailure(addr) {
  const a = attempts.get(addr);
  if (!a || Date.now() > a.until) attempts.set(addr, { n: 1, until: Date.now() + WINDOW_MS });
  else a.n++;
  // Bounded so a flood of addresses cannot grow this without limit.
  if (attempts.size > 5000) {
    for (const [k, v] of attempts) if (Date.now() > v.until) attempts.delete(k);
  }
}

const esc = s => String(s).replace(/[&<>"]/g, c =>
  ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

function page({ message = '', status = 200, notice = '' } = {}) {
  return { status, html: `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>The Baobab Project</title>
<style>
  :root{color-scheme:light dark;--sky:#F6F1E6;--ink:#221C13;--muted:#6E6555;
        --pod:#FFFDF7;--edge:#E3D9C6;--gold:#8A5A16;}
  @media (prefers-color-scheme:dark){:root{--sky:#12100C;--ink:#F0EADC;
        --muted:#95907F;--pod:#1B1813;--edge:#2E2920;--gold:#D9A441;}}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--sky);
       color:var(--ink);font:15px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;padding:24px}
  .card{width:min(380px,100%);background:var(--pod);border:1px solid var(--edge);
        border-radius:18px;padding:26px 24px}
  h1{margin:0 0 6px;font-size:23px;font-weight:600;letter-spacing:.01em}
  h1 em{font-style:normal;color:var(--gold)}
  p{margin:0 0 18px;color:var(--muted);font-size:13.5px}
  label{display:block;font-size:11px;letter-spacing:.12em;text-transform:uppercase;
        color:var(--muted);margin-bottom:6px}
  input{width:100%;padding:11px 13px;border-radius:10px;border:1.5px solid var(--edge);
        background:transparent;color:var(--ink);font-size:15px}
  input:focus{outline:none;border-color:var(--gold)}
  button{width:100%;margin-top:12px;padding:11px;border:none;border-radius:10px;
         background:var(--gold);color:var(--pod);font-size:14px;font-weight:600;cursor:pointer}
  .msg{margin:14px 0 0;padding:9px 12px;border-radius:10px;border:1px solid var(--gold);
       color:var(--gold);font-size:12.5px}
  .note{margin-top:16px;font-size:12px;color:var(--muted)}
</style></head><body>
<form class="card" method="POST" action="/gate" autocomplete="on">
  <h1>The <em>Baobab</em> Project</h1>
  <p>A family tree kept by the family. Enter the passphrase you were given.</p>
  <label for="p">Passphrase</label>
  <input id="p" name="passphrase" type="password" autocomplete="current-password"
         autofocus required>
  <button type="submit">Enter</button>
  ${message ? `<p class="msg">${esc(message)}</p>` : ''}
  ${notice ? `<p class="note">${esc(notice)}</p>` : ''}
</form></body></html>` };
}

/* The deployment is misconfigured: a real database, no passphrase. Serving the
   tree here is how a family's records end up publicly readable with nobody
   noticing, so it serves this instead. Fail closed, and explain. */
function unconfiguredPage() {
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>The Baobab Project — not configured</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;
             font:15px/1.7 system-ui,sans-serif;background:#F6F1E6;color:#221C13;padding:24px">
<div style="max-width:440px">
  <h1 style="font-size:21px;margin:0 0 10px">This deployment has no passphrase set</h1>
  <p style="color:#6E6555">The family tree is not being served, because without
  a passphrase it would be readable by anyone who found the address.</p>
  <p style="color:#6E6555">Set <code>APP_PASSPHRASE</code> in the deployment's
  environment variables and restart. Nothing has been lost — the records are
  in the database, waiting.</p>
</div></body>`;
}

/* Express middleware.

   Returns a no-op when there is no passphrase AND no database, which is the
   local `npm start` case: nothing to protect and nobody to protect it from.
   With a database and no passphrase it fails closed. */
function gate({ passphrase, hasDatabase, log = console.log } = {}) {
  const secret = normalise(passphrase);

  if (!secret) {
    if (hasDatabase) {
      log('\n  APP_PASSPHRASE is not set, and this deployment has a database.\n' +
          '  Refusing to serve the family tree openly. Set APP_PASSPHRASE in the\n' +
          '  environment (Railway: the service\'s Variables tab) and redeploy.\n');
      return (req, res, next) => {
        if (req.path === '/health') return next();
        res.status(503).type('html').send(unconfiguredPage());
      };
    }
    log('No APP_PASSPHRASE set — running without a gate (no database to protect).');
    return (req, res, next) => next();
  }

  log(`Passphrase gate is on. Sessions last ${SESSION_DAYS} days.`);

  return function gateMiddleware(req, res, next) {
    // The health check is what the platform uses to decide whether this
    // instance is alive. Putting it behind the gate makes a healthy deploy
    // look dead.
    if (req.path === '/health') return next();

    const addr = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
                 req.socket?.remoteAddress || 'unknown';

    if (req.method === 'POST' && req.path === '/gate') {
      if (tooManyAttempts(addr)) {
        const p = page({ message: 'Too many attempts. Wait a few minutes and try again.',
                         status: 429 });
        return res.status(p.status).type('html').send(p.html);
      }
      const given = normalise(req.body && req.body.passphrase);
      if (given && sameSecret(given, secret)) {
        attempts.delete(addr);
        res.cookie(COOKIE, issue(secret), {
          httpOnly: true,               // script on the page can never read it
          sameSite: 'lax',
          secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
          maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
          path: '/'
        });
        return res.redirect(303, '/');
      }
      noteFailure(addr);
      // The same words whether the passphrase was wrong or empty: a message
      // that distinguishes them is a message that helps somebody guess.
      const p = page({ message: 'That passphrase was not recognised.', status: 401 });
      return res.status(p.status).type('html').send(p.html);
    }

    if (valid(secret, readCookie(req.headers.cookie, COOKIE))) return next();

    if (req.path === '/gate' && req.method === 'GET') {
      const p = page();
      return res.status(p.status).type('html').send(p.html);
    }

    // An API request from a page whose session has expired should get an
    // answer it can act on, not a login page it will try to parse as JSON.
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({
        error: 'not_signed_in',
        message: 'This session has expired. Reload the page and enter the passphrase again.'
      });
    }

    const p = page({ status: 401 });
    return res.status(p.status).type('html').send(p.html);
  };
}

module.exports = { gate, COOKIE, SESSION_DAYS, MAX_ATTEMPTS, WINDOW_MS,
                   // exported for tests only
                   _internals: { sign, issue, valid, sameSecret, readCookie } };
