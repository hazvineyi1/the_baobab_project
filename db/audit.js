// The record of what happened: who, when, where, what.
//
// Every sign-in, every failed attempt, every invitation made or taken up,
// every passcode reset, every batch of edits. One row each, in a table
// partitioned by month so that a deployment which has been running for years
// still answers "what happened this week" by reading this week.
//
// TWO THINGS THIS DELIBERATELY DOES NOT DO.
//
// It does not look up where an address is in the world. That would mean
// sending a family's IP address to somebody else's service on every event —
// a worse privacy trade than the answer is worth, and one the families never
// agreed to. The address is recorded; interpreting it is left to whoever is
// reading, who can do it deliberately and out of band.
//
// It does not record what was typed. `tree.ops` says a batch of eleven edits
// arrived and names the kinds; the `changes` table already holds the detail
// of every edit, with the same timestamps, and duplicating it here would mean
// two records of the same act that can disagree.
//
// RECORDING MUST NEVER BREAK THE THING IT IS RECORDING. Every call here
// swallows its own errors: a family must not be unable to sign in because the
// audit table is full, locked, or missing. A failure to record is logged to
// the console and otherwise ignored.

const KINDS = Object.freeze([
  'gate.ok',            // signed in
  'gate.fail',          // wrong passcode
  'gate.locked',        // too many attempts, refused without checking
  'gate.suspended',     // right passcode, family closed by the admin
  'session.revoked',
  'session.expired',
  'invite.created',
  'invite.accepted',
  'invite.rejected',    // expired, used up, revoked, or never existed
  'invite.revoked',
  'passcode.set',       // first issue
  'passcode.reset',     // admin issued a new one; old sessions ended
  'family.created',
  'family.suspended',
  'family.restored',
  'family.key_rotated',
  'appeal.raised',
  'appeal.answered',
  'appeal.closed',
  'tree.ops',           // a batch of edits; see `changes` for what they were
  'admin.read'          // an admin looked at something
]);

/* The address the request came from.

   Behind Railway's proxy the socket address is the proxy, so the client is the
   first entry in x-forwarded-for. Express's own req.ip does this too when
   trust proxy is set, and is preferred where it is available; this falls back
   to reading the header for the tests, which call the handlers directly. */
function clientIp(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const raw = forwarded || req?.ip || req?.socket?.remoteAddress || '';
  return normaliseIp(raw);
}

/* Postgres INET will reject anything that is not an address, and an INSERT
   that throws is a sign-in that fails — so anything doubtful becomes NULL
   rather than being passed through and risking that. */
function normaliseIp(raw) {
  let s = String(raw || '').trim();
  if (!s) return null;
  // Node reports IPv4 over an IPv6 socket as ::ffff:1.2.3.4.
  if (s.startsWith('::ffff:') && s.includes('.')) s = s.slice(7);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    return s.split('.').every(n => Number(n) <= 255) ? s : null;
  }
  // Deliberately permissive on IPv6 shapes and strict about what can be in
  // them: hex, colons, and a trailing IPv4 form.
  if (/^[0-9a-fA-F:]+(\.\d{1,3}){0,3}$/.test(s) && s.includes(':')) return s;
  return null;
}

const uaOf = req => String(req?.headers?.['user-agent'] || '').slice(0, 400);

/* Write one line. Never throws, never blocks the caller on a failure. */
async function record(pool, event = {}) {
  if (!pool) return null;
  const {
    kind, ok = null, treeId = null, sessionId = null, actor = '',
    ip = null, userAgent = '', method = '', path = '', detail = {}
  } = event;

  if (!kind) return null;

  try {
    const { rows } = await pool.query(
      `INSERT INTO audit_events
         (kind, ok, tree_id, session_id, actor, ip, user_agent, method, path, detail)
       VALUES ($1, $2, $3, $4, $5, $6::text::inet, $7, $8, $9, $10::jsonb)
       RETURNING id, at`,
      [String(kind).slice(0, 60), ok, treeId, sessionId, String(actor || '').slice(0, 120),
       normaliseIp(ip), String(userAgent || '').slice(0, 400),
       String(method || '').slice(0, 10), String(path || '').slice(0, 300),
       JSON.stringify(detail || {})]
    );
    return rows[0];
  } catch (e) {
    // Deliberately not rethrown. See the header.
    console.error('audit: could not record', kind, e.message);
    return null;
  }
}

/* Take the request apart once, so callers do not each have to remember which
   header the address is in. */
function from(req, event = {}) {
  return {
    ip: clientIp(req),
    userAgent: uaOf(req),
    method: req?.method || '',
    path: req?.path || req?.originalUrl || '',
    ...event
  };
}

/* The activity feed.

   KEYSET pagination, not OFFSET. At a million rows OFFSET 900000 makes the
   database walk nine hundred thousand rows it will then discard, and it gets
   slower the further back you look — on a table whose whole purpose is to be
   looked back through. A cursor of (at, id) is a seek, and costs the same on
   page one and page nine thousand. */
async function events(pool, {
  treeId = null, kind = null, actor = null, ip = null,
  since = null, until = null, cursor = null, limit = 100
} = {}) {
  const where = [];
  const args = [];
  const add = (sql, value) => { args.push(value); where.push(sql.replace('?', '$' + args.length)); };

  if (treeId) add('tree_id = ?::uuid', treeId);
  // 'gate' matches gate.ok, gate.fail and gate.locked; 'gate.ok' matches only
  // itself. One placeholder used twice, so `add` cannot do it.
  if (kind) {
    args.push(String(kind));
    where.push(`(kind = $${args.length} OR kind LIKE $${args.length} || '.%')`);
  }
  if (actor) add('actor = ?', actor);
  if (ip) add('ip = ?::text::inet', normaliseIp(ip));
  if (since) add('at >= ?::timestamptz', since);
  if (until) add('at <= ?::timestamptz', until);

  // The cursor is the last row of the previous page: keep going from strictly
  // before it, in the same order the index is in.
  if (cursor && cursor.at && cursor.id != null) {
    args.push(cursor.at, String(cursor.id));
    where.push(`(at, id) < ($${args.length - 1}::timestamptz, $${args.length}::bigint)`);
  }

  const n = Math.max(1, Math.min(500, Number(limit) || 100));
  args.push(n + 1);                       // one extra: is there another page?

  const { rows } = await pool.query(
    `SELECT id::text, at, kind, ok, tree_id, session_id, actor,
            host(ip) AS ip, user_agent, method, path, detail
       FROM audit_events
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY at DESC, id DESC
      LIMIT $${args.length}`, args);

  const more = rows.length > n;
  const page = more ? rows.slice(0, n) : rows;
  return {
    events: page,
    // Hand back the cursor rather than making the caller construct it.
    next: more && page.length
      ? { at: page[page.length - 1].at, id: page[page.length - 1].id }
      : null
  };
}

/* Make sure this month and next month have partitions of their own.
   Called at boot. Cheap, idempotent, and never fatal — the default partition
   means a failure here costs query speed, not data. */
async function ensurePartitions(pool, log = console.log) {
  if (!pool) return;
  try {
    await pool.query(
      `SELECT mw_ensure_audit_partition(clock_timestamp()),
              mw_ensure_audit_partition(clock_timestamp() + INTERVAL '1 month'),
              mw_ensure_audit_partition(clock_timestamp() + INTERVAL '2 months')`);
  } catch (e) {
    log('audit: could not prepare partitions (the default will take the rows): ' + e.message);
  }
}

module.exports = { record, from, events, ensurePartitions, clientIp, normaliseIp, uaOf, KINDS };
