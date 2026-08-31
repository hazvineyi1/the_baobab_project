// The admin's surface.
//
// WHAT AN ADMIN CAN DO HERE, and the line this file exists to hold: everything
// below is about ACCESS — who may open a family's records — and nothing below
// touches what those records say. The admin can issue a family a new passcode,
// close a family, end a session, and answer an appeal. The admin cannot read
// anybody's tree, and there is no endpoint here that would let them.
//
// That is not an oversight to be filled in later. A project whose promise is
// that a family keeps its own records cannot have an administrator who quietly
// reads them all, and the way to mean that is for the capability to be absent
// rather than merely unused. Counts, dates and who has been editing are here,
// because those are what answering "we cannot get in" actually needs. Names
// are not.
//
// Everything that changes anything is recorded in audit_events, including the
// admin's own reads of the appeal queue — an administration that is not itself
// audited is not one.

const express = require('express');
const path = require('path');
const fs = require('fs');

const { withNonce } = require('../security');
const adminDb = require('../db/admin');
const access = require('../db/access');
const audit = require('../db/audit');
const appeals = require('../db/appeals');

const DASHBOARD = path.join(__dirname, '..', 'admin', 'dashboard.html');

function fail(res, e) {
  if (e && e.status) return res.status(e.status).json({ error: e.code || 'error', message: e.message });
  console.error('admin', e);
  return res.status(500).json({ error: 'internal', message: 'something went wrong' });
}

// Who the admin says they are. Self-claimed like every other actor here, and
// worth recording anyway: with one shared admin passphrase it is the only
// thing that distinguishes two people using it, and the session id and address
// beside it in the log do the rest.
const whoami = req => String(req.muti?.actor || req.get('x-muti-actor') || 'admin').slice(0, 120);

