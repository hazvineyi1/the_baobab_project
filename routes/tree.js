// HTTP surface for the relational tree.
//
// Mounted alongside the old /api/shared blob API, which keeps working until
// the data has actually been moved across.

const express = require('express');
const { applyOps } = require('../db/ops');
const { bootstrap, fullTree, changesSince, search, setAsideList } = require('../db/reads');
const { findDuplicates } = require('../db/duplicates');
const { findRelatives, linksFor } = require('../db/crosstree');
const { OpError } = require('../db/errors');

function sendError(res, e) {
  if (e instanceof OpError) {
    return res.status(e.status).json({
      error: e.code,
      message: e.message,
      ...e.details,
      // A 409 carries the current state so the client can merge rather than
      // clobber. This is the whole reason a stale write is reported instead of
      // being silently applied.
      ...(e.current ? { current: e.current } : {})
    });
  }
  // Constraint violations are the database enforcing a rule the caller broke,
  // not the server falling over. Report them as such — in particular the
  // one-set-of-parents primary key, which a racing client can still trip even
  // though applyOps checks for it first.
  const PG = {
    '22P02': [400, 'bad_request', 'That is not a valid id'],
    '23505': [409, 'conflict',    'That link already exists'],
    '23503': [400, 'bad_request', 'That refers to somebody who is not in this tree'],
    '23514': [400, 'bad_request', 'That value is not allowed']
  };
  if (PG[e.code]) {
    const [status, code, message] = PG[e.code];
    return res.status(status).json({ error: code, message, detail: e.detail || e.message });
  }
  console.error('unhandled', e);
  return res.status(500).json({ error: 'internal', message: 'something went wrong' });
}

// Who made a change. Purely for the changes log's `by` column — it is not
// identity and grants nothing. Real access control is the passphrase gate.
const actorOf = req => String(req.get('x-muti-actor') || req.body?.by || '').slice(0, 120);

