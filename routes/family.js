// What a family can do about its own way in.
//
// Invitations, appeals, and signing out. Everything here acts on the family
// the caller is signed in to and cannot be pointed at another one — there is
// no tree id in any of these paths, because the session already says which
// family this is and a parameter would be one missing check away from letting
// a family invite people into somebody else's tree.

const express = require('express');
const { limiter, addressOf, limitKeyOf } = require('../auth');
const access = require('../db/access');
const audit = require('../db/audit');
const appeals = require('../db/appeals');

function fail(res, e) {
  if (e && e.status) return res.status(e.status).json({ error: e.code || 'error', message: e.message });
  console.error('family', e);
  return res.status(500).json({ error: 'internal', message: 'something went wrong' });
}

// Self-claimed, exactly as in the changes log. It is a label, not a proof.
const whoami = req => String(req.get('x-muti-actor') || req.body?.by || req.muti?.actor || '').slice(0, 120);

/* Only a family session, and only its own family. An admin has no family and
   is refused here — deliberately, because an admin who could mint an
   invitation into any family would be an admin who could read every tree. */
function familyOnly(req, res, next) {
  if (req.muti?.scope === 'family' && req.muti.treeId) return next();
  return res.status(403).json({
    error: 'not_a_family_session',
    message: 'This needs to be done from inside the family whose tree it is about.'
  });
}

/* An invitation costs the server a random token and a row, and costs the
   family nothing to make — exactly the shape of thing that gets left running
   in a loop.

   Counted per session, with a much larger per-address backstop, for the same
   reason /trees is: a family gathering is one wifi and many people, and the
   limit that protects the table must not be the one that stops the gathering.
   Sixty an hour is more than any real family makes in a year. */
const inviteLimit = limiter(60, 60 * 60 * 1000);
const invitePerAddress = limiter(300, 60 * 60 * 1000);

