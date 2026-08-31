// The gate.
//
// WHAT CHANGED, AND WHY. This was one passphrase for the whole deployment:
// everybody who had it could open every family's page, and the only thing
// between one family and another was a link nobody was obliged to keep. That
// is fine for one family and wrong for a hundred thousand.
//
// Now there are three ways through, and each one says who you are:
//
//   a family passcode   handle-xxxxxx-xxxxxx. Opens that family and no other.
//   an invitation       a link a family sends a relative, so the passcode
//                       itself need not travel through a group chat.
//   the admin passphrase  opens the admin's own pages and NO family's tree.
//
// and one that is only there so nobody is locked out by the change:
//
//   APP_PASSPHRASE      the old deployment-wide passphrase, which still opens
//                       the home family. A session opened with it is upgraded
//                       to a real one, so it is recorded and revocable like
//                       any other.
//
// THE SECRETS LIVE IN THE ENVIRONMENT AND IN scrypt HASHES, NOWHERE ELSE.
// Nothing here is written to this repository, logged, echoed in an error, or
// sent to the browser. The repository is public.
//
// WHAT THIS DEFENDS AGAINST, honestly. A family tree is not a bank. The
// realistic threat is the open internet — crawlers, scrapers, and whoever a
// link gets forwarded to — and a per-family passcode stops all of that AND
// stops one family reading another's records, which the single passphrase
// never did. It does not stop somebody who has been given a family's passcode
// and should not have been. Nothing can, except issuing a new one, which is
// why the admin can do that and why every use is recorded.
//
// The specific mistakes this is written to avoid, all of them carried over
// from the passphrase gate that came before it:
//
//   * comparing with ===, which leaks a secret one character at a time through
//     response timing. Constant-time comparison throughout, on hashes so that
//     length is not leaked either.
//   * an unknown family answering faster than a wrong passcode, which turns
//     the handle into a way of enumerating who is on this deployment. A
//     sign-in for a handle that does not exist does the scrypt work anyway.
//   * sending the secret on every request, so it sits in every proxy log
//     between the family and the server. It is exchanged once for a cookie.
//   * a cookie that can be forged. The cookie is <session id>.<token>, and
//     only the token's hash is stored — the table cannot be read back into a
//     way in.
//   * unlimited guessing. Attempts are rate-limited per address.
//   * failing OPEN when nothing is configured, which is how a deployment ends
//     up publicly readable without anybody noticing.
//   * a link preview burning a single-use invitation. WhatsApp fetches a link
//     before a human ever clicks it, so GET /join only shows a page; the
//     invitation is taken up by the POST behind the button.

const crypto = require('crypto');
const access = require('./db/access');
const audit = require('./db/audit');
const appeals = require('./db/appeals');

const COOKIE = 'muti_gate';
const SESSION_DAYS = access.SESSION_DAYS;

// Attempts per address before a cool-off. Generous enough that a family typing
// a passcode from a piece of paper is never locked out, small enough that
// guessing 59 bits is hopeless several times over.
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;

// Appeals can be raised from OUTSIDE the gate — they have to be, because the
// commonest appeal is "we have lost our passcode" and that is by definition
// raised by somebody who cannot get in. That makes it the one writable thing
// a stranger can reach, so it is held to a much tighter limit than the door.
const APPEAL_MAX = 3;
const APPEAL_WINDOW_MS = 60 * 60 * 1000;

// Whitespace at either end is not part of anybody's secret, and it is what
// phone keyboards add: a passcode autocorrected on a phone arrives with a
// trailing space more often than not, and the family would have no way of
// telling that from a wrong one. Trimmed on both sides, so a stray space in an
// environment variable cannot lock everybody out either.
const normalise = s => String(s == null ? '' : s).trim();

const sha256 = s => crypto.createHash('sha256').update(normalise(s), 'utf8').digest();