module.exports = function treeRoutes(pool, homeTreeId = null) {
  const r = express.Router();

  /* Which tree this deployment serves, so the page does not have to be
     configured with a UUID. Settled once at boot. */
  r.get('/home', async (req, res) => {
    if (!homeTreeId) {
      return res.status(503).json({
        error: 'no_tree', message: 'the server has not finished choosing a tree' });
    }
    try {
      // The home family's own key travels with it, so the first person to open
      // the deployment has a link to share without having to go and find one.
      const { rows } = await pool.query(
        'SELECT id, key, name FROM trees WHERE id = $1', [homeTreeId]);
      res.json(rows.length ? { treeId: rows[0].id, key: rows[0].key, name: rows[0].name }
                           : { treeId: homeTreeId });
    } catch (e) { sendError(res, e); }
  });

  /* The whole tree, plus the change-log position it was read at.

     The page is an editor, not a viewer: it derives kinship, generations,
     duplicates and layout from the whole graph, and a partial graph gives
     wrong answers rather than missing ones. */
  r.get('/tree/:id/tree', async (req, res) => {
    try {
      res.json(await fullTree(pool, req.params.id));
    } catch (e) { sendError(res, e); }
  });

  /* Deliberately does NOT list the keys.
 
     The key is the credential that opens a family's tree. An endpoint that
     hands out every key would make every family readable by anybody through
     the gate, which is the whole thing the keys exist to prevent. Names and
     sizes are enough to say "these families are here"; opening one needs the
     link its family gave you. */
  r.get('/trees', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT t.id, t.name, t.created_at,
               (SELECT count(*)::int FROM people p
                 WHERE p.tree_id = t.id AND p.aside_at IS NULL) AS people
          FROM trees t ORDER BY t.created_at`);
      res.json({ trees: rows });
    } catch (e) { sendError(res, e); }
  });

  /* Start a family. Returns the key once, in the response that creates it —
     the only time the server volunteers a key it was not already given. */
  r.post('/trees', async (req, res) => {
    try {
      const name = String(req.body?.name || '').trim().slice(0, 200) || 'A family';
      const by = actorOf(req);
      const { rows } = await pool.query(
        `INSERT INTO trees (name, created_by) VALUES ($1, $2)
         RETURNING id, key, name, created_at`, [name, by]);
      res.status(201).json(rows[0]);
    } catch (e) { sendError(res, e); }
  });

  /* Open a family by its key. The key is in the path rather than a query
     string because query strings are the part of a URL that leaks most
     readily into logs and referrer headers — and this one is a credential. */
  r.get('/family/:key', async (req, res) => {
    try {
      const key = String(req.params.key || '');
      const { rows } = await pool.query(
        'SELECT id, name, created_at FROM trees WHERE key = $1', [key]);
      if (!rows.length) {
        // The same answer whether the key never existed or has been changed:
        // anything finer helps somebody work out which keys are real.
        return res.status(404).json({
          error: 'no_such_family',
          message: 'No family answers to that link. It may have been changed, ' +
                   'or copied incompletely.'
        });
      }
      res.json({ treeId: rows[0].id, name: rows[0].name, key });
    } catch (e) { sendError(res, e); }
  });

  /* Change a family's key, locking out everyone holding the old one. A
     deliberate act with a real cost, so it says what the cost is and hands
     back the new link exactly once. */
  r.post('/tree/:id/rotate-key', async (req, res) => {
    try {
      const { rows } = await pool.query(
        `UPDATE trees SET key = mw_new_tree_key(), key_set_at = clock_timestamp()
          WHERE id = $1 RETURNING id, key, name`, [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'no_such_family' });
      res.json(rows[0]);
    } catch (e) { sendError(res, e); }
  });

  // The write path. An array of operations, applied in one transaction, all or
  // nothing. Returns the new seq and the map of local refs to minted ids.
  r.post('/tree/:id/ops', async (req, res) => {
    try {
      const ops = Array.isArray(req.body) ? req.body : req.body?.ops;
      const result = await applyOps(pool, req.params.id, ops, actorOf(req));
      res.json(result);
    } catch (e) { sendError(res, e); }
  });

  // The neighbourhood around one person, not the whole tree. This is the call
  // that has to stay fast as the tree grows — the client shows one corner of
  // the family, so it should load one corner of the family.
  r.get('/tree/:id/bootstrap', async (req, res) => {
    try {
      res.json(await bootstrap(pool, req.params.id, {
        focus: req.query.focus || null,
        depth: req.query.depth ?? 3
      }));
    } catch (e) { sendError(res, e); }
  });

  // Incremental sync. The client holds a seq and asks for what it is missing,
  // rather than re-fetching a tree it already mostly has.
  r.get('/tree/:id/changes', async (req, res) => {
    try {
      res.json(await changesSince(pool, req.params.id, req.query.since, req.query.limit));
    } catch (e) { sendError(res, e); }
  });

  r.get('/tree/:id/search', async (req, res) => {
    try {
      res.json(await search(pool, req.params.id, req.query.q, { limit: req.query.limit }));
    } catch (e) { sendError(res, e); }
  });

  // Duplicate candidates. Runs on the server, on demand — never inside a
  // render. The old client scored every person against every other one on
  // every frame, which at 3,000 people is 4.5 million comparisons per frame.
  r.get('/tree/:id/duplicates', async (req, res) => {
    try {
      res.json(await findDuplicates(pool, req.params.id, {
        threshold: req.query.threshold ? Number(req.query.threshold) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined
      }));
    } catch (e) { sendError(res, e); }
  });

  /* Who is currently set aside — the whole of it with no query, or just the
     entries one person recorded when ?recordedBy= is given.

     ?recordedBy=<name> is the notice feed: "entries of yours that somebody
     has taken out of the tree, and why". It is a plain read of live state, so
     it is always current and never needs marking as seen. */
  r.get('/tree/:id/set-aside', async (req, res) => {
    try {
      const recordedBy = req.query.recordedBy;
      res.json(await setAsideList(pool, req.params.id,
        recordedBy === undefined ? {} : { recordedBy: String(recordedBy) }));
    } catch (e) { sendError(res, e); }
  });

  /* Families this one may share an ancestor with.
 
     Computed on demand and never stored: it is derived from names, totems and
     dates that change as families record more, so a stored match would be a
     stored answer going stale. What gets stored is a human's decision about
     one, which does not. */
  r.get('/tree/:id/relatives', async (req, res) => {
    try {
      res.json(await findRelatives(pool, req.params.id, {
        threshold: req.query.threshold ? Number(req.query.threshold) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined
      }));
    } catch (e) { sendError(res, e); }
  });

  /* Links already proposed, confirmed or rejected, from this tree's side. */
  r.get('/tree/:id/links', async (req, res) => {
    try {
      const status = req.query.status ? String(req.query.status) : null;
      res.json({ treeId: req.params.id, links: await linksFor(pool, req.params.id, status) });
    } catch (e) { sendError(res, e); }
  });

  return r;
};
