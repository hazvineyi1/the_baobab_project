// Passcodes, sessions and invitations.
//
// WHO CAN OPEN WHAT, in one paragraph. A family has a passcode. Holding it
// opens that family's tree and nothing else. The family can invite relatives
// with a link, so the passcode itself need not be passed around a group chat.
// An admin has a separate passphrase, opens no family's tree by default, and
// can issue a family a new passcode when theirs is lost or has travelled too
// far. Every one of those acts is recorded.
//
// WHAT IS AND IS NOT STORED.
//
//   passcode  scrypt hash, per-family salt. Not recoverable. The admin knows
//             a passcode at the moment they issue it and never again.
//   session   the cookie is <id>.<token>; only sha256(token) is stored, so
//             reading the sessions table gives nobody a way in.
//   invite    the same: the token is in the link, the hash is in the table.
//
// The pattern throughout is that the database holds enough to CHECK a secret
// and never enough to PRESENT one.

const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

// Deliberately slow. This is the one place in the project where an attacker
// gets unlimited tries against a stored value, so the cost of one guess is
// the whole defence. ~100ms per attempt on ordinary hardware; a family types
// their passcode once a month and never notices, and a million guesses takes
// a machine-year.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

const SESSION_DAYS = 30;
const INVITE_DAYS = 14;

// The characters that survive being read down a phone line and copied off a
// screen: no 0/O, no 1/I/l.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/* Random over the alphabet, without modulo bias.

   256 is not a multiple of 31, so `byte % 31` would make the first nine
   letters very slightly likelier than the rest. Irrelevant for a handle,
   not irrelevant for the secret half — so bytes that fall in the short tail
   are thrown away rather than folded. */
function code(n) {
  const max = 256 - (256 % ALPHABET.length);
  let out = '';
  while (out.length < n) {
    for (const b of crypto.randomBytes(n * 2)) {
      if (b >= max) continue;
      out += ALPHABET[b % ALPHABET.length];
      if (out.length === n) break;
    }
  }
  return out;
}

const token = () => crypto.randomBytes(32).toString('base64url');
const sha256 = s => crypto.createHash('sha256').update(String(s), 'utf8').digest();

/* Whitespace at the ends is what phone keyboards add, not what anybody
   intended. Case is not part of a passcode either: the alphabet is lower
   case, and a phone that capitalises the first letter must not lock a family
   out of their own tree. */
const normalise = s => String(s == null ? '' : s).trim().toLowerCase();

// ── passcodes ──────────────────────────────────────────────────────────────

/* handle-secret-secret. The handle is the family's, stored in the clear, and
   says WHICH family a sign-in is for — without it the server would have to
   try the guess against every family in the table, which at scale is not a
   slow lookup but an impossible one. The two groups after it are the secret:
   12 characters over 31 is about 59 bits, which is not guessable at 100ms a
   try, and this is rate-limited on top. */
function makePasscode(handle) {
  return `${handle}-${code(6)}-${code(6)}`;
}

/* The handle is everything before the first dash. Split there rather than on
   every dash so that a family who types their own passcode with a stray dash
   in it still gets the right family looked up. */
function splitPasscode(given) {
  const s = normalise(given);
  const dash = s.indexOf('-');
  if (dash < 1) return null;
  return { handle: s.slice(0, dash), passcode: s };
}

