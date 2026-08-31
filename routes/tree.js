// HTTP surface for the relational tree.
//
// Mounted alongside the old /api/shared blob API, which keeps working until
// the data has actually been moved across.

const express = require('express');
const { applyOps } = require('../db/ops');
const { bootstrap, fullTree, publicTree, publicPerson, changesSince, search,
        setAsideList } = require('../db/reads');
const { findDuplicates } = require('../db/duplicates');
const { findRelatives, linksFor } = require('../db/crosstree');
const { OpError } = require('../db/errors');
const { requireOwnTree, limiter, addressOf, limitKeyOf } = require('../auth');
const access = require('../db/access');
const audit = require('../db/audit');

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
// identity and grants nothing. Real access control is the gate, and which
// family you are in is `own` below.
const actorOf = req => String(req.get('x-muti-actor') || req.body?.by || '').slice(0, 120);

/* EVERY ROUTE THAT NAMES A TREE IS GUARDED BY THIS.

   Getting through the gate says you belong to A family. `own` says you belong
   to THIS one. Without it the per-family passcodes would decide who gets in
   and then any signed-in visitor could still ask for /api/tree/<any id>/tree —
   which is the old single deployment-wide passphrase again, wearing a
   passcode's clothes.

   It is applied per route rather than to the whole router because two routes
   here deliberately do not take a tree id (/home, /trees) and one takes a key
   instead (/family/:key); a blanket r.use() would silently do nothing for
   those three and read as though it had covered them. */
const own = requireOwnTree('id');

/* Starting a family is free to ask for and not free to do: a tree, a scrypt
   hash, a session. Two limits rather than one, and the pair is the point.

   Per SESSION is the one that bites first, and it is set where no person ever
   reaches it. Per ADDRESS is the backstop, set far higher, because forty
   relatives at a gathering share one wifi and each starting their own tree is
   this project working rather than being abused — while somebody who does hold
   a passcode should still not be able to loop sign-in-and-create from one
   machine all afternoon.

   This is the only rate limit on a WRITE in the project, and it is here rather
   than on /ops because ops are what the family came to do. */
const newFamilyLimit = limiter(20, 60 * 60 * 1000);
const newFamilyPerAddress = limiter(100, 60 * 60 * 1000);