module.exports = function familyRoutes(pool) {
  const r = express.Router();
  const ctx = req => audit.from(req, { actor: whoami(req), sessionId: req.muti?.session?.id });

  /* Who this session is, which is what the page asks on load so it knows
     which family it is showing and whether to offer the admin link.

     AND WHO IS VIEWING, which is the part the whole kinship engine rests on.
     Every Shona term is reckoned from somebody: Amaiguru and Amainini turn on
     whose mother is older, Tete and Sekuru on which side you stand, and "my
     sister's children are my children" on whether the person asking is a
     woman. There is no term without a viewer, and this is where the viewer
     comes from now — the session, not a line in the browser's storage that a
     new phone or a cleared cache silently answers differently. */
  r.get('/api/me', async (req, res) => {
    const s = req.muti?.session;
    if (!s) return res.status(401).json({ error: 'not_signed_in' });
    res.json({
      scope: s.scope, treeId: s.treeId || null, treeName: s.treeName || null,
      handle: s.handle || null, via: s.via || '', expiresAt: s.expiresAt || null,
      person: s.personId
        ? { id: s.personId, name: s.personName || '', at: s.personSetAt || null,
            // Said by somebody else, or said by this session about itself. The
            // page shows the difference rather than presenting a claim as a
            // fact.
            via: s.personVia || 'self' }
        : null
    });
  });

  /* SAY WHO IS VIEWING.

     A family passcode is shared — that is what a family passcode is — so this
     is a CLAIM, exactly like the `by` on every change in this project. It is
     not authentication and nothing here treats it as any. What it buys is the
     one thing kinship cannot do without: a person to reckon from. What makes
     it more than a claim is an invitation made for a named relative, and a
     session that arrived on one is refused here rather than allowed to
     re-answer.

     It is recorded, because it changes what every other answer means. */
  r.post('/api/me/person', familyOnly, async (req, res) => {
    try {
      const raw = req.body?.personId;
      // null clears it: somebody who marked the wrong person should be able to
      // take it back rather than being stuck as their own cousin.
      const personId = raw === null || raw === '' ? null : String(raw);
      const done = await access.identify(pool, req.muti.session.id, personId,
                                         { by: whoami(req) });
      if (!done) return res.status(401).json({ error: 'not_signed_in' });
      await audit.record(pool, { ...ctx(req), kind: 'session.identified', ok: true,
        treeId: req.muti.treeId,
        detail: { personId: done.personId, name: done.personName,
                  wasPersonId: done.beforeId, wasName: done.beforeName } });
      res.json({ person: done.personId
        ? { id: done.personId, name: done.personName, via: 'self' } : null });
    } catch (e) { fail(res, e); }
  });

  // ── invitations ──────────────────────────────────────────────────────────

  /* Make a link for a relative.

     THE TOKEN IS IN THIS RESPONSE AND NOWHERE ELSE. Same rule as the passcode:
     the table holds a hash, so an invitation cannot be read back out of the
     database — it can only be made, used, or withdrawn.

     This is the pass-it-on the project is built around, made safe: the family
     hands out a link rather than the passcode, so a relative who is given
     access cannot pass on the family's own way in, and the family can withdraw
     one person's link without changing everybody else's. */
  r.post('/api/invites', familyOnly, async (req, res) => {
    try {
      const who = limitKeyOf(req), addr = addressOf(req);
      if (inviteLimit.tooMany(who) || invitePerAddress.tooMany(addr)) {
        return res.status(429).json({
          error: 'too_many_invites',
          message: 'That is a lot of invitations at once. Try again in an hour — ' +
                   'the ones you have already made still work.'
        });
      }
      inviteLimit.note(who); invitePerAddress.note(addr);
      const by = whoami(req);
      const invite = await access.createInvite(pool, req.muti.treeId, {
        by, note: req.body?.note, days: req.body?.days, uses: req.body?.uses,
        // Naming who a link is for costs the sender one tap and is the only
        // thing in this project that makes "who is viewing" somebody else's
        // word rather than the holder's own.
        forPersonId: req.body?.forPersonId || null
      });
      await audit.record(pool, { ...ctx(req), kind: 'invite.created', ok: true,
        treeId: req.muti.treeId,
        detail: { inviteId: invite.id, uses: invite.max_uses, note: invite.note,
                  forPersonId: invite.for_person_id || null } });
      res.status(201).json({
        id: invite.id, expiresAt: invite.expires_at, uses: invite.max_uses,
        note: invite.note,
        forPerson: invite.for_person_id
          ? { id: invite.for_person_id, name: invite.forPersonName } : null,
        // A path, not a full URL: the server behind a proxy does not reliably
        // know what it is called from outside, and the page does.
        path: `/join/${invite.token}`,
        notice: invite.for_person_id
          ? `This link can only be shown once. It opens as ` +
            `${invite.forPersonName}, so send it to them and to nobody else — ` +
            `whoever follows it will be shown the family as they see it.`
          : 'This link can only be shown once. Send it to the person it is for.'
      });
    } catch (e) { fail(res, e); }
  });

  r.get('/api/invites', familyOnly, async (req, res) => {
    try {
      res.json({ invites: await access.listInvites(pool, req.muti.treeId, {
        limit: req.query.limit }) });
    } catch (e) { fail(res, e); }
  });

  r.post('/api/invites/:id/revoke', familyOnly, async (req, res) => {
    try {
      // treeId is passed so that an invitation belonging to another family
      // cannot be withdrawn by id alone.
      const done = await access.revokeInvite(pool, req.params.id,
        { treeId: req.muti.treeId, by: whoami(req) });
      if (!done) return res.status(404).json({ error: 'no_such_invite' });
      await audit.record(pool, { ...ctx(req), kind: 'invite.revoked', ok: true,
        treeId: req.muti.treeId, detail: { inviteId: done.id } });
      res.json({ id: done.id, revoked: true });
    } catch (e) { fail(res, e); }
  });

  // ── appeals, from inside ─────────────────────────────────────────────────

  /* Raised from within a session, so it carries which family it is from
     without anybody having to type it, and cannot be used to fill the admin's
     queue from outside. The other door — for people who cannot get in at all —
     is in the gate, and is held to a much tighter limit. */
  r.post('/api/appeals', async (req, res) => {
    try {
      const raised = await appeals.raise(pool, {
        treeId: req.muti?.treeId || null,
        treeLabel: req.muti?.session?.treeName || '',
        kind: req.body?.kind,
        personId: req.body?.personId || null,
        personName: req.body?.personName || '',
        body: req.body?.body,
        contact: req.body?.contact,
        by: whoami(req),
        ip: audit.clientIp(req)
      });
      await audit.record(pool, { ...ctx(req), kind: 'appeal.raised', ok: true,
        treeId: req.muti?.treeId || null,
        detail: { appealId: raised.id, kind: raised.kind, from: 'inside' } });
      res.status(201).json(raised);
    } catch (e) { fail(res, e); }
  });

  /* A family's own appeals and their answers. Never another family's, and
     never the address one was raised from. */
  r.get('/api/appeals', familyOnly, async (req, res) => {
    try {
      res.json({ appeals: await appeals.mine(pool, req.muti.treeId, { limit: req.query.limit }) });
    } catch (e) { fail(res, e); }
  });

  // ── leaving ──────────────────────────────────────────────────────────────

  r.post('/api/sign-out', async (req, res) => {
    try {
      const id = req.muti?.session?.id;
      if (id) {
        await access.revokeSession(pool, id, whoami(req));
        await audit.record(pool, { ...ctx(req), kind: 'session.revoked', ok: true,
          treeId: req.muti?.treeId || null, detail: { sessionId: id, self: true } });
      }
      res.clearCookie('muti_gate', { path: '/' });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });

  return r;
};
