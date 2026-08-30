// What the admin can see and do.
//
// Everything here is a read or a deliberate act on a family's ACCESS — issue a
// new passcode, close a family, end a session, answer an appeal. Nothing here
// edits anybody's tree. That line is drawn on purpose and it is the difference
// between an administrator and an owner: the admin can decide who may open a
// family's records and can never decide what those records say.
//
// COUNTING AT SCALE, which is the whole reason this file is not four inline
// queries in the route. `SELECT count(*)` reads every row, and a dashboard
// that opens with four of them against a table of millions is a dashboard
// nobody opens twice. Small tables are counted exactly because it is cheap and
// exact is better; large ones are estimated from the statistics the planner
// already keeps, and the answer says which it gave rather than presenting a
// guess as a fact.

const EXACT_UNDER = 50_000;

/* Estimated row count from pg_class, which ANALYZE and autovacuum maintain
   anyway. -1 means the table has never been analysed, in which case there is
   no estimate to give and the caller falls back to counting. */
async function estimate(pool, table) {
  const { rows } = await pool.query(
    `SELECT c.reltuples::bigint AS n
       FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE c.relname = $1 AND ns.nspname = current_schema()`, [table]);
  if (!rows.length) return null;
  const n = Number(rows[0].n);
  return n < 0 ? null : n;
}

/* Exact when that is affordable, estimated when it is not, and honest about
   which. `where` is trusted SQL from this file only — never anything that
   arrived on a request. */
async function countOf(pool, table, where = '') {
  const guess = await estimate(pool, table);
  if (guess === null || guess < EXACT_UNDER || where) {
    const { rows } = await pool.query(
      `SELECT count(*)::bigint AS n FROM ${table} ${where ? 'WHERE ' + where : ''}`);
    return { n: Number(rows[0].n), exact: true };
  }
  return { n: guess, exact: false };
}

/* The numbers across the top of the dashboard. */
async function overview(pool) {
  const [families, people, unions, openAppeals] = await Promise.all([
    countOf(pool, 'trees'),
    countOf(pool, 'people'),
    countOf(pool, 'unions'),
    pool.query(`SELECT count(*)::int AS n FROM appeals WHERE status = 'open'`)
  ]);

  const { rows: live } = await pool.query(
    `SELECT count(*)::int AS sessions,
            count(*) FILTER (WHERE scope = 'admin')::int AS admin_sessions,
            count(DISTINCT tree_id)::int AS families_here
       FROM sessions
      WHERE revoked_at IS NULL AND expires_at > clock_timestamp()`);

  const { rows: flags } = await pool.query(
    `SELECT count(*) FILTER (WHERE suspended_at IS NOT NULL)::int AS suspended,
            count(*) FILTER (WHERE passcode_hash IS NULL)::int AS without_passcode
       FROM trees`);

  // Only ever the recent slice, which with monthly partitions is one small
  // table rather than the whole history.
  const { rows: recent } = await pool.query(
    `SELECT count(*)::int AS events_24h,
            count(*) FILTER (WHERE kind = 'gate.fail')::int AS failed_24h,
            count(*) FILTER (WHERE kind = 'gate.ok')::int AS signins_24h
       FROM audit_events
      WHERE at > clock_timestamp() - INTERVAL '24 hours'`);

  return {
    families, people, unions,
    openAppeals: openAppeals.rows[0].n,
    ...live[0], ...flags[0], ...recent[0]
  };
}

/* The families list.

   Keyset paginated on (created_at, id), not OFFSET, for the same reason the
   audit feed is: page nine thousand must cost what page one costs. The
   per-family people count is computed for the page only — twenty-five
   subqueries, not one per family in the database. */