// Equal-length digests, compared in constant time. Hashing first means the
// comparison never depends on the length of either input.
function sameSecret(a, b) {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

/* The OLD session token: <expiry>.<signature>, signed with a key derived from
   the deployment passphrase. Kept for exactly one purpose — recognising a
   cookie issued before this change so that nobody is signed out by a deploy.
   A cookie of this shape is honoured once and immediately replaced with a real
   session, so it cannot go on being an unrecorded, unrevocable way in. */
function legacySign(passphrase, expiresAt) {
  const key = crypto.createHmac('sha256', sha256(passphrase))
                    .update('muti-gate-session-v1').digest();
  return crypto.createHmac('sha256', key).update(String(expiresAt)).digest('hex');
}

function legacyIssue(passphrase, expiresAt = Date.now() + SESSION_DAYS * 86400000) {
  return `${expiresAt}.${legacySign(passphrase, expiresAt)}`;
}

function legacyValid(passphrase, tokenValue) {
  if (typeof tokenValue !== 'string') return false;
  const dot = tokenValue.indexOf('.');
  if (dot < 1) return false;
  const expiresAt = Number(tokenValue.slice(0, dot));
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  const got = tokenValue.slice(dot + 1);
  const want = legacySign(passphrase, expiresAt);
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

/* Rate limiting, per address, in this process.

   In this process is a real limit and it is stated rather than glossed: with
   several instances running, an attacker gets MAX_ATTEMPTS per instance. It
   still turns unlimited guessing into a few dozen tries per quarter of an
   hour against a 59-bit secret, which is not a meaningful attack. Moving the
   counter into Postgres would make it exact at the cost of a write on every
   failed attempt, which is the shape of thing an attacker would then aim at. */
function limiter(max, windowMs) {
  const hits = new Map();
  return {
    tooMany(addr) {
      const a = hits.get(addr);
      if (!a) return false;
      if (Date.now() > a.until) { hits.delete(addr); return false; }
      return a.n >= max;
    },
    note(addr) {
      const a = hits.get(addr);
      if (!a || Date.now() > a.until) hits.set(addr, { n: 1, until: Date.now() + windowMs });
      else a.n++;
      // Bounded, so a flood of addresses cannot grow this without limit.
      if (hits.size > 5000) {
        for (const [k, v] of hits) if (Date.now() > v.until) hits.delete(k);
      }
    },
    clear(addr) { hits.delete(addr); }
  };
}

/* WHO a limit counts against, on a route that is already behind the gate.

   The session, not the address — because a family gathering is forty
   relatives on one hall's wifi, each starting their own tree, and a per-address
   limit would refuse most of them at exactly the moment this project is
   supposed to be working. A session is not free to make: it needs a passcode
   or an invitation.

   Callers pair this with a much larger per-address limit, so that somebody who
   does hold a passcode cannot loop sign-in-and-create from one machine. */
const limitKeyOf = req => req.muti?.session?.id || addressOf(req);

const esc = s => String(s).replace(/[&<>"]/g, c =>
  ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

/* What a link to this project looks like when it is shared.

   This lives on the GATE page, which is worth understanding rather than
   working around: everything else is behind the gate, so the page a crawler
   actually fetches — WhatsApp, Facebook, Slack, iMessage — is this one. Put
   the tags only on the app and every shared link previews as nothing.

   It says what the project is and shows the baobab. It says nothing about any
   family, and it cannot: the same card is served to everybody, before anyone
   has proved they belong here. */
function preview(origin) {
  const title = 'The Muwuyu Project';
  const desc  = 'A Shona family tree. Mitupo, kinship, and the ancestors we share.';
  const img   = (origin || '') + '/preview.jpg';
  return `
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(title)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(img)}">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="A baobab in brass, its roots running down into the soil">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(img)}">
<meta name="theme-color" content="#12100C">`;
}

const SHELL_CSS = `
  :root{color-scheme:light dark;--sky:#F6F1E6;--ink:#221C13;--muted:#6E6555;
        --pod:#FFFDF7;--edge:#E3D9C6;--gold:#8A5A16;}
  @media (prefers-color-scheme:dark){:root{--sky:#12100C;--ink:#F0EADC;
        --muted:#95907F;--pod:#1B1813;--edge:#2E2920;--gold:#D9A441;}}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--sky);
       color:var(--ink);font:15px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;padding:24px}
  .card{width:min(400px,100%);background:var(--pod);border:1px solid var(--edge);
        border-radius:18px;padding:26px 24px}
  h1{margin:0 0 6px;font-size:23px;font-weight:600;letter-spacing:.01em}
  h1 em{font-style:normal;color:var(--gold)}
  p{margin:0 0 18px;color:var(--muted);font-size:13.5px}
  label{display:block;font-size:11px;letter-spacing:.12em;text-transform:uppercase;
        color:var(--muted);margin-bottom:6px;margin-top:14px}
  input,textarea,select{width:100%;padding:11px 13px;border-radius:10px;
        border:1.5px solid var(--edge);background:transparent;color:var(--ink);
        font-size:15px;font-family:inherit}
  textarea{min-height:110px;resize:vertical}
  input:focus,textarea:focus,select:focus{outline:none;border-color:var(--gold)}
  button{width:100%;margin-top:16px;padding:11px;border:none;border-radius:10px;
         background:var(--gold);color:var(--pod);font-size:14px;font-weight:600;cursor:pointer}
  .msg{margin:14px 0 0;padding:9px 12px;border-radius:10px;border:1px solid var(--gold);
       color:var(--gold);font-size:12.5px}
  .note{margin-top:16px;font-size:12px;color:var(--muted)}
  .note a{color:var(--gold)}
  code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
  /* The passcode, the one time it exists anywhere. Big enough to copy off a
     screen by eye and read down a phone line, which is how it will travel. */
  .code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:19px;
        letter-spacing:.06em;color:var(--ink);background:var(--sky);
        border:1.5px dashed var(--gold);border-radius:12px;padding:14px;
        text-align:center;word-break:break-all;margin:0 0 18px}`;

function shell(title, body, origin) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>${preview(origin)}
<style>${SHELL_CSS}</style></head><body>${body}</body></html>`;
}

function page({ message = '', status = 200, notice = '', origin = '',
                openSignup = false } = {}) {
  return { status, html: shell('The Muwuyu Project', `
<form class="card" method="POST" action="/gate" autocomplete="on">
  <h1>The <em>Muwuyu</em> Project</h1>
  <p>A family tree kept by the family. Enter your family's passcode.</p>
  <label for="p">Family passcode</label>
  <input id="p" name="passphrase" type="password" autocomplete="current-password"
         autocapitalize="off" autocorrect="off" spellcheck="false"
         placeholder="handle-xxxxxx-xxxxxx" autofocus required>
  <button type="submit">Enter</button>
  ${message ? `<p class="msg">${esc(message)}</p>` : ''}
  ${notice ? `<p class="note">${esc(notice)}</p>` : ''}
  ${openSignup ? `<p class="note">No family here yet?
     <a href="/start">Start your family's tree.</a></p>` : ''}
  <p class="note">Lost your passcode${openSignup ? '' : ', or need one for your family'}?
     <a href="/appeal">Ask the keeper of this deployment.</a></p>
</form>`, origin) };
}

/* STARTING A FAMILY, from outside.

   The question this answers is "how does a family sign up", and until now the
   honest answer was that they could not: the door took a passcode, and a
   passcode came from a family that already existed. Everybody was somebody
   else's guest.

   It writes — a tree, a passcode, a session — which makes it the second thing
   a stranger can reach, and it is held to a tighter limit than the door for
   that reason. A deployment that would rather issue every family itself sets
   MW_OPEN_SIGNUP=off and this disappears, leaving the appeal as the way in. */
function startPage({ message = '', origin = '' } = {}) {
  return shell('Start a family — The Muwuyu Project', `
<form class="card" method="POST" action="/start">
  <h1>Start your family's tree</h1>
  <p>You will be given a passcode. It is the only way back into this family,
     it is shown once, and nobody — not even the keeper of this site — can
     read it back to you afterwards.</p>
  <label for="n">Whose family is this?</label>
  <input id="n" name="name" type="text" autocomplete="off"
         placeholder="the Musoni family" autofocus required maxlength="200">
  <button type="submit">Start it</button>
  ${message ? `<p class="msg">${esc(message)}</p>` : ''}
  <p class="note">Already have a passcode? <a href="/gate">Go to the door.</a></p>
</form>`, origin);
}

/* The passcode, once.

   Not a redirect into the tree with a toast that scrolls away. It is stored as
   a scrypt hash, so this is the only moment it exists anywhere — and a family
   that walks past it has to ask the keeper for another. */
function startedPage({ name, passcode, origin = '' } = {}) {
  return shell('Your passcode — The Muwuyu Project', `
<div class="card">
  <h1>${esc(name)}</h1>
  <p>Write this down now, before you go on.</p>
  <p class="code">${esc(passcode)}</p>
  <p class="note">It will not be shown again. It is not stored anywhere it can
     be read from — not by the keeper of this site, not by anybody who reaches
     the database. Losing it means being issued another, which means asking
     the keeper.</p>
  <p class="note">Give it only to your own family. Anybody holding it can open
     this tree.</p>
  <form method="GET" action="/"><button type="submit">I have written it down</button></form>
</div>`, origin);
}

/* The invitation page.

   A GET only SHOWS this. Taking up the invitation is the POST behind the
   button, because a link sent through WhatsApp is fetched by WhatsApp before
   any human sees it — and a single-use invitation consumed by a link preview
   is an invitation the relative never gets. */
function joinPage({ token, message = '', origin = '', spent = false } = {}) {
  return shell('An invitation — The Muwuyu Project', `
<form class="card" method="POST" action="/join">
  <h1>You have been invited</h1>
  <p>Somebody in the family has asked you to help build their tree.</p>
  <input type="hidden" name="token" value="${esc(token)}">
  ${spent ? '' : '<button type="submit">Open the family tree</button>'}
  ${message ? `<p class="msg">${esc(message)}</p>` : ''}
  <p class="note">This link is for you. It works once, and it does not give
     out the family's passcode.</p>
</form>`, origin);
}

function appealPage({ message = '', done = false, origin = '', kind = 'passcode' } = {}) {
  if (done) {
    return shell('Sent — The Muwuyu Project', `
<div class="card">
  <h1>That has been sent</h1>
  <p>The keeper of this deployment will see it. If you left a way of reaching
     you, they will use it.</p>
  <p class="note"><a href="/gate">Back to the door</a></p>
</div>`, origin);
  }
  const opt = (v, label) =>
    `<option value="${v}"${kind === v ? ' selected' : ''}>${esc(label)}</option>`;
  return shell('Ask the keeper — The Muwuyu Project', `
<form class="card" method="POST" action="/appeal">
  <h1>Ask the keeper</h1>
  <p>For a passcode you have lost, a family that cannot get in, or a record
     somebody has taken out of a tree that you do not agree with.</p>
  <label for="k">What is this about</label>
  <select id="k" name="kind">
    ${opt('passcode', 'We have lost our family passcode')}
    ${opt('access', 'We cannot get in, and do not know why')}
    ${opt('erasure', 'Somebody has been taken out of our tree')}
    ${opt('other', 'Something else')}
  </select>
  <label for="f">Your family, if you know it</label>
  <input id="f" name="family" autocapitalize="off" autocorrect="off"
         placeholder="the name, or the handle from your passcode">
  <label for="b">What has happened</label>
  <textarea id="b" name="body" required
            placeholder="Tell them enough to find you and to know what to do."></textarea>
  <label for="c">How to reach you</label>
  <input id="c" name="contact" placeholder="a number, or a name to ask for">
  <label for="n">Your name</label>
  <input id="n" name="by" placeholder="who is asking">
  <button type="submit">Send it</button>
  ${message ? `<p class="msg">${esc(message)}</p>` : ''}
  <p class="note">This is the only thing on this site a stranger can send.
     Nothing you write here goes into anybody's family tree.</p>
</form>`, origin);
}

/* The deployment is misconfigured: a real database, no way for anybody to
   prove they belong. Serving the tree here is how a family's records end up
   publicly readable with nobody noticing, so it serves this instead. Fail
   closed, and explain. */
function unconfiguredPage() {
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>The Muwuyu Project — not configured</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;
             font:15px/1.7 system-ui,sans-serif;background:#F6F1E6;color:#221C13;padding:24px">
<div style="max-width:460px">
  <h1 style="font-size:21px;margin:0 0 10px">This deployment has no way in set up</h1>
  <p style="color:#6E6555">The family tree is not being served, because without
  a passcode or an admin passphrase it would be readable by anyone who found
  the address.</p>
  <p style="color:#6E6555">Set <code>MW_ADMIN_PASSPHRASE</code> (and, for the
  older deployment-wide door, <code>APP_PASSPHRASE</code>) in the deployment's
  environment variables and restart. Nothing has been lost — the records are in
  the database, waiting.</p>
</div></body>`;
}

/* Which address the request came from, for rate limiting and for the record.
   Behind Railway's proxy the socket address is the proxy's. */
const addressOf = req =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
  req.socket?.remoteAddress || 'unknown';

function originOf(req) {
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() ||
                (req.secure ? 'https' : 'http');
  return req.headers.host ? `${proto}://${req.headers.host}` : '';
}

function setCookie(res, req, value) {
  res.cookie(COOKIE, value, {
    httpOnly: true,                 // script on the page can never read it
    sameSite: 'lax',
    secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: '/'
  });
}

/* Express middleware.

   Returns a no-op when nothing is configured AND there is no database, which
   is the local `npm start` case: nothing to protect and nobody to protect it
   from. With a database and nothing configured it fails closed. */
function gate({
  passphrase, adminPassphrase, hasDatabase, openSignup = false,
  getPool = () => null, getHomeTreeId = () => null, log = console.log
} = {}) {
  const secret = normalise(passphrase);
  const adminSecret = normalise(adminPassphrase);

  if (!secret && !adminSecret) {
    if (hasDatabase) {
      log('\n  Neither MW_ADMIN_PASSPHRASE nor APP_PASSPHRASE is set, and this\n' +
          '  deployment has a database. Refusing to serve the family trees\n' +
          '  openly. Set MW_ADMIN_PASSPHRASE in the environment (Railway: the\n' +
          '  service\'s Variables tab) and redeploy.\n');
      return (req, res, next) => {
        if (req.path === '/health') return next();
        res.status(503).type('html').send(unconfiguredPage());
      };
    }
    log('No passphrase set — running without a gate (no database to protect).');
    return (req, res, next) => next();
  }

  log(`Gate is on: ${adminSecret ? 'admin passphrase set, ' : 'NO admin passphrase, '}` +
      `${secret ? 'legacy deployment passphrase set, ' : ''}` +
      `family passcodes ${hasDatabase ? 'enabled' : 'unavailable (no database)'}. ` +
      `Sessions last ${SESSION_DAYS} days.`);
  log(openSignup && hasDatabase
    ? 'Families can start their own tree at /start (MW_OPEN_SIGNUP=off to close it).'
    : 'Starting a family from outside is off — the keeper issues them.');

  const doorLimit = limiter(MAX_ATTEMPTS, WINDOW_MS);
  const appealLimit = limiter(APPEAL_MAX, APPEAL_WINDOW_MS);
  /* Tighter than the door and tighter than appeals, because this is the only
     unauthenticated path that creates rows nothing else can reach. Three in an
     hour is more than any real household needs and far less than a script
     wants. */
  const startLimit = limiter(3, 60 * 60 * 1000);

  return function gateMiddleware(req, res, next) {
    Promise.resolve(handle(req, res, next)).catch(next);
  };

  async function handle(req, res, next) {
    // The health check is what the platform uses to decide whether this
    // instance is alive. Putting it behind the gate makes a healthy deploy
    // look dead.
    if (req.path === '/health') return next();

    // The link-preview card, and only it. When somebody shares a link to this
    // project, the crawler that builds the preview has no passcode — so an
    // og:image behind the gate is an image the preview cannot show. This one
    // file is generic artwork with no family data in it, which is why it can
    // be let through and why nothing else here can.
    if (req.method === 'GET' && req.path === '/preview.jpg') return next();

    const pool = getPool();
    const addr = addressOf(req);
    const origin = originOf(req);
    const ip = audit.clientIp(req);
    const userAgent = audit.uaOf(req);
    const ctx = { ip, userAgent, method: req.method, path: req.path };

    // ── the door ──────────────────────────────────────────────────────────
    if (req.path === '/gate' && req.method === 'POST') {
      if (doorLimit.tooMany(addr)) {
        await audit.record(pool, { ...ctx, kind: 'gate.locked', ok: false });
        const p = page({ message: 'Too many attempts. Wait a few minutes and try again.', openSignup,
                         status: 429, origin });
        return res.status(p.status).type('html').send(p.html);
      }

      const given = normalise(req.body && req.body.passphrase);
      const actor = String(req.body?.by || '').slice(0, 120);

      // 1. The admin. Checked first so that an admin passphrase which happens
      //    to look like a passcode is never spent looking for a family.
      if (adminSecret && given && sameSecret(given, adminSecret)) {
        doorLimit.clear(addr);
        if (!pool) return refuse(res, origin, 'The admin pages need a database.');
        const session = await access.createSession(pool, {
          scope: 'admin', via: 'admin', actor: actor || 'admin', ip, userAgent
        });
        await audit.record(pool, { ...ctx, kind: 'gate.ok', ok: true,
          sessionId: session.id, actor: actor || 'admin', detail: { scope: 'admin' } });
        setCookie(res, req, session.cookie);
        return res.redirect(303, '/admin');
      }

      // 2. The old deployment-wide passphrase, which opens the home family.
      //    Kept so this change signs nobody out; recorded as 'legacy' so it is
      //    visible in the dashboard how many people are still coming that way.
      if (secret && given && sameSecret(given, secret)) {
        doorLimit.clear(addr);
        const homeTreeId = getHomeTreeId();
        if (!pool || !homeTreeId) {
          // No database: the local look-at-it case. There is no family to scope
          // a session to and no table to keep one in, so it falls back to the
          // signed cookie the old gate used — SIGNED, not a bare marker, so it
          // cannot be forged and so changing the passphrase still ends it.
          setCookie(res, req, legacyIssue(secret));
          return res.redirect(303, '/');
        }
        const { rows } = await pool.query(
          'SELECT passcode_gen FROM trees WHERE id = $1', [homeTreeId]);
        const session = await access.createSession(pool, {
          scope: 'family', treeId: homeTreeId, via: 'legacy',
          passcodeGen: rows[0]?.passcode_gen ?? 0, actor, ip, userAgent
        });
        await audit.record(pool, { ...ctx, kind: 'gate.ok', ok: true, treeId: homeTreeId,
          sessionId: session.id, actor, detail: { via: 'legacy' } });
        setCookie(res, req, session.cookie);
        return res.redirect(303, '/');
      }

      // 3. A family passcode.
      if (pool && given) {
        const result = await access.signIn(pool, given, { ip, userAgent, actor });
        if (result.ok) {
          doorLimit.clear(addr);
          await audit.record(pool, { ...ctx, kind: 'gate.ok', ok: true,
            treeId: result.treeId, sessionId: result.session.id, actor,
            detail: { via: 'passcode', handle: result.handle } });
          setCookie(res, req, result.session.cookie);
          return res.redirect(303, '/');
        }
        if (result.reason === 'suspended') {
          await audit.record(pool, { ...ctx, kind: 'gate.suspended', ok: false,
            treeId: result.treeId, actor });
          const p = page({
            status: 403, origin,
            message: 'This family\'s tree has been closed by the keeper of this ' +
                     'deployment. Nothing has been lost.',
            notice: 'Use the link below to ask why.' });
          return res.status(p.status).type('html').send(p.html);
        }
        doorLimit.note(addr);
        // The reason is for the record, never for the person at the door:
        // 'no_family' and 'wrong' must be indistinguishable from outside or
        // the handle becomes a way of finding out which families exist.
        await audit.record(pool, { ...ctx, kind: 'gate.fail', ok: false,
          treeId: result.treeId || null, actor, detail: { reason: result.reason } });
        const p = page({ message: 'That passcode was not recognised.', status: 401, origin, openSignup });
        return res.status(p.status).type('html').send(p.html);
      }

      doorLimit.note(addr);
      await audit.record(pool, { ...ctx, kind: 'gate.fail', ok: false,
        detail: { reason: 'no_match' } });
      const p = page({ message: 'That passcode was not recognised.', status: 401, origin, openSignup });
      return res.status(p.status).type('html').send(p.html);
    }

    // ── invitations ───────────────────────────────────────────────────────
    // GET only shows the page. See joinPage: a link preview must not spend a
    // single-use invitation before the relative has clicked anything.
    if (req.method === 'GET' && req.path.startsWith('/join/')) {
      const token = decodeURIComponent(req.path.slice('/join/'.length));
      return res.type('html').send(joinPage({ token, origin }));
    }

    if (req.method === 'POST' && req.path === '/join') {
      if (doorLimit.tooMany(addr)) {
        await audit.record(pool, { ...ctx, kind: 'gate.locked', ok: false });
        return res.status(429).type('html').send(
          joinPage({ token: '', spent: true, origin,
                     message: 'Too many attempts. Wait a few minutes and try again.' }));
      }
      if (!pool) return refuse(res, origin, 'Invitations need a database.');

      const result = await access.acceptInvite(pool, String(req.body?.token || ''),
        { ip, userAgent, actor: String(req.body?.by || '').slice(0, 120) });

      if (result.ok) {
        doorLimit.clear(addr);
        await audit.record(pool, { ...ctx, kind: 'invite.accepted', ok: true,
          treeId: result.treeId, sessionId: result.session.id,
          detail: { inviteId: result.inviteId } });
        setCookie(res, req, result.session.cookie);
        return res.redirect(303, '/');
      }
      doorLimit.note(addr);
      await audit.record(pool, { ...ctx, kind: 'invite.rejected', ok: false,
        treeId: result.treeId || null, detail: { reason: result.reason } });
      return res.status(403).type('html').send(joinPage({
        token: '', spent: true, origin,
        message: result.reason === 'suspended'
          ? 'This family\'s tree has been closed by the keeper of this deployment.'
          : 'This invitation cannot be used. It may have been used already, ' +
            'withdrawn, or run out of time. Ask whoever sent it for another.' }));
    }

    // ── starting a family, from outside ───────────────────────────────────
    // Offered on the strength of hasDatabase, which is what the door was told
    // at boot; the POST below checks for the pool itself, because a form that
    // cannot be submitted is worse than one that was never shown.
    if (openSignup && hasDatabase && req.path === '/start' && req.method === 'GET') {
      return res.type('html').send(startPage({ origin }));
    }

    if (openSignup && hasDatabase && req.path === '/start' && req.method === 'POST') {
      if (!pool) return refuse(res, origin, 'Starting a family needs a database.');
      if (startLimit.tooMany(addr)) {
        return res.status(429).type('html').send(startPage({
          origin, message: 'That is several families started from here in a ' +
                           'short time. Try again in an hour — any you have ' +
                           'already started are untouched.' }));
      }
      const name = String(req.body?.name || '').trim().slice(0, 200);
      if (!name) {
        return res.status(400).type('html').send(startPage({
          origin, message: 'Give the family a name first.' }));
      }
      startLimit.note(addr);
      try {
        const { rows } = await pool.query(
          `INSERT INTO trees (name, created_by) VALUES ($1, $2)
           RETURNING id, name, handle`, [name, 'started from the door']);
        const made = rows[0];
        const issued = await access.issuePasscode(pool, made.id, { by: 'signup' });
        /* Signed in on the way out, so the button under the passcode opens
           their own tree rather than the door they just came through. */
        const session = await access.createSession(pool, {
          scope: 'family', treeId: made.id, via: 'created',
          passcodeGen: issued.passcode_gen, ip, userAgent
        });
        setCookie(res, req, session.cookie);
        await audit.record(pool, { ...ctx, kind: 'family.created', ok: true,
          treeId: made.id, sessionId: session.id,
          detail: { name: made.name, handle: made.handle, from: 'signup' } });
        await audit.record(pool, { ...ctx, kind: 'passcode.set', ok: true,
          treeId: made.id, sessionId: session.id,
          detail: { generation: issued.passcode_gen, from: 'signup' } });
        return res.type('html').send(startedPage({
          name: made.name, passcode: issued.passcode, origin }));
      } catch (e) {
        console.error('start', e);
        return res.status(500).type('html').send(startPage({
          origin, message: 'That could not be started just now.' }));
      }
    }

    // ── appeals, from outside ─────────────────────────────────────────────
    // The one writable thing a stranger can reach, because the commonest
    // appeal is from somebody who cannot get in. Held to a much tighter limit
    // than the door, and it writes to a table nothing else reads.
    if (req.path === '/appeal' && req.method === 'GET') {
      return res.type('html').send(appealPage({ origin }));
    }

    if (req.path === '/appeal' && req.method === 'POST') {
      if (appealLimit.tooMany(addr)) {
        return res.status(429).type('html').send(appealPage({
          origin, message: 'That is enough for now. Try again in an hour.' }));
      }
      if (!pool) return refuse(res, origin, 'Appeals need a database.');
      appealLimit.note(addr);

      // Whatever they wrote about which family they are — a name, a handle, or
      // nothing. Matched to a real family if it can be, and kept as text
      // either way so the appeal still says what they told us.
      const said = String(req.body?.family || '').trim().slice(0, 200);
      let treeId = null;
      if (said) {
        try {
          const { rows } = await pool.query(
            `SELECT id FROM trees WHERE handle = lower($1) OR key = lower($1)
              LIMIT 1`, [said]);
          treeId = rows[0]?.id || null;
        } catch { /* an unmatched family is not an error */ }
      }

      try {
        const raised = await appeals.raise(pool, {
          treeId, treeLabel: said, kind: String(req.body?.kind || 'other'),
          body: String(req.body?.body || ''), contact: String(req.body?.contact || ''),
          by: String(req.body?.by || ''), ip
        });
        await audit.record(pool, { ...ctx, kind: 'appeal.raised', ok: true,
          treeId, actor: String(req.body?.by || '').slice(0, 120),
          detail: { appealId: raised.id, kind: raised.kind, from: 'outside' } });
        return res.type('html').send(appealPage({ done: true, origin }));
      } catch (e) {
        return res.status(e.status || 400).type('html').send(appealPage({
          origin, message: e.message || 'That could not be sent.' }));
      }
    }

    // ── everything else needs a session ───────────────────────────────────
    const cookie = readCookie(req.headers.cookie, COOKIE);
    let session = pool ? await access.readSession(pool, cookie) : null;

    // A cookie from before this change. Honoured once and immediately replaced
    // with a real session, so nobody is signed out by the deploy and nobody
    // keeps an unrecorded, unrevocable way in either.
    if (!session && secret && cookie && legacyValid(secret, cookie)) {
      const homeTreeId = getHomeTreeId();
      if (!pool || !homeTreeId) return next();
      const { rows } = await pool.query(
        'SELECT passcode_gen, suspended_at FROM trees WHERE id = $1', [homeTreeId]);
      if (rows.length && !rows[0].suspended_at) {
        const fresh = await access.createSession(pool, {
          scope: 'family', treeId: homeTreeId, via: 'legacy',
          passcodeGen: rows[0].passcode_gen ?? 0, ip, userAgent
        });
        await audit.record(pool, { ...ctx, kind: 'gate.ok', ok: true, treeId: homeTreeId,
          sessionId: fresh.id, detail: { via: 'legacy-upgrade' } });
        setCookie(res, req, fresh.cookie);
        session = { id: fresh.id, scope: 'family', treeId: homeTreeId, via: 'legacy' };
      }
    }

    if (session) {
      req.muti = {
        session,
        scope: session.scope,
        treeId: session.treeId || null,
        actor: session.actor || ''
      };
      // Cheap, throttled, and never blocks the request: see access.touch.
      access.touch(pool, session.id, { ip }).catch(() => {});
      return next();
    }

    // An API request from a page whose session has ended should get an answer
    // it can act on, not a login page it will try to parse as JSON.
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({
        error: 'not_signed_in',
        message: 'This session has ended. Reload the page and enter your family passcode again.'
      });
    }

    const p = page({ status: 401, origin, openSignup });
    return res.status(p.status).type('html').send(p.html);
  }

  function refuse(res, origin, message) {
    const p = page({ status: 503, origin, message, openSignup });
    return res.status(p.status).type('html').send(p.html);
  }
}

/* Guards for what sits behind the gate.

   The gate says somebody got in; these say what they got in AS. Both refuse
   rather than redirect, because everything they protect is either an API a
   page is calling or a dashboard a person reached deliberately. */
function requireAdmin(req, res, next) {
  if (req.muti?.scope === 'admin') return next();
  if (req.path.startsWith('/api/') || req.get('accept')?.includes('json')) {
    return res.status(403).json({
      error: 'not_admin',
      message: 'These pages are for the keeper of this deployment.'
    });
  }
  return res.status(403).type('html').send(`<!doctype html><meta charset="utf-8">
<title>Not for you</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;
             font:15px/1.7 system-ui,sans-serif;background:#F6F1E6;color:#221C13;padding:24px">
<div style="max-width:420px">
  <h1 style="font-size:20px;margin:0 0 10px">These pages are not for you</h1>
  <p style="color:#6E6555">You are signed in to a family tree, not to the
  administration of this deployment. <a href="/" style="color:#8A5A16">Back to
  your family</a>.</p>
</div></body>`);
}

/* A family session may only ever act on ITS OWN family.

   This is the rule that makes per-family passcodes worth anything. Without it
   the passcodes would decide who gets in and then every signed-in visitor
   could still call /api/tree/<any id>/tree, which is the single passphrase
   again with more steps. An admin session is not a family session and does not
   pass this — the admin can see that a family exists and can decide who may
   open it, and cannot read what is inside. */
function requireOwnTree(paramName = 'id') {
  return function ownTree(req, res, next) {
    const wanted = req.params?.[paramName];
    if (!wanted) return next();
    if (req.muti?.scope === 'family' && req.muti.treeId === wanted) return next();
    // The same answer whether the family exists or not: anything finer is a
    // way of finding out which ids are real.
    return res.status(404).json({
      error: 'no_such_family',
      message: 'No family answers to that. It may have been changed, or you may ' +
               'be signed in to a different one.'
    });
  };
}

module.exports = {
  gate, requireAdmin, requireOwnTree, limiter, addressOf, limitKeyOf,
  COOKIE, SESSION_DAYS, MAX_ATTEMPTS, WINDOW_MS, APPEAL_MAX,
  // exported for tests only
  _internals: { sameSecret, readCookie, legacySign, legacyValid, legacyIssue,
                page, limiter, normalise,
                // The names the gate suite has always used for the pre-session
                // cookie. Kept pointing at the legacy pair rather than renamed
                // in the tests, so those assertions go on testing the same
                // thing: that a cookie of the old shape cannot be forged or
                // stretched past its expiry.
                issue: legacyIssue, valid: legacyValid, sign: legacySign }
};