module.exports = function adminRoutes(pool) {
  const r = express.Router();

  const ctx = req => audit.from(req, { actor: whoami(req), sessionId: req.muti?.session?.id });

  /* The dashboard itself.

     Served from a route rather than from public/, deliberately: anything in
     public/ is served by express.static to everyone who is through the gate,
     which is every family on the deployment. A file that is only for the admin
     must not live where the static handler can find it. */
  r.get('/admin', (req, res) => {
    fs.readFile(DASHBOARD, 'utf8', (err, html) => {
      if (err) return res.status(500).type('text').send('The dashboard is missing.');
      // Its one script carries the request's nonce, like the family's page.
      res.type('html').send(withNonce(html, req.cspNonce));
    });
  });

  // ── the numbers ──────────────────────────────────────────────────────────

  r.get('/api/admin/overview', async (req, res) => {
    try { res.json(await adminDb.overview(pool)); } catch (e) { fail(res, e); }
  });

  r.get('/api/admin/activity', async (req, res) => {
    try { res.json({ days: await adminDb.activity(pool, { days: req.query.days }) }); }
    catch (e) { fail(res, e); }
  });

  r.get('/api/admin/storage', async (req, res) => {
    try { res.json({ tables: await adminDb.storage(pool) }); } catch (e) { fail(res, e); }
  });

  // ── families ─────────────────────────────────────────────────────────────

  r.get('/api/admin/families', async (req, res) => {
    try {
      res.json(await adminDb.families(pool, {
        q: req.query.q || '',
        filter: req.query.filter || '',
        limit: req.query.limit,
        cursor: req.query.cursor_at && req.query.cursor_id
          ? { created_at: req.query.cursor_at, id: req.query.cursor_id } : null
      }));
    } catch (e) { fail(res, e); }
  });

  r.get('/api/admin/family/:id', async (req, res) => {
    try {
      const found = await adminDb.family(pool, req.params.id);
      if (!found) return res.status(404).json({ error: 'no_such_family' });
      const [sessions, invites, recent] = await Promise.all([
        access.liveSessions(pool, { treeId: req.params.id, stale: true, limit: 25 }),
        access.listInvites(pool, req.params.id, { limit: 25 }),
        audit.events(pool, { treeId: req.params.id, limit: 40 })
      ]);
      res.json({ family: found, sessions, invites, events: recent.events });
    } catch (e) { fail(res, e); }
  });

  /* Issue a family a new passcode.

     THE PASSCODE IS IN THIS RESPONSE AND NOWHERE ELSE, EVER. It is not stored,
     not logged, and cannot be shown again — the admin has one chance to pass
     it on to the family. That is the cost of not keeping a table of every
     family's passcode in plaintext, and it is the right side of that trade.

     Every session the family had ends at the same moment, which is the point
     when the reason for the reset is that the old one went somewhere it should
     not have. */
  r.post('/api/admin/family/:id/passcode', async (req, res) => {
    try {
      const by = whoami(req);
      const issued = await access.issuePasscode(pool, req.params.id, { by });
      if (!issued) return res.status(404).json({ error: 'no_such_family' });

      // Belt and braces: raising the generation already ends them, and this
      // marks them ended so the dashboard shows what happened.
      const ended = await access.revokeTreeSessions(pool, req.params.id, by);

      await audit.record(pool, {
        ...ctx(req),
        kind: issued.passcode_gen === 1 ? 'passcode.set' : 'passcode.reset',
        ok: true, treeId: req.params.id,
        detail: { generation: issued.passcode_gen, sessionsEnded: ended,
                  reason: String(req.body?.reason || '').slice(0, 300) }
      });

      res.json({
        treeId: issued.id, name: issued.name, handle: issued.handle,
        passcode: issued.passcode, sessionsEnded: ended,
        notice: 'This is the only time this passcode can be seen. It is stored ' +
                'only as a hash — nobody, including you, can read it back.'
      });
    } catch (e) { fail(res, e); }
  });

  r.post('/api/admin/family/:id/suspend', async (req, res) => {
    try {
      const by = whoami(req);
      const reason = String(req.body?.reason || '').slice(0, 500);
      const done = await adminDb.suspend(pool, req.params.id, { reason, by });
      if (!done) return res.status(409).json({
        error: 'not_suspendable', message: 'That family is already closed, or does not exist.' });
      // Sessions already open are checked against a short-lived cache; closing
      // a family that takes effect in fifteen seconds is not closing it.
      access.forgetTree(req.params.id);
      await audit.record(pool, { ...ctx(req), kind: 'family.suspended', ok: true,
        treeId: req.params.id, detail: { reason } });
      res.json(done);
    } catch (e) { fail(res, e); }
  });

  r.post('/api/admin/family/:id/restore', async (req, res) => {
    try {
      const by = whoami(req);
      const done = await adminDb.restore(pool, req.params.id, { by });
      if (!done) return res.status(409).json({
        error: 'not_restorable', message: 'That family is not closed.' });
      access.forgetTree(req.params.id);
      await audit.record(pool, { ...ctx(req), kind: 'family.restored', ok: true,
        treeId: req.params.id });
      res.json(done);
    } catch (e) { fail(res, e); }
  });

  /* Delete a family. See db/admin.js for the three things that guard it.

     The record is written BEFORE the delete, not after: audit_events has no
     foreign key to trees precisely so that what happened to a family outlives
     the family, and a line written afterwards is a line that might not be
     written at all. */
  r.post('/api/admin/family/:id/delete', async (req, res) => {
    try {
      const by = whoami(req);
      const reason = String(req.body?.reason || '').slice(0, 500);
      const found = await adminDb.family(pool, req.params.id);
      if (!found) return res.status(404).json({ error: 'no_such_family' });

      // Typed back by hand, so deleting the wrong family takes more than a
      // mis-click on the wrong row.
      const typed = String(req.body?.handle || '').trim().toLowerCase();
      if (typed !== found.handle) {
        return res.status(400).json({
          error: 'handle_mismatch',
          message: `Type ${found.handle} to confirm. Nothing has been deleted.`
        });
      }

      /* The same precondition remove() enforces, checked here so the line
         below is not written for a delete that was never going to happen.
         remove() re-checks it under FOR UPDATE, which is what actually holds
         against a race; this only keeps the record honest. */
      if (!found.suspended_at) {
        return res.status(409).json({
          error: 'not_closed',
          message: 'Close this family first. Deleting one is the second half ' +
                   'of a deliberate act, never the first.'
        });
      }

      await audit.record(pool, {
        ...ctx(req), kind: 'family.deleted', ok: true, treeId: req.params.id,
        detail: { name: found.name, handle: found.handle, people: found.people,
                  changes: found.changes, reason }
      });

      const gone = await adminDb.remove(pool, req.params.id, { by, reason });
      if (!gone) return res.status(404).json({ error: 'no_such_family' });
      access.forgetTree(req.params.id);

      res.json({ ...gone,
        notice: 'Deleted. The record of what happened to this family remains in ' +
                'Activity, and any appeals it raised are kept. Nothing else is ' +
                'recoverable from inside this app.' });
    } catch (e) { fail(res, e); }
  });

  r.post('/api/admin/family/:id/revoke-sessions', async (req, res) => {
    try {
      const by = whoami(req);
      const n = await access.revokeTreeSessions(pool, req.params.id, by);
      await audit.record(pool, { ...ctx(req), kind: 'session.revoked', ok: true,
        treeId: req.params.id, detail: { count: n, scope: 'family' } });
      res.json({ ended: n });
    } catch (e) { fail(res, e); }
  });

  // ── sessions ─────────────────────────────────────────────────────────────

  r.get('/api/admin/sessions', async (req, res) => {
    try {
      res.json({ sessions: await access.liveSessions(pool, {
        treeId: req.query.treeId || null,
        scope: req.query.scope || null,
        stale: req.query.stale === '1' || req.query.stale === 'true',
        limit: req.query.limit
      }) });
    } catch (e) { fail(res, e); }
  });

  r.post('/api/admin/session/:id/revoke', async (req, res) => {
    try {
      const by = whoami(req);
      const done = await access.revokeSession(pool, req.params.id, by);
      if (!done) return res.status(404).json({ error: 'no_such_session' });
      await audit.record(pool, { ...ctx(req), kind: 'session.revoked', ok: true,
        treeId: done.tree_id, detail: { sessionId: done.id, scope: done.scope } });
      res.json(done);
    } catch (e) { fail(res, e); }
  });

  // ── the record ───────────────────────────────────────────────────────────

  /* Who, when, where, what.

     Keyset paginated: the cursor is the last row of the page before, so
     reading back through a year of history costs the same per page as reading
     the last hour. */
  r.get('/api/admin/events', async (req, res) => {
    try {
      res.json(await audit.events(pool, {
        treeId: req.query.treeId || null,
        kind: req.query.kind || null,
        actor: req.query.actor || null,
        ip: req.query.ip || null,
        since: req.query.since || null,
        until: req.query.until || null,
        limit: req.query.limit,
        cursor: req.query.cursor_at && req.query.cursor_id
          ? { at: req.query.cursor_at, id: req.query.cursor_id } : null
      }));
    } catch (e) { fail(res, e); }
  });

  // ── appeals ──────────────────────────────────────────────────────────────

  r.get('/api/admin/appeals', async (req, res) => {
    try {
      const list = await appeals.list(pool, {
        status: req.query.status || 'open',
        treeId: req.query.treeId || null,
        limit: req.query.limit
      });
      res.json({ appeals: list });
    } catch (e) { fail(res, e); }
  });

  r.post('/api/admin/appeal/:id/resolve', async (req, res) => {
    try {
      const by = whoami(req);
      const done = await appeals.resolve(pool, req.params.id, {
        answer: String(req.body?.answer || ''),
        status: req.body?.status === 'closed' ? 'closed' : 'answered',
        by
      });
      if (!done) return res.status(404).json({ error: 'no_such_appeal' });
      await audit.record(pool, {
        ...ctx(req),
        kind: done.status === 'closed' ? 'appeal.closed' : 'appeal.answered',
        ok: true, treeId: done.tree_id, detail: { appealId: done.id, kind: done.kind }
      });
      res.json(done);
    } catch (e) { fail(res, e); }
  });

  // Who the dashboard is talking to, so it can say so rather than assuming.
  r.get('/api/admin/me', (req, res) => {
    res.json({ scope: req.muti?.scope || null, actor: whoami(req),
               sessionId: req.muti?.session?.id || null });
  });

  /* Ending your own admin session. Worth having as a button rather than
     leaving somebody to delete a cookie: an admin session left open on a
     shared machine is the most valuable thing on this deployment. */
  r.post('/api/admin/sign-out', async (req, res) => {
    try {
      const id = req.muti?.session?.id;
      if (id) {
        await access.revokeSession(pool, id, whoami(req));
        await audit.record(pool, { ...ctx(req), kind: 'session.revoked', ok: true,
          detail: { sessionId: id, scope: 'admin', self: true } });
      }
      res.clearCookie('muti_gate', { path: '/' });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  return r;
};
