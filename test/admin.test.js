// The keeper's surface, and the wall between it and the families.
//
// Driven over real HTTP against the real gate and the real routers, because
// almost everything being asserted lives in middleware ordering and in which
// guard is applied to which route — none of which a unit test of a handler
// would see.
//
// THE THREE THINGS THESE EXIST TO CATCH, in order of how bad they would be:
//
//   1. a family session reaching another family's tree. That is the whole
//      promise of per-family passcodes; without it they are decoration.
//   2. an admin session reading a family's records. An administrator of a
//      project like this must not be able to, and "there is no endpoint"
//      is only true until somebody adds one — so it is asserted.
//   3. a family session reaching the keeper's pages.

const http = require('http');
const express = require('express');
const { check, eq, section, report, freshPool } = require('./helpers');
const { gate, requireAdmin } = require('../auth');
const treeRoutes = require('../routes/tree');
const adminRoutes = require('../routes/admin');
const familyRoutes = require('../routes/family');
const access = require('../db/access');
const audit = require('../db/audit');

const ADMIN = 'the-keeper-of-this-deployment';

function listen(app) {
  return new Promise(resolve => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
}

/* A request that keeps its own cookie jar, so "signed in as this family" is a
   thing the test can hold rather than a header it has to remember. */
function client(server) {
  const port = server.address().port;
  let cookie = null;
  const go = (path, { method = 'GET', form, json, headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      let payload = null, type = null;
      if (form) { payload = new URLSearchParams(form).toString();
                  type = 'application/x-www-form-urlencoded'; }
      if (json) { payload = JSON.stringify(json); type = 'application/json'; }
      const r = http.request({
        host: '127.0.0.1', port, path, method,
        headers: {
          Accept: 'application/json',
          ...(cookie ? { Cookie: cookie } : {}),
          ...(payload ? { 'Content-Type': type,
                          'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers
        }
      }, res => {
        let text = '';
        res.on('data', c => text += c);
        res.on('end', () => {
          const set = res.headers['set-cookie'];
          if (set) {
            const v = set.join(';').match(/muti_gate=([^;]*)/);
            if (v) cookie = 'muti_gate=' + v[1];
          }
          let body = null;
          try { body = JSON.parse(text); } catch { /* html */ }
          resolve({ status: res.statusCode, text, body,
                    location: res.headers.location });
        });
      });
      r.on('error', reject);
      if (payload) r.write(payload);
      r.end();
    });
  return { go, forget: () => { cookie = null; } };
}

(async () => {
  const pool = await freshPool();
  await audit.ensurePartitions(pool, () => {});

  // Two families, made directly, the way ensureHomeTree makes the first one.
  const mk = async name => (await pool.query(
    'INSERT INTO trees (name) VALUES ($1) RETURNING id, handle, key', [name])).rows[0];
  const nyamhunga = await mk('the Nyamhunga family');
  const moyo = await mk('the Moyo family');

  await pool.query(`INSERT INTO people (tree_id, name, totem) VALUES ($1,'Sekuru Chenjerai','Nzou')`,
    [nyamhunga.id]);
  await pool.query(`INSERT INTO people (tree_id, name, totem) VALUES ($1,'Mbuya Nyarai','Shava')`,
    [moyo.id]);

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(gate({ log: () => {}, adminPassphrase: ADMIN, hasDatabase: true,
                 getPool: () => pool, getHomeTreeId: () => nyamhunga.id }));
  app.use('/api', treeRoutes(pool, nyamhunga.id));
  app.use(familyRoutes(pool));
  app.use((req, res, next) =>
    (req.path === '/admin' || req.path.startsWith('/api/admin'))
      ? requireAdmin(req, res, next) : next());
  app.use(adminRoutes(pool));
  const server = await listen(app);

  // ── the keeper gets in, and issues passcodes ─────────────────────────────
  section('the keeper signs in with their own passphrase');
  const keeper = client(server);
  let r = await keeper.go('/gate', { method:'POST', form:{ passphrase: ADMIN } });
  eq('let in', r.status, 303);
  eq('and taken to the dashboard, not to a family', r.location, '/admin');

  r = await keeper.go('/api/admin/me');
  eq('the session says what it is', r.body.scope, 'admin');

  section('the keeper issues a family its passcode');
  r = await keeper.go(`/api/admin/family/${nyamhunga.id}/passcode`,
    { method:'POST', json:{ reason:'first issue' } });
  eq('issued', r.status, 200);
  const code1 = r.body.passcode;
  check('the passcode is in the response', typeof code1 === 'string' && code1.length > 12);
  check('and the response says it will not be shown again', /only time/i.test(r.body.notice));

  const stored = await pool.query('SELECT passcode_hash FROM trees WHERE id=$1', [nyamhunga.id]);
  check('what is kept is a hash, not the passcode',
        !stored.rows[0].passcode_hash.includes(code1.split('-')[1]));

  r = await keeper.go(`/api/admin/family/${moyo.id}/passcode`, { method:'POST' });
  const code2 = r.body.passcode;

  // ── the wall ─────────────────────────────────────────────────────────────
  section('THE ADMIN CANNOT READ A FAMILY\'S TREE');
  // Not "does not happen to" — there is no route that would. If somebody adds
  // one, this fails, which is the point of asserting it rather than trusting it.
  for (const path of [
    `/api/tree/${nyamhunga.id}/tree`,
    `/api/tree/${nyamhunga.id}/bootstrap`,
    `/api/tree/${nyamhunga.id}/search?q=Chenjerai`,
    `/api/tree/${nyamhunga.id}/set-aside`,
    `/api/family/${nyamhunga.key}`
  ]) {
    r = await keeper.go(path);
    check(`refused: ${path.replace(nyamhunga.id, '<family>').replace(nyamhunga.key, '<key>')}`,
          r.status === 404 || r.status === 403, `got ${r.status}`);
    check('  and no name came back with it', !/Chenjerai/.test(r.text));
  }

  section('nor write to one');
  r = await keeper.go(`/api/tree/${nyamhunga.id}/ops`, { method:'POST',
    json:[{ op:'addPerson', ref:'x', name:'Somebody the keeper invented' }] });
  check('refused', r.status === 404 || r.status === 403, `got ${r.status}`);
  const after = await pool.query('SELECT count(*)::int n FROM people WHERE tree_id=$1',
    [nyamhunga.id]);
  eq('and nobody was added', after.rows[0].n, 1);

  section('what the keeper CAN see is sizes and dates, never names');
  r = await keeper.go(`/api/admin/family/${nyamhunga.id}`);
  eq('the family is described', r.status, 200);
  eq('with a count', r.body.family.people, 1);
  check('and no name from inside the tree', !/Chenjerai/.test(JSON.stringify(r.body)));

  // ── a family gets in ─────────────────────────────────────────────────────
  section('a family signs in with its own passcode');
  const one = client(server);
  r = await one.go('/gate', { method:'POST', form:{ passphrase: code1 } });
  eq('let in', r.status, 303);
  eq('and taken to their tree, not to the dashboard', r.location, '/');

  r = await one.go('/api/home');
  eq('which family they are in is decided by the session', r.body.treeId, nyamhunga.id);

  r = await one.go(`/api/tree/${nyamhunga.id}/tree`);
  eq('they can read their own tree', r.status, 200);
  check('and their own people are in it', /Chenjerai/.test(r.text));

  section('A FAMILY CANNOT REACH ANOTHER FAMILY');
  for (const path of [
    `/api/tree/${moyo.id}/tree`,
    `/api/tree/${moyo.id}/bootstrap`,
    `/api/tree/${moyo.id}/search?q=Nyarai`,
    `/api/tree/${moyo.id}/duplicates`,
    `/api/tree/${moyo.id}/relatives`,
    `/api/tree/${moyo.id}/changes?since=0`,
    `/api/tree/${moyo.id}/links`,
    `/api/family/${moyo.key}`
  ]) {
    r = await one.go(path);
    eq(`refused: ${path.replace(moyo.id, '<other>').replace(moyo.key, '<their key>')}`,
       r.status, 404);
    check('  and no name of theirs came back', !/Nyarai/.test(r.text));
  }

  section('nor write into one');
  r = await one.go(`/api/tree/${moyo.id}/ops`, { method:'POST',
    json:[{ op:'addPerson', ref:'x', name:'Intruder' }] });
  eq('refused', r.status, 404);
  const theirs = await pool.query('SELECT count(*)::int n FROM people WHERE tree_id=$1', [moyo.id]);
  eq('and their tree is untouched', theirs.rows[0].n, 1);

  section('nor take a family\'s link and open it');
  // This is the change that costs something, so it is asserted rather than
  // left implied: a sharing link is no longer a way in.
  r = await one.go(`/api/family/${moyo.key}`);
  eq('a link to another family opens nothing', r.status, 404);
  check('and the message says what to ask for instead', /invitation/i.test(r.text));

  section('nor list the families on this deployment');
  r = await one.go('/api/trees');
  eq('refused', r.status, 403);
  check('and no other family is named', !/Moyo/.test(r.text));

  section('nor reach the keeper\'s pages');
  for (const path of ['/admin', '/api/admin/overview', '/api/admin/families',
                      '/api/admin/events', '/api/admin/appeals']) {
    r = await one.go(path);
    eq(`refused: ${path}`, r.status, 403);
  }
  r = await one.go(`/api/admin/family/${moyo.id}/passcode`, { method:'POST' });
  eq('and cannot issue itself another family\'s passcode', r.status, 403);

  // ── invitations ──────────────────────────────────────────────────────────
  section('a family invites a relative');
  r = await one.go('/api/invites', { method:'POST', json:{ note:'for Tete Ratidzo' },
                                     headers:{ 'X-Muti-Actor':'Rufaro' } });
  eq('made', r.status, 201);
  const invitePath = r.body.path;
  check('the link is handed back once', /^\/join\//.test(invitePath));

  section('a link preview does not spend it');
  // WhatsApp fetches a link before any human clicks it. A single-use invitation
  // consumed by a preview is one the relative never gets.
  const crawler = client(server);
  r = await crawler.go(invitePath);
  eq('the crawler gets a page', r.status, 200);
  const notYet = await pool.query('SELECT uses FROM invites WHERE tree_id=$1', [nyamhunga.id]);
  eq('and the invitation is still unused', notYet.rows[0].uses, 0);

  section('the relative takes it up');
  const relative = client(server);
  const token = invitePath.slice('/join/'.length);
  r = await relative.go('/join', { method:'POST', form:{ token } });
  eq('let in', r.status, 303);
  r = await relative.go('/api/home');
  eq('into the family that invited them', r.body.treeId, nyamhunga.id);
  r = await relative.go(`/api/tree/${moyo.id}/tree`);
  eq('and no further than that', r.status, 404);

  section('an invitation does not give away the passcode');
  r = await relative.go('/api/invites');
  check('they can see the family\'s invitations', r.status === 200);
  check('but no passcode appears anywhere in what they are given',
        !r.text.includes(code1));

  // ── starting a family ────────────────────────────────────────────────────
  section('starting a family issues its passcode and moves you into it');
  const starter = client(server);
  await starter.go('/gate', { method:'POST', form:{ passphrase: code2 } });
  r = await starter.go('/api/trees', { method:'POST', json:{ name:'the Mutasa family' },
                                       headers:{ 'X-Muti-Actor':'Chenjerai' } });
  eq('made', r.status, 201);
  check('with a passcode, once', typeof r.body.passcode === 'string');
  check('and a notice saying it cannot be shown again', /only time/i.test(r.body.notice));
  const made = r.body;
  r = await starter.go('/api/home');
  eq('and the session has moved into it', r.body.treeId, made.id);
  r = await starter.go(`/api/tree/${moyo.id}/tree`);
  eq('so the family they came from is now closed to them', r.status, 404);

  // ── appeals ──────────────────────────────────────────────────────────────
  section('an appeal from outside the gate');
  const stranger = client(server);
  r = await stranger.go('/appeal', { method:'POST', form:{
    kind:'passcode', family: nyamhunga.handle, by:'Rufaro',
    body:'We lost the paper it was written on.', contact:'0772 000 000' } });
  eq('accepted', r.status, 200);
  check('and says so', /sent/i.test(r.text));

  r = await stranger.go('/api/home');
  eq('but the stranger is still outside', r.status, 401);

  section('the keeper sees it, with where it came from');
  r = await keeper.go('/api/admin/appeals?status=open');
  const appeal = r.body.appeals.find(a => a.kind === 'passcode');
  check('it is in the queue', !!appeal);
  eq('matched to the family they named', appeal.tree_id, nyamhunga.id);
  check('with a way of reaching them', appeal.contact.includes('0772'));
  check('and the address it came from', !!appeal.raised_ip);

  section('answering one');
  r = await keeper.go(`/api/admin/appeal/${appeal.id}/resolve`,
    { method:'POST', json:{ answer:'Telephoned and issued a new passcode.' } });
  eq('answered', r.body.status, 'answered');
  r = await keeper.go('/api/admin/appeals?status=open');
  check('and it leaves the queue',
        !r.body.appeals.some(a => a.id === appeal.id));

  section('a family sees its own appeals and nobody else\'s');
  r = await one.go('/api/appeals');
  check('their own', r.body.appeals.some(a => a.kind === 'passcode'));
  const mine = JSON.stringify(r.body);
  check('and no address, even of their own', !/raised_ip/.test(mine));

  // ── closing a family ─────────────────────────────────────────────────────
  section('the keeper closes a family');
  r = await keeper.go(`/api/admin/family/${nyamhunga.id}/suspend`,
    { method:'POST', json:{ reason:'a dispute the family asked us to hold' } });
  eq('closed', r.status, 200);

  r = await one.go('/api/home');
  eq('their session stops working at once', r.status, 401);
  const shut = client(server);
  r = await shut.go('/gate', { method:'POST', form:{ passphrase: code1 } });
  eq('and their passcode will not open it', r.status, 403);
  check('with the reason said plainly', /closed by the keeper/i.test(r.text));

  const kept = await pool.query('SELECT count(*)::int n FROM people WHERE tree_id=$1',
    [nyamhunga.id]);
  eq('NOTHING of theirs was deleted', kept.rows[0].n, 1);

  section('and reopens it');
  await keeper.go(`/api/admin/family/${nyamhunga.id}/restore`, { method:'POST' });
  r = await one.go('/api/home');
  eq('the same session works again', r.status, 200);

  // ── the record ───────────────────────────────────────────────────────────
  section('all of it is in the record');
  r = await keeper.go('/api/admin/events?limit=200');
  const kinds = r.body.events.map(e => e.kind);
  for (const k of ['gate.ok', 'gate.suspended', 'passcode.set', 'family.suspended',
                   'family.restored', 'invite.created', 'invite.accepted',
                   'appeal.raised', 'appeal.answered', 'family.created']) {
    check(`recorded: ${k}`, kinds.includes(k));
  }
  const one_ok = r.body.events.find(e => e.kind === 'gate.ok' && e.tree_id === nyamhunga.id);
  check('a sign-in says where it came from', !!one_ok.ip);
  check('and when', !!one_ok.at);

  section('a wrong passcode is recorded without recording the passcode');
  const guesser = client(server);
  await guesser.go('/gate', { method:'POST',
    form:{ passphrase: nyamhunga.handle + '-aaaaaa-bbbbbb' } });
  r = await keeper.go('/api/admin/events?kind=gate.fail&limit=10');
  check('the attempt is there', r.body.events.length > 0);
  check('and what was typed is not', !r.text.includes('aaaaaa-bbbbbb'));

  section('the feed can be read back a page at a time');
  r = await keeper.go('/api/admin/events?limit=5');
  eq('a page', r.body.events.length, 5);
  check('with a cursor to carry on from', !!r.body.next);
  const first = r.body.events.map(e => e.id);
  r = await keeper.go(`/api/admin/events?limit=5&cursor_at=${encodeURIComponent(r.body.next.at)}` +
                      `&cursor_id=${r.body.next.id}`);
  check('the next page does not repeat the first',
        !r.body.events.some(e => first.includes(e.id)));

  section('and filtered to one family, or one kind, or one address');
  r = await keeper.go(`/api/admin/events?treeId=${moyo.id}&limit=50`);
  check('one family only', r.body.events.every(e => e.tree_id === moyo.id));
  r = await keeper.go('/api/admin/events?kind=invite&limit=50');
  check('a whole family of kinds by its prefix',
        r.body.events.length > 0 && r.body.events.every(e => e.kind.startsWith('invite')));

  // ── sessions ─────────────────────────────────────────────────────────────
  section('the keeper can see who is signed in, and end a session');
  r = await keeper.go('/api/admin/sessions');
  const live = r.body.sessions.filter(s => s.scope === 'family');
  check('families are listed', live.length > 0);
  check('with where they are', live.every(s => s.last_ip || s.created_ip));
  check('and no token', !r.text.includes('token'));

  // The one that signed in with the passcode — the relative came in on an
  // invitation and is a different session for the same family.
  const target = live.find(s => s.tree_id === nyamhunga.id && s.via === 'passcode');
  await keeper.go(`/api/admin/session/${target.id}/revoke`, { method:'POST' });
  r = await one.go('/api/home');
  eq('ending one signs that browser out', r.status, 401);
  const stillThere = await pool.query('SELECT count(*)::int n FROM people WHERE tree_id=$1',
    [nyamhunga.id]);
  eq('and takes nothing with it', stillThere.rows[0].n, 1);

  section('the numbers the dashboard opens with');
  r = await keeper.go('/api/admin/overview');
  check('families are counted', r.body.families.n >= 3);
  check('and the count says whether it is exact', typeof r.body.families.exact === 'boolean');
  check('people are counted', r.body.people.n >= 2);
  check('sign-ins today', r.body.signins_24h > 0);
  check('and refusals today', r.body.failed_24h > 0);

  server.close();
  await pool.end();
  report();
})();