async function families(pool, { q = '', cursor = null, limit = 25, filter = '' } = {}) {
  const args = [];
  const where = [];

  if (q) {
    args.push(String(q).trim());
    // Name, handle, or the sharing key — whichever of them the admin has been
    // given by somebody who cannot get in.
    where.push(`(t.name ILIKE '%' || $${args.length} || '%'
                 OR t.handle = lower($${args.length})
                 OR t.key = lower($${args.length}))`);
  }
  if (filter === 'suspended') where.push('t.suspended_at IS NOT NULL');
  if (filter === 'no_passcode') where.push('t.passcode_hash IS NULL');

  if (cursor && cursor.created_at && cursor.id) {
    args.push(cursor.created_at, cursor.id);
    where.push(`(t.created_at, t.id) < ($${args.length - 1}::timestamptz, $${args.length}::uuid)`);
  }

  const n = Math.max(1, Math.min(200, Number(limit) || 25));
  args.push(n + 1);

  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.handle, t.created_at, t.created_by,
            t.passcode_set_at, t.passcode_set_by, t.passcode_gen,
            (t.passcode_hash IS NOT NULL) AS has_passcode,
            t.suspended_at, t.suspended_by, t.suspended_reason,
            (SELECT count(*)::int FROM people p
              WHERE p.tree_id = t.id AND p.aside_at IS NULL) AS people,
            (SELECT max(at) FROM changes c WHERE c.tree_id = t.id) AS last_edit,
            (SELECT count(*)::int FROM sessions s
              WHERE s.tree_id = t.id AND s.revoked_at IS NULL
                AND s.expires_at > clock_timestamp()) AS live_sessions
       FROM trees t
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT $${args.length}`, args);

  const more = rows.length > n;
  const page = more ? rows.slice(0, n) : rows;
  return {
    families: page,
    next: more && page.length
      ? { created_at: page[page.length - 1].created_at, id: page[page.length - 1].id }
      : null
  };
}

/* One family, in full — everything the admin needs on the call where somebody
   says "we cannot get in". Never the passcode, because it is not stored. */
async function family(pool, treeId) {
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.handle, t.key, t.key_set_at, t.created_at, t.created_by,
            t.passcode_set_at, t.passcode_set_by, t.passcode_gen,
            (t.passcode_hash IS NOT NULL) AS has_passcode,
            t.suspended_at, t.suspended_by, t.suspended_reason
       FROM trees t WHERE t.id = $1`, [treeId]);
  if (!rows.length) return null;

  const { rows: counts } = await pool.query(
    `SELECT count(*)::int AS people,
            count(*) FILTER (WHERE aside_at IS NOT NULL)::int AS set_aside,
            count(*) FILTER (WHERE is_root)::int AS roots
       FROM people WHERE tree_id = $1`, [treeId]);

  const { rows: edits } = await pool.query(
    `SELECT count(*)::int AS changes, max(at) AS last_edit, min(at) AS first_edit
       FROM changes WHERE tree_id = $1`, [treeId]);

  // Who has been editing, by their own account of who they are. Self-claimed,
  // like every other actor in this project, and shown as such.
  const { rows: hands } = await pool.query(
    `SELECT by AS actor, count(*)::int AS changes, max(at) AS last_edit
       FROM changes WHERE tree_id = $1 AND by <> ''
      GROUP BY by ORDER BY count(*) DESC LIMIT 20`, [treeId]);

  return { ...rows[0], ...counts[0], ...edits[0], hands };
}

/* Close a family, without touching one record of theirs.

   Suspension is a door, not a bonfire: sessions stop working, the passcode
   stops opening it, and everything they have entered is exactly where they
   left it. Restoring puts it all back, unexpired sessions included — which is
   why this sets a flag rather than revoking them. */
async function suspend(pool, treeId, { reason = '', by = '' } = {}) {
  const { rows } = await pool.query(
    `UPDATE trees
        SET suspended_at = clock_timestamp(), suspended_by = $2, suspended_reason = $3
      WHERE id = $1 AND suspended_at IS NULL
      RETURNING id, name, handle, suspended_at, suspended_reason`,
    [treeId, String(by || '').slice(0, 120), String(reason || '').slice(0, 500)]);
  return rows[0] || null;
}

async function restore(pool, treeId, { by = '' } = {}) {
  const { rows } = await pool.query(
    `UPDATE trees
        SET suspended_at = NULL, suspended_by = $2, suspended_reason = ''
      WHERE id = $1 AND suspended_at IS NOT NULL
      RETURNING id, name, handle`,
    [treeId, String(by || '').slice(0, 120)]);
  return rows[0] || null;
}

/* How much of the database each part is actually using, largest first. The
   answer to "is this deployment about to become expensive", and the one place
   the partitioned audit table shows its shape. */
async function storage(pool) {
  const { rows } = await pool.query(
    `SELECT c.relname AS table,
            pg_total_relation_size(c.oid) AS bytes,
            pg_size_pretty(pg_total_relation_size(c.oid)) AS size,
            c.reltuples::bigint AS approx_rows
       FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = current_schema() AND c.relkind IN ('r', 'p')
      ORDER BY pg_total_relation_size(c.oid) DESC
      LIMIT 25`);
  return rows;
}

/* Sign-ins and edits per day, for the shape of the thing rather than the
   detail. Bounded to a window so it stays a partition scan.

   EVERY DAY IN THE WINDOW COMES BACK, including the quiet ones. A plain GROUP
   BY returns only days that had something, and a chart drawn from that puts
   fourteen days' worth of bars in three slots and labels the axis with the
   first and last — which reads as "these three days" and is a lie. The quiet
   days are the shape too: a deployment nobody signed into for a week is
   exactly what somebody looking at this needs to see. */
async function activity(pool, { days = 14 } = {}) {
  const n = Math.max(1, Math.min(90, Number(days) || 14));
  const { rows } = await pool.query(
    `WITH span AS (
       SELECT generate_series(
                date_trunc('day', clock_timestamp()) - (($1::int - 1) || ' days')::interval,
                date_trunc('day', clock_timestamp()),
                interval '1 day') AS day
     )
     SELECT span.day,
            count(e.*) FILTER (WHERE e.kind = 'gate.ok')::int   AS signins,
            count(e.*) FILTER (WHERE e.kind = 'gate.fail')::int AS failures,
            count(e.*) FILTER (WHERE e.kind = 'tree.ops')::int  AS edits,
            count(e.*)::int                                     AS events
       FROM span
       LEFT JOIN audit_events e
         ON e.at >= span.day AND e.at < span.day + interval '1 day'
      GROUP BY span.day ORDER BY span.day`, [String(n)]);
  return rows;
}

module.exports = { overview, families, family, suspend, restore, storage, activity,
                   countOf, estimate };