module.exports = function treeRoutes(pool, homeTreeId = null) {
  const r = express.Router();

  /* WHO IS VIEWING, BEFORE ANYTHING IS RECKONED FROM THEM.

     Every Shona term this app produces is reckoned from somebody. Amaiguru
     and Amainini turn on whose mother is older; Tete and Sekuru on which side
     of the family you stand; "my sister's children are my children" on
     whether the person asking is a woman. A tree handed to a session that has
     not said who it is, is a tree that will be described to nobody — which is
     exactly what was happening, because the viewer used to be a line in the
     browser's storage that a new phone answered as blank.

     So the tree is not sent until the session has answered. The refusal
     carries the ONE thing needed to answer it: id and name, and nothing else.
     No dates, no totems, no marriages, no children — a roster is what the
     question needs and the rest is what the answer unlocks.

     Two cases go straight through, and both are the same case: there is
     nobody to be. A family with no people in it yet has just been started by
     whoever is asking, and a deployment with no gate has no session to carry
     an answer. */
  async function viewer(req, res, next) {
    const s = req.muti?.session;
    if (!s || s.scope !== 'family') return next();
    if (s.personId) return next();
    try {
      /* NAMES ONLY, and every name somebody might answer to.

         BE SENSITIVE TO MARRIED NAMES. This family records women under their
         own house's surname, which is right — a woman keeps her mutupo after
         marrying, so Evelyn Mandaba stays a Mandaba in a tree full of Musonis.
         But she has been Mai Musoni for thirty years, and Musoni is what she
         will type when a screen asks who she is. A roster that only knows the
         name on the record answers "you are not in this family" to somebody
         standing in the middle of it.

         So the answer carries the other names too: the one recorded on her
         card if anybody filled it in, AND — needing nothing filled in at all —
         her own first name with her husband's surname, worked out from the
         marriage that is already in the tree. That second one is the whole of
         the automation: nobody has to have thought of this in advance for it
         to work for them.

         Still names and nothing else. A partner's surname is a name; who is
         married to whom stays behind the answer, along with the dates, the
         mitupo and the rest of the family. */
      const { rows } = await pool.query(
        `SELECT p.id, p.name, p.also_known_as,
                COALESCE(array_agg(q.name) FILTER (WHERE q.id IS NOT NULL), '{}')
                  AS partner_names
           FROM people p
           LEFT JOIN union_partners up  ON up.person_id = p.id
           LEFT JOIN union_partners up2 ON up2.union_id = up.union_id
                                       AND up2.person_id <> p.id
           LEFT JOIN people q ON q.id = up2.person_id AND q.aside_at IS NULL
          WHERE p.tree_id = $1 AND p.aside_at IS NULL
          GROUP BY p.id, p.name, p.also_known_as
          ORDER BY p.name LIMIT 2000`, [s.treeId]);
      if (!rows.length) return next();

      const surname = n => String(n || '').trim().split(/\s+/).pop() || '';
      const first   = n => String(n || '').trim().split(/\s+/)[0] || '';
      const people = rows.map(r => {
        const also = new Set();
        if (r.also_known_as) also.add(r.also_known_as.trim());
        const mine = surname(r.name).toLowerCase();
        for (const partner of r.partner_names || []) {
          const theirs = surname(partner);
          // Only where it would actually be a different name. A woman who
          // married a man of her own surname is not also known as herself.
          if (theirs && theirs.toLowerCase() !== mine && first(r.name)) {
            also.add(`${first(r.name)} ${theirs}`);
          }
        }
        return { id: r.id, name: r.name,
                 ...(also.size ? { also: [...also] } : {}) };
      });

      return res.status(428).json({
        error: 'who_are_you',
        message: 'Say who you are in this family. Every word this tree uses is ' +
                 'reckoned from one person, so it has to know which one you are.',
        people
      });
    } catch (e) { return sendError(res, e); }
  }

  /* Which family this visitor is in.

     THE SESSION DECIDES, not the deployment. Before per-family passcodes there
     was one tree and this returned it; now the passcode somebody signed in
     with says which family they are, and this reports that. homeTreeId remains
     the fallback for the one case that has no family session of its own: a
     deployment with no gate at all, run locally to look at. */
  r.get('/home', async (req, res) => {
    const treeId = req.muti?.treeId || homeTreeId;
    if (!treeId) {
      return res.status(503).json({
        error: 'no_tree', message: 'the server has not finished choosing a tree' });
    }
    try {
      const { rows } = await pool.query(
        'SELECT id, key, name, handle FROM trees WHERE id = $1', [treeId]);
      res.json(rows.length
        ? { treeId: rows[0].id, key: rows[0].key, name: rows[0].name,
            handle: rows[0].handle, via: req.muti?.session?.via || '' }
        : { treeId });
    } catch (e) { sendError(res, e); }
  });

  /* The whole tree, plus the change-log position it was read at.

     The page is an editor, not a viewer: it derives kinship, generations,
     duplicates and layout from the whole graph, and a partial graph gives
     wrong answers rather than missing ones. */
  r.get('/tree/:id/tree', own, viewer, async (req, res) => {
    try {
      res.json(await fullTree(pool, req.params.id));
    } catch (e) { sendError(res, e); }
  });

  /* The list of families — ADMIN ONLY, since per-family passcodes.

     It used to be readable by anyone through the gate, on the reasoning that
     names and sizes are not much and opening one still needed its key. That
     reasoning does not survive the passcodes: the whole promise now is that a
     family's existence and size is theirs, and a list of every family on the
     deployment is the one thing that makes a passcode look like a formality.
     The admin's own view of this is /api/admin/families. */
  r.get('/trees', (req, res, next) => {
    if (req.muti?.scope === 'admin') return next();
    return res.status(403).json({
      error: 'not_admin',
      message: 'The families on this deployment are not listed. Open yours with ' +
               'its passcode, or an invitation from somebody in it.'
    });
  }, async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT t.id, t.name, t.created_at,
               (SELECT count(*)::int FROM people p
                 WHERE p.tree_id = t.id AND p.aside_at IS NULL) AS people
          FROM trees t ORDER BY t.created_at`);
      res.json({ trees: rows });
    } catch (e) { sendError(res, e); }
  });

  /* Start a family.

     Three things happen together, and they have to: the tree is made, it is
     given a passcode, and the caller is moved into it. Making a family without
     a passcode would leave a tree nobody could ever open again; making one
     without moving the session would leave the person who started it locked
     out of the family they just started, since their session is scoped to the
     family they were in.

     THE PASSCODE IS IN THIS RESPONSE AND NOWHERE ELSE. It is stored as a
     scrypt hash, so it cannot be read back — by the family, by the admin, or
     by anybody who reaches the database. Losing it means being issued another,
     which is what the admin is for. */
  r.post('/trees', async (req, res) => {
    try {
      const who = limitKeyOf(req), addr = addressOf(req);
      if (newFamilyLimit.tooMany(who) || newFamilyPerAddress.tooMany(addr)) {
        return res.status(429).json({
          error: 'too_many_families',
          message: 'That is several families started in a short time. Try again ' +
                   'in an hour — the ones already started are untouched.'
        });
      }
      newFamilyLimit.note(who); newFamilyPerAddress.note(addr);
      const name = String(req.body?.name || '').trim().slice(0, 200) || 'A family';
      const by = actorOf(req);
      const { rows } = await pool.query(
        `INSERT INTO trees (name, created_by) VALUES ($1, $2)
         RETURNING id, key, name, handle, created_at`, [name, by]);
      const made = rows[0];

      const issued = await access.issuePasscode(pool, made.id, { by });
      const session = await access.createSession(pool, {
        scope: 'family', treeId: made.id, via: 'created',
        passcodeGen: issued.passcode_gen, actor: by,
        ip: audit.clientIp(req), userAgent: audit.uaOf(req)
      });
      res.cookie('muti_gate', session.cookie, {
        httpOnly: true, sameSite: 'lax',
        secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
        maxAge: access.SESSION_DAYS * 24 * 60 * 60 * 1000, path: '/'
      });

      await audit.record(pool, audit.from(req, {
        kind: 'family.created', ok: true, treeId: made.id, actor: by,
        sessionId: session.id, detail: { name: made.name, handle: made.handle } }));
      await audit.record(pool, audit.from(req, {
        kind: 'passcode.set', ok: true, treeId: made.id, actor: by,
        sessionId: session.id, detail: { generation: issued.passcode_gen } }));

      res.status(201).json({
        ...made, passcode: issued.passcode,
        notice: 'Write this down now. It is the only time it can be shown, and ' +
                'it is the only way back into this family. Nobody can read it ' +
                'back for you — not even the keeper of this deployment, who can ' +
                'only issue a new one.'
      });
    } catch (e) { sendError(res, e); }
  });

  /* Look a family up by its key.

     THE KEY NO LONGER OPENS ANYTHING. It used to be the credential: hold the
     link, hold the tree. Per-family passcodes replace that, and this is now a
     lookup that answers only for the family the caller is already in — which
     is what the page needs it for, to turn a remembered link into a name.

     A key belonging to somebody else's family gets the same 404 as a key that
     never existed. That is the honest consequence of the change: links shared
     before this are no longer a way in, and an invitation is. */
  r.get('/family/:key', async (req, res) => {
    try {
      const key = String(req.params.key || '');
      const { rows } = await pool.query(
        'SELECT id, name, created_at FROM trees WHERE key = $1', [key]);
      // A FAMILY SESSION, AND ITS OWN FAMILY. An admin is refused here too:
      // the keeper's view of a family is /api/admin/families, which gives sizes
      // and dates and no way into the tree. Two doors onto the same question
      // is how one of them ends up with the weaker rule.
      if (rows.length && !(req.muti?.scope === 'family' && req.muti.treeId === rows[0].id)) {
        rows.length = 0;
      }
      if (!rows.length) {
        // The same answer whether the key never existed or has been changed:
        // anything finer helps somebody work out which keys are real.
        return res.status(404).json({
          error: 'no_such_family',
          message: 'No family answers to that link. It may have been changed, ' +
                   'copied incompletely, or belong to a family you are not in — ' +
                   'a link is no longer a way in; ask them for an invitation.'
        });
      }
      res.json({ treeId: rows[0].id, name: rows[0].name, key });
    } catch (e) { sendError(res, e); }
  });

  /* Change a family's key, locking out everyone holding the old one. A
     deliberate act with a real cost, so it says what the cost is and hands
     back the new link exactly once. */
  r.post('/tree/:id/rotate-key', own, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `UPDATE trees SET key = mw_new_tree_key(), key_set_at = clock_timestamp()
          WHERE id = $1 RETURNING id, key, name`, [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: 'no_such_family' });
      await audit.record(pool, audit.from(req, {
        kind: 'family.key_rotated', ok: true, treeId: req.params.id,
        actor: actorOf(req), sessionId: req.muti?.session?.id }));
      res.json(rows[0]);
    } catch (e) { sendError(res, e); }
  });

  // The write path. An array of operations, applied in one transaction, all or
  // nothing. Returns the new seq and the map of local refs to minted ids.
  r.post('/tree/:id/ops', own, async (req, res) => {
    try {
      const ops = Array.isArray(req.body) ? req.body : req.body?.ops;
      const result = await applyOps(pool, req.params.id, ops, actorOf(req));
      /* A merge can move a session's viewer onto the record that stayed (see
         mergePeople). The sessions cache holds who each session is, so it has
         to be told — otherwise the person who just folded away their own
         duplicate goes on being reckoned from a record that is now set aside,
         for as long as the cache lasts. */
      if ((ops || []).some(o => o && o.op === 'mergePeople')) {
        access.forgetTree(req.params.id);
      }
      // WHAT was done, coarsely. The `changes` table already holds every edit
      // in full; recording the detail again here would be two records of one
      // act that can disagree. This says a batch arrived, from where, and of
      // what kinds — which is what makes an edit findable in the record beside
      // the sign-in that preceded it.
      audit.record(pool, audit.from(req, {
        kind: 'tree.ops', ok: true, treeId: req.params.id, actor: actorOf(req),
        sessionId: req.muti?.session?.id,
        detail: { count: Array.isArray(ops) ? ops.length : 0,
                  kinds: [...new Set((ops || []).map(o => o && o.op).filter(Boolean))],
                  seq: result?.seq }
      })).catch(() => {});
      res.json(result);
    } catch (e) { sendError(res, e); }
  });

  // The neighbourhood around one person, not the whole tree. This is the call
  // that has to stay fast as the tree grows — the client shows one corner of
  // the family, so it should load one corner of the family.
  r.get('/tree/:id/bootstrap', own, async (req, res) => {
    try {
      res.json(await bootstrap(pool, req.params.id, {
        focus: req.query.focus || null,
        depth: req.query.depth ?? 3
      }));
    } catch (e) { sendError(res, e); }
  });

  // Incremental sync. The client holds a seq and asks for what it is missing,
  // rather than re-fetching a tree it already mostly has.
  r.get('/tree/:id/changes', own, async (req, res) => {
    try {
      res.json(await changesSince(pool, req.params.id, req.query.since, req.query.limit));
    } catch (e) { sendError(res, e); }
  });

  r.get('/tree/:id/search', own, async (req, res) => {
    try {
      res.json(await search(pool, req.params.id, req.query.q, { limit: req.query.limit }));
    } catch (e) { sendError(res, e); }
  });

  // Duplicate candidates. Runs on the server, on demand — never inside a
  // render. The old client scored every person against every other one on
  // every frame, which at 3,000 people is 4.5 million comparisons per frame.
  r.get('/tree/:id/duplicates', own, async (req, res) => {
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
  r.get('/tree/:id/set-aside', own, async (req, res) => {
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
  r.get('/tree/:id/relatives', own, async (req, res) => {
    try {
      res.json(await findRelatives(pool, req.params.id, {
        threshold: req.query.threshold ? Number(req.query.threshold) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined
      }));
    } catch (e) { sendError(res, e); }
  });

  /* Links already proposed, confirmed or rejected, from this tree's side. */
  r.get('/tree/:id/links', own, async (req, res) => {
    try {
      const status = req.query.status ? String(req.query.status) : null;
      res.json({ treeId: req.params.id, links: await linksFor(pool, req.params.id, status) });
    } catch (e) { sendError(res, e); }
  });

  return r;
};

/* The world's view: ancestors, and any living person who has chosen to be
   published. Mounted on its own router so it can live OUTSIDE the passphrase
   gate — a public record behind a passphrase is not a public record.
 
   Nothing here takes a family key, and nothing here can reach a private
   person: it calls publicTree/publicPerson, which have no parameter that
   would let them. */
module.exports.publicRoutes = function publicRoutes(pool) {
  const r = express.Router();

  // No `own` here, and there must never be one. This router is mounted OUTSIDE
  // the gate: it is the world's view, and the world has no session to own a
  // family with. What keeps it safe is not a guard but what it calls —
  // publicTree and publicPerson have no parameter that could return a private
  // person.
  r.get('/tree/:id', async (req, res) => {
    try { res.json(await publicTree(pool, req.params.id)); }
    catch (e) { sendError(res, e); }
  });

  r.get('/person/:id', async (req, res) => {
    try {
      const found = await publicPerson(pool, req.params.id);
      // The same answer for "private" and "no such person". Anything else
      // confirms that somebody exists, which is half of what was being kept
      // back.
      if (!found) return res.status(404).json({ error: 'not_found' });
      res.json(found);
    } catch (e) { sendError(res, e); }
  });

  return r;
};
