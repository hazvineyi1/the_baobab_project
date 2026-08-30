// Appeals — the way somebody inside the app reaches the person who runs it.
//
// Two things bring people here and they are not the same size:
//
//   'passcode'  we have lost our way in. Issue us another.
//   'erasure'   somebody set my grandmother aside and I do not agree.
//   'access'    we cannot get in and do not know why.
//   'other'     everything else.
//
// The erasure case is the older promise in this project finally given
// somewhere to go. Nothing in the tree is ever deleted; it is set aside, with
// a reason, and the person who recorded it is told. Being told is not the same
// as being heard, and until now there was nothing after it.
//
// AN APPEAL IS RAISED FROM INSIDE A SESSION, so it carries which family it
// came from without anybody having to type it, and a stranger cannot fill the
// admin's queue from outside the gate.

const OPEN = 'open';

const KINDS = new Set(['passcode', 'erasure', 'access', 'other']);

/* Raise one.

   tree_label and person_name are copied in as text on purpose. The foreign key
   is SET NULL on a family being removed, and an appeal that has forgotten who
   it was about is not much of a record — least of all the appeals that are
   about a family disappearing. */
async function raise(pool, {
  treeId = null, treeLabel = '', kind = 'other', personId = null, personName = '',
  body = '', contact = '', by = '', ip = null
} = {}) {
  const text = String(body || '').trim();
  if (!text) {
    const e = new Error('An appeal needs to say something.');
    e.status = 400; e.code = 'empty_appeal';
    throw e;
  }
  const k = KINDS.has(kind) ? kind : 'other';

  const { rows } = await pool.query(
    `INSERT INTO appeals
       (tree_id, tree_label, kind, person_id, person_name, body, contact,
        raised_by, raised_ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text::inet)
     RETURNING id, tree_id, kind, status, raised_at`,
    [treeId, String(treeLabel || '').slice(0, 200), k, personId,
     String(personName || '').slice(0, 200), text.slice(0, 4000),
     String(contact || '').slice(0, 200), String(by || '').slice(0, 120), ip]);
  return rows[0];
}

/* The admin's queue. Open ones oldest-first by default, because an appeal
   that has been waiting longest is the one to answer next — the opposite of
   every other feed in this project. */
async function list(pool, { status = OPEN, treeId = null, kind = null, limit = 100 } = {}) {
  const args = [];
  const where = [];
  if (status && status !== 'all') { args.push(status); where.push(`status = $${args.length}`); }
  if (treeId) { args.push(treeId); where.push(`tree_id = $${args.length}::uuid`); }
  if (kind) { args.push(kind); where.push(`kind = $${args.length}`); }
  args.push(Math.max(1, Math.min(500, Number(limit) || 100)));

  const { rows } = await pool.query(
    `SELECT id, tree_id, tree_label, kind, person_id, person_name, body, contact,
            raised_by, raised_at, host(raised_ip) AS raised_ip,
            status, answer, answered_by, answered_at
       FROM appeals
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY (status = 'open') DESC, raised_at ASC
      LIMIT $${args.length}`, args);
  return rows;
}

async function get(pool, id) {
  const { rows } = await pool.query(
    `SELECT id, tree_id, tree_label, kind, person_id, person_name, body, contact,
            raised_by, raised_at, host(raised_ip) AS raised_ip,
            status, answer, answered_by, answered_at
       FROM appeals WHERE id = $1`, [id]);
  return rows[0] || null;
}

/* Answer or close one. An answer is kept even when the appeal is closed
   without one, so that "closed, and this is why" is representable. */
async function resolve(pool, id, { answer = '', status = 'answered', by = '' } = {}) {
  const next = status === 'closed' ? 'closed' : 'answered';
  const { rows } = await pool.query(
    `UPDATE appeals
        SET answer = $2, status = $3, answered_by = $4, answered_at = clock_timestamp()
      WHERE id = $1
      RETURNING id, tree_id, kind, status, answered_at`,
    [id, String(answer || '').slice(0, 4000), next, String(by || '').slice(0, 120)]);
  return rows[0] || null;
}

/* What a family can see of its own appeals: the fact of them and the answer.
   Never another family's, and never the address it was raised from. */
async function mine(pool, treeId, { limit = 50 } = {}) {
  const { rows } = await pool.query(
    `SELECT id, kind, person_name, body, raised_by, raised_at,
            status, answer, answered_at
       FROM appeals WHERE tree_id = $1
      ORDER BY raised_at DESC LIMIT $2`,
    [treeId, Math.max(1, Math.min(200, Number(limit) || 50))]);
  return rows;
}

async function openCount(pool) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM appeals WHERE status = 'open'`);
  return rows[0].n;
}

module.exports = { raise, list, get, resolve, mine, openCount, KINDS };
