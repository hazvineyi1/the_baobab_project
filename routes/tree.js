// HTTP surface for the relational tree.
//
// Mounted alongside the old /api/shared blob API, which keeps working until
// the data has actually been moved across.

const express = require('express');
const { applyOps } = require('../db/ops');
const { bootstrap, changesSince, search } = require('../db/reads');
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

module.exports = function treeRoutes(pool) {
  const r = express.Router();

  r.get('/trees', async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT id, name, created_at FROM trees ORDER BY created_at');
      res.json({ trees: rows });
    } catch (e) { sendError(res, e); }
  });

  r.post('/trees', async (req, res) => {
    try {
      const name = String(req.body?.name || 'Muti weMhuri').slice(0, 200);
      const { rows } = await pool.query(
        'INSERT INTO trees (name) VALUES ($1) RETURNING id, name, created_at', [name]);
      res.status(201).json(rows[0]);
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

  return r;
};