async function hashPasscode(passcode) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(normalise(passcode), salt, SCRYPT.keylen,
                           { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

/* Constant time, and false rather than a throw on anything malformed — a
   stored value this cannot parse must read as "does not match", never as an
   error the caller might mistake for a match. */
async function checkPasscode(given, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, N, r, p, saltHex, keyHex] = parts;
    const salt = Buffer.from(saltHex, 'hex');
    const want = Buffer.from(keyHex, 'hex');
    if (!salt.length || !want.length) return false;
    const got = await scrypt(normalise(given), salt, want.length,
                             { N: Number(N), r: Number(r), p: Number(p),
                               maxmem: 64 * 1024 * 1024 });
    return crypto.timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

/* Issue a family a passcode, returning the plaintext ONCE — this is the only
   moment it exists anywhere outside the head of whoever is given it.

   Raising passcode_gen is what ends the old sessions: they carry the
   generation they were opened under and stop matching. That is arithmetic
   rather than a DELETE across a large table, so it cannot half-finish and
   cannot leave one instance still honouring a session another has revoked. */
async function issuePasscode(pool, treeId, { by = '' } = {}) {
  const { rows } = await pool.query('SELECT id, handle FROM trees WHERE id = $1', [treeId]);
  if (!rows.length) return null;

  const passcode = makePasscode(rows[0].handle);
  const hash = await hashPasscode(passcode);

  const { rows: saved } = await pool.query(
    `UPDATE trees
        SET passcode_hash = $2,
            passcode_set_at = clock_timestamp(),
            passcode_set_by = $3,
            passcode_gen = passcode_gen + 1
      WHERE id = $1
      RETURNING id, name, handle, passcode_gen, passcode_set_at`,
    [treeId, hash, String(by || '').slice(0, 120)]);

  return { ...saved[0], passcode };
}

// ── sessions ───────────────────────────────────────────────────────────────

/* Sessions are read on every single request, so they are cached in this
   process for a few seconds. The window is short on purpose: a revoked
   session must actually stop working, and with more than one instance running
   the cache is the only thing standing between "revoked" and "revoked
   everywhere". Fifteen seconds is the most staleness worth trading for not
   reading the table on every image request. */
const CACHE_MS = 15_000;
const cache = new Map();

function cacheDrop(id) { cache.delete(id); }

/* Forget what is cached about a family, so that closing or reopening one takes
   effect on the sessions already open rather than in fifteen seconds' time.

   Scanning rather than indexing by family: the cache only ever holds sessions
   seen in the last fifteen seconds, so it is small, and this runs on an
   admin's deliberate act rather than on a request. With more than one instance
   running, the others still carry their own copy for up to the cache window —
   that is the staleness this cache buys speed with, and it is bounded. */
function forgetTree(treeId) {
  if (!treeId) { cache.clear(); return; }
  // The family is on the ENTRY, not on the session inside it, because a
  // session that failed its check is cached as a negative — and a negative
  // cached while a family was closed is exactly what would otherwise keep them
  // locked out for fifteen seconds after being let back in.
  for (const [id, entry] of cache) {
    if (entry.treeId === treeId) cache.delete(id);
  }
}

/* Open a session and return the cookie value. The token is generated here,
   hashed on the way into the table, and never stored or logged in full. */
async function createSession(pool, {
  scope, treeId = null, via = '', inviteId = null, actor = '',
  ip = null, userAgent = '', passcodeGen = 0, days = SESSION_DAYS
} = {}) {
  const raw = token();
  const { rows } = await pool.query(
    `INSERT INTO sessions
       (token_hash, scope, tree_id, passcode_gen, via, invite_id, actor,
        expires_at, created_ip, last_ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7,
             clock_timestamp() + ($8 || ' days')::interval, $9::text::inet,
             $9::text::inet, $10)
     RETURNING id, scope, tree_id, expires_at`,
    [sha256(raw).toString('hex'), scope, treeId, passcodeGen, via, inviteId,
     String(actor || '').slice(0, 120), String(days), ip,
     String(userAgent || '').slice(0, 400)]);

  return { ...rows[0], cookie: `${rows[0].id}.${raw}` };
}

/* Resolve a cookie to a session, or null.

   Every reason for null is the same to the caller — expired, revoked, forged,
   a family suspended, a passcode reset since. Distinguishing them at this
   level would mean the difference showing up in a response, and "that session
   id exists but the token is wrong" is a sentence worth nobody hearing. */
async function readSession(pool, cookieValue) {
  if (!pool || typeof cookieValue !== 'string') return null;
  const dot = cookieValue.indexOf('.');
  if (dot < 1) return null;
  const id = cookieValue.slice(0, dot);
  const raw = cookieValue.slice(dot + 1);
  if (!/^[0-9a-f-]{36}$/i.test(id) || !raw) return null;

  const hit = cache.get(id);
  if (hit && hit.until > Date.now()) {
    return hit.session && sameToken(raw, hit.tokenHash) ? hit.session : null;
  }

  let row;
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.token_hash, s.scope, s.tree_id, s.passcode_gen, s.via,
              s.actor, s.expires_at, s.revoked_at,
              t.name AS tree_name, t.handle, t.passcode_gen AS tree_gen,
              t.suspended_at
         FROM sessions s
         LEFT JOIN trees t ON t.id = s.tree_id
        WHERE s.id = $1`, [id]);
    row = rows[0];
  } catch {
    return null;
  }
  if (!row) { cache.set(id, { until: Date.now() + CACHE_MS, session: null, tokenHash: '' }); return null; }

  const live =
    !row.revoked_at &&
    new Date(row.expires_at).getTime() > Date.now() &&
    // A family session opened before the family's passcode was reset is over.
    (row.scope !== 'family' || row.passcode_gen === row.tree_gen) &&
    // A suspended family's sessions stop working without being deleted, so
    // restoring the family restores them too.
    (row.scope !== 'family' || !row.suspended_at);

  const session = live ? {
    id: row.id, scope: row.scope, treeId: row.tree_id, via: row.via,
    actor: row.actor, treeName: row.tree_name, handle: row.handle,
    expiresAt: row.expires_at
  } : null;

  cache.set(id, { until: Date.now() + CACHE_MS, session, tokenHash: row.token_hash,
                  treeId: row.tree_id });
  return session && sameToken(raw, row.token_hash) ? session : null;
}

function sameToken(raw, storedHex) {
  try {
    const want = Buffer.from(String(storedHex), 'hex');
    if (want.length !== 32) return false;
    return crypto.timingSafeEqual(sha256(raw), want);
  } catch { return false; }
}

/* last_seen is what makes "who is here now" answerable, but writing it on
   every request would mean an UPDATE per image, per poll, per keystroke's
   worth of sync. Once every five minutes per session says the same thing at
   a thousandth of the cost. */
const SEEN_MS = 5 * 60 * 1000;
const seen = new Map();

async function touch(pool, sessionId, { ip = null } = {}) {
  const last = seen.get(sessionId) || 0;
  if (Date.now() - last < SEEN_MS) return;
  seen.set(sessionId, Date.now());
  if (seen.size > 20_000) {
    for (const [k, v] of seen) if (Date.now() - v > SEEN_MS) seen.delete(k);
  }
  try {
    await pool.query(
      `UPDATE sessions SET last_seen_at = clock_timestamp(), last_ip = $2::text::inet
        WHERE id = $1`, [sessionId, ip]);
  } catch { /* a missed heartbeat is not worth failing a request over */ }
}

async function revokeSession(pool, sessionId, by = '') {
  const { rows } = await pool.query(
    `UPDATE sessions SET revoked_at = clock_timestamp(), revoked_by = $2
      WHERE id = $1 AND revoked_at IS NULL
      RETURNING id, scope, tree_id`, [sessionId, String(by || '').slice(0, 120)]);
  cacheDrop(sessionId);
  return rows[0] || null;
}

async function revokeTreeSessions(pool, treeId, by = '') {
  const { rows } = await pool.query(
    `UPDATE sessions SET revoked_at = clock_timestamp(), revoked_by = $2
      WHERE tree_id = $1 AND revoked_at IS NULL
      RETURNING id`, [treeId, String(by || '').slice(0, 120)]);
  for (const r of rows) cacheDrop(r.id);
  return rows.length;
}

/* Everyone currently signed in. `stale` includes sessions that have ended, for
   the admin looking at what happened rather than what is happening. */
async function liveSessions(pool, { treeId = null, scope = null, limit = 100, stale = false } = {}) {
  const args = [];
  const where = [];
  if (!stale) where.push('s.revoked_at IS NULL AND s.expires_at > clock_timestamp()');
  if (treeId) { args.push(treeId); where.push(`s.tree_id = $${args.length}::uuid`); }
  if (scope) { args.push(scope); where.push(`s.scope = $${args.length}`); }
  args.push(Math.max(1, Math.min(500, Number(limit) || 100)));

  const { rows } = await pool.query(
    `SELECT s.id, s.scope, s.tree_id, s.via, s.actor, s.created_at, s.expires_at,
            s.last_seen_at, s.revoked_at, s.user_agent,
            host(s.created_ip) AS created_ip, host(s.last_ip) AS last_ip,
            t.name AS tree_name, t.handle
       FROM sessions s
       LEFT JOIN trees t ON t.id = s.tree_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY s.last_seen_at DESC
      LIMIT $${args.length}`, args);
  return rows;
}

/* Sessions that ended a long time ago are of no use to anybody: the audit
   table is the history, this one is the live state. Not called automatically —
   see mw_drop_audit_before for the same reasoning about retention. */
async function purgeSessions(pool, { olderThanDays = 90 } = {}) {
  const { rowCount } = await pool.query(
    `DELETE FROM sessions
      WHERE expires_at < clock_timestamp() - ($1 || ' days')::interval`,
    [String(Number(olderThanDays) || 90)]);
  cache.clear();
  return rowCount;
}

// ── signing in ─────────────────────────────────────────────────────────────

/* Check a passcode and open a session if it is right.

   Returns a reason rather than throwing, because the caller has to record
   every outcome and show the same words for most of them. The reasons are for
   the audit log, NOT for the person at the door: 'no_family' and 'wrong' must
   look identical from outside, or the handle half of the passcode becomes a
   way of finding out which families exist. */
async function signIn(pool, given, { ip = null, userAgent = '', actor = '' } = {}) {
  const parts = splitPasscode(given);
  if (!parts) return { ok: false, reason: 'malformed' };

  const { rows } = await pool.query(
    `SELECT id, name, handle, passcode_hash, passcode_gen, suspended_at, suspended_reason
       FROM trees WHERE handle = $1`, [parts.handle]);

  if (!rows.length || !rows[0].passcode_hash) {
    // Spend the time anyway. Returning immediately for an unknown handle makes
    // the response time itself say "no family here", which is the enumeration
    // this is meant to prevent.
    await checkPasscode(parts.passcode, await decoyHash());
    return { ok: false, reason: 'no_family' };
  }

  const tree = rows[0];
  if (!await checkPasscode(parts.passcode, tree.passcode_hash)) {
    return { ok: false, reason: 'wrong', treeId: tree.id };
  }
  if (tree.suspended_at) {
    return { ok: false, reason: 'suspended', treeId: tree.id,
             suspendedReason: tree.suspended_reason };
  }

  const session = await createSession(pool, {
    scope: 'family', treeId: tree.id, via: 'passcode',
    passcodeGen: tree.passcode_gen, actor, ip, userAgent
  });
  return { ok: true, treeId: tree.id, treeName: tree.name, handle: tree.handle, session };
}

/* A hash to check against when there is no family, so that a wrong handle
   costs the same time as a wrong secret. Computed once per process. */
let decoy = null;
async function decoyHash() {
  if (!decoy) decoy = await hashPasscode(code(20));
  return decoy;
}

// ── invitations ────────────────────────────────────────────────────────────

/* Make a link that lets a relative in without handing over the passcode.

   Single-use and two weeks by default. Both are arguable, and both are the
   safer arguable answer: an invitation that never expires is a passcode with
   extra steps, and one that can be used any number of times is one that can be
   forwarded any number of times. A family that wants a link for the whole
   WhatsApp group can say so with uses. */
async function createInvite(pool, treeId, {
  by = '', note = '', days = INVITE_DAYS, uses = 1
} = {}) {
  const raw = token();
  const { rows } = await pool.query(
    `INSERT INTO invites (tree_id, token_hash, created_by, note, expires_at, max_uses)
     VALUES ($1, $2, $3, $4, clock_timestamp() + ($5 || ' days')::interval, $6)
     RETURNING id, tree_id, created_at, expires_at, max_uses, uses, note`,
    [treeId, sha256(raw).toString('hex'), String(by || '').slice(0, 120),
     String(note || '').slice(0, 200), String(Math.max(1, Math.min(365, Number(days) || INVITE_DAYS))),
     Math.max(1, Math.min(500, Number(uses) || 1))]);
  // The token is returned once and never again — same rule as the passcode.
  return { ...rows[0], token: raw };
}

/* Take up an invitation. The whole check-and-consume is one statement so that
   two relatives opening the same single-use link at the same moment cannot
   both get in: the UPDATE's WHERE is the check, and only one of them can
   match it. */
async function acceptInvite(pool, rawToken, { ip = null, userAgent = '', actor = '' } = {}) {
  if (!rawToken) return { ok: false, reason: 'malformed' };

  const { rows } = await pool.query(
    `UPDATE invites
        SET uses = uses + 1
      WHERE token_hash = $1
        AND revoked_at IS NULL
        AND expires_at > clock_timestamp()
        AND uses < max_uses
      RETURNING id, tree_id`,
    [sha256(rawToken).toString('hex')]);

  if (!rows.length) return { ok: false, reason: 'not_usable' };

  const { rows: trees } = await pool.query(
    `SELECT id, name, handle, passcode_gen, suspended_at FROM trees WHERE id = $1`,
    [rows[0].tree_id]);
  if (!trees.length) return { ok: false, reason: 'not_usable' };
  if (trees[0].suspended_at) {
    return { ok: false, reason: 'suspended', treeId: trees[0].id };
  }

  const session = await createSession(pool, {
    scope: 'family', treeId: trees[0].id, via: 'invite', inviteId: rows[0].id,
    passcodeGen: trees[0].passcode_gen, actor, ip, userAgent
  });
  return { ok: true, inviteId: rows[0].id, treeId: trees[0].id,
           treeName: trees[0].name, handle: trees[0].handle, session };
}

async function listInvites(pool, treeId, { limit = 50 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, created_by, created_at, expires_at, max_uses, uses, note,
            revoked_at, revoked_by,
            (revoked_at IS NULL AND expires_at > clock_timestamp() AND uses < max_uses)
              AS usable
       FROM invites WHERE tree_id = $1
      ORDER BY created_at DESC LIMIT $2`,
    [treeId, Math.max(1, Math.min(200, Number(limit) || 50))]);
  return rows;
}

async function revokeInvite(pool, inviteId, { treeId = null, by = '' } = {}) {
  const args = [inviteId, String(by || '').slice(0, 120)];
  let scope = '';
  if (treeId) { args.push(treeId); scope = ` AND tree_id = $${args.length}::uuid`; }
  const { rows } = await pool.query(
    `UPDATE invites SET revoked_at = clock_timestamp(), revoked_by = $2
      WHERE id = $1 AND revoked_at IS NULL${scope}
      RETURNING id, tree_id`, args);
  return rows[0] || null;
}

module.exports = {
  SESSION_DAYS, INVITE_DAYS,
  makePasscode, splitPasscode, hashPasscode, checkPasscode, issuePasscode,
  createSession, readSession, touch, revokeSession, revokeTreeSessions, forgetTree,
  liveSessions, purgeSessions, signIn,
  createInvite, acceptInvite, listInvites, revokeInvite,
  // exported for tests only
  _internals: { code, token, sha256, normalise, ALPHABET }
};
