// Passcodes, sessions and invitations.
//
// These test the REFUSALS, because that is what an access system is. A test
// that a right passcode works proves almost nothing; a test that a wrong one
// fails, that one family's passcode cannot open another family, that a
// single-use invitation cannot be used twice, and that a reset really ends the
// old sessions, is the whole of it.
//
// Two of these are written the awkward way on purpose:
//
//   * the enumeration test measures TIME, because the leak it is about is a
//     timing difference and nothing else would see it;
//   * the invitation race runs two acceptances at once, because the bug it is
//     about only exists when they overlap.

const { check, eq, section, report, freshPool, newTree } = require('./helpers');
const access = require('../db/access');

(async () => {
  const pool = await freshPool();

  const treeId = await newTree(pool, 'the Nyamhunga family');
  const otherId = await newTree(pool, 'the Moyo family');

  // ── what a passcode is ───────────────────────────────────────────────────
  section('a passcode says which family it is for, and proves it separately');

  const issued = await access.issuePasscode(pool, treeId, { by: 'keeper' });
  check('it is issued once, in full', typeof issued.passcode === 'string');
  check('it starts with the family\'s handle',
        issued.passcode.startsWith(issued.handle + '-'),
        `got ${issued.passcode}`);
  eq('and is three groups', issued.passcode.split('-').length, 3);

  const stored = await pool.query('SELECT passcode_hash FROM trees WHERE id = $1', [treeId]);
  check('the passcode itself is NOT in the database',
        !stored.rows[0].passcode_hash.includes(issued.passcode.split('-').slice(1).join('-')));
  check('what is stored is a scrypt hash',
        stored.rows[0].passcode_hash.startsWith('scrypt$'));

  check('it checks out against the hash',
        await access.checkPasscode(issued.passcode, stored.rows[0].passcode_hash));
  check('one character wrong does not',
        !await access.checkPasscode(issued.passcode.slice(0, -1) + 'x',
                                    stored.rows[0].passcode_hash));
  check('a phone\'s trailing space is not a wrong passcode',
        await access.checkPasscode(issued.passcode + ' ', stored.rows[0].passcode_hash));
  check('nor is a phone capitalising the first letter',
        await access.checkPasscode(
          issued.passcode[0].toUpperCase() + issued.passcode.slice(1),
          stored.rows[0].passcode_hash));

  section('the alphabet leaves out the characters people misread');
  const bad = [...'01OIl'];
  check('no 0, O, 1, I or l anywhere in a passcode',
        !bad.some(c => issued.passcode.includes(c)), issued.passcode);

  // ── signing in ───────────────────────────────────────────────────────────
  section('signing in');

  const ok = await access.signIn(pool, issued.passcode, { ip: '41.0.0.1', actor: 'Rufaro' });
  check('the right passcode opens the family', ok.ok === true);
  eq('and names the family it opened', ok.treeId, treeId);

  const wrong = await access.signIn(pool, issued.passcode.slice(0, -2) + 'zz', {});
  eq('a wrong secret is refused', wrong.ok, false);
  eq('and the reason is kept for the record only', wrong.reason, 'wrong');

  const nobody = await access.signIn(pool, 'zzzzzz-aaaaaa-bbbbbb', {});
  eq('a handle that does not exist is refused', nobody.ok, false);
  eq('with a reason that is NOT shown to anybody', nobody.reason, 'no_family');

  const shapeless = await access.signIn(pool, 'nodashes', {});
  eq('and something that is not a passcode at all', shapeless.reason, 'malformed');

  section('one family\'s passcode does not open another');
  const otherIssued = await access.issuePasscode(pool, otherId, { by: 'keeper' });
  const crossed = await access.signIn(pool, otherIssued.passcode, {});
  eq('it opens its own family', crossed.treeId, otherId);
  check('which is not the first family', crossed.treeId !== treeId);
  // The handle is half the passcode, so this is the mistake worth checking:
  // the first family's handle with the second family's secret.
  const frankenstein = await access.signIn(pool,
    issued.handle + '-' + otherIssued.passcode.split('-').slice(1).join('-'), {});
  eq('and a handle from one with a secret from the other opens nothing',
     frankenstein.ok, false);

  /* THE ENUMERATION LEAK, measured rather than reasoned about.

     The handle is in the clear, so if an unknown handle were refused faster
     than a known one with a wrong secret, the response time would say which
     families exist on this deployment. signIn does the scrypt work either way;
     this is the assertion that it really does.

     Timing on a shared machine is noisy, so this compares medians over several
     runs and allows a wide margin — it is looking for the difference between
     "did the work" and "returned immediately", which is milliseconds against
     roughly a tenth of a second, not for a subtle side channel. */
  section('an unknown family does not answer faster than a wrong passcode');
  const median = async fn => {
    const runs = [];
    for (let i = 0; i < 5; i++) {
      const t = process.hrtime.bigint();
      await fn();
      runs.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    return runs.sort((a, b) => a - b)[2];
  };
  const missTime = await median(() => access.signIn(pool, 'zzzzzz-aaaaaa-bbbbbb', {}));
  const wrongTime = await median(() =>
    access.signIn(pool, issued.passcode.slice(0, -2) + 'zz', {}));
  check(`an unknown handle costs about as much as a wrong secret ` +
        `(${missTime.toFixed(0)}ms vs ${wrongTime.toFixed(0)}ms)`,
        missTime > wrongTime * 0.4,
        'an unknown handle returning early would leak which families exist');

  // ── sessions ─────────────────────────────────────────────────────────────
  section('a session is a cookie the database cannot hand back');

  const genOf = async id => (await pool.query(
    'SELECT passcode_gen FROM trees WHERE id = $1', [id])).rows[0].passcode_gen;

  const s = await access.createSession(pool, {
    scope: 'family', treeId, via: 'passcode', actor: 'Rufaro', ip: '41.0.0.1',
    passcodeGen: await genOf(treeId) });
  const [sid, rawToken] = [s.cookie.slice(0, 36), s.cookie.slice(37)];

  const row = await pool.query('SELECT token_hash FROM sessions WHERE id = $1', [sid]);
  check('the token is not stored', !row.rows[0].token_hash.includes(rawToken));

  const read = await access.readSession(pool, s.cookie);
  eq('the cookie resolves to the family', read.treeId, treeId);
  eq('a right id with a wrong token resolves to nothing',
     await access.readSession(pool, sid + '.' + 'x'.repeat(43)), null);
  eq('and so does something shaped like nothing',
     await access.readSession(pool, 'rubbish'), null);

  section('a session opened under an older passcode is not a session');
  const stale = await access.createSession(pool, {
    scope: 'family', treeId, via: 'passcode', passcodeGen: (await genOf(treeId)) - 1 });
  eq('it resolves to nothing', await access.readSession(pool, stale.cookie), null);

  section('ending a session ends it at once');
  await access.revokeSession(pool, sid, 'keeper');
  eq('the cookie no longer resolves', await access.readSession(pool, s.cookie), null);

  section('a new passcode ends every session the family had');
  const before = await access.createSession(pool, {
    scope: 'family', treeId, via: 'passcode', passcodeGen: await genOf(treeId) });
  check('it works to begin with', !!await access.readSession(pool, before.cookie));

  const reissued = await access.issuePasscode(pool, treeId, { by: 'keeper' });
  access.forgetTree(treeId);
  eq('after a reset it does not', await access.readSession(pool, before.cookie), null);
  eq('the old passcode is refused',
     (await access.signIn(pool, issued.passcode, {})).ok, false);
  eq('and the new one is not',
     (await access.signIn(pool, reissued.passcode, {})).ok, true);

  section('a closed family\'s sessions stop, and start again when it is reopened');
  const live = await access.createSession(pool, {
    scope: 'family', treeId, via: 'passcode',
    passcodeGen: reissued.passcode_gen });
  check('open to begin with', !!await access.readSession(pool, live.cookie));
  await pool.query(`UPDATE trees SET suspended_at = clock_timestamp() WHERE id = $1`, [treeId]);
  access.forgetTree(treeId);
  eq('closed', await access.readSession(pool, live.cookie), null);
  await pool.query(`UPDATE trees SET suspended_at = NULL WHERE id = $1`, [treeId]);
  access.forgetTree(treeId);
  check('and open again — suspension is a door, not a bonfire',
        !!await access.readSession(pool, live.cookie));

  // ── invitations ──────────────────────────────────────────────────────────
  section('an invitation lets one relative in without giving away the passcode');

  const inv = await access.createInvite(pool, treeId, { by: 'Rufaro', note: 'for Tete' });
  const invRow = await pool.query('SELECT token_hash FROM invites WHERE id = $1', [inv.id]);
  check('the token is not stored either', !invRow.rows[0].token_hash.includes(inv.token));

  const taken = await access.acceptInvite(pool, inv.token, { actor: 'Tete Ratidzo' });
  eq('it opens the family', taken.ok, true);
  eq('the right one', taken.treeId, treeId);

  const again = await access.acceptInvite(pool, inv.token, {});
  eq('a single-use invitation cannot be used twice', again.ok, false);
  eq('with no hint about why beyond that it cannot be used', again.reason, 'not_usable');

  section('a withdrawn invitation stops working');
  const inv2 = await access.createInvite(pool, treeId, { by: 'Rufaro' });
  await access.revokeInvite(pool, inv2.id, { treeId, by: 'Rufaro' });
  eq('withdrawn', (await access.acceptInvite(pool, inv2.token, {})).ok, false);

  section('an invitation belonging to another family cannot be withdrawn by id');
  const theirs = await access.createInvite(pool, otherId, { by: 'somebody else' });
  eq('not withdrawable from the wrong family',
     await access.revokeInvite(pool, theirs.id, { treeId, by: 'Rufaro' }), null);
  check('and it still works', (await access.acceptInvite(pool, theirs.token, {})).ok);

  section('an expired invitation stops working');
  const inv3 = await access.createInvite(pool, treeId, { by: 'Rufaro' });
  await pool.query(
    `UPDATE invites SET expires_at = clock_timestamp() - interval '1 day' WHERE id = $1`,
    [inv3.id]);
  eq('out of time', (await access.acceptInvite(pool, inv3.token, {})).ok, false);

  /* TWO RELATIVES OPENING THE SAME LINK AT THE SAME MOMENT.

     A single-use invitation checked in one statement and consumed in another
     lets both through: each reads uses=0 before either writes uses=1. The
     check and the increment are one UPDATE precisely so that they cannot, and
     this is the assertion that they cannot — which only means anything if the
     two really do overlap, so they are started together. */
  section('two people opening the same single-use link at once');
  const raced = await access.createInvite(pool, treeId, { by: 'Rufaro' });
  const [a, b] = await Promise.all([
    access.acceptInvite(pool, raced.token, { actor: 'first' }),
    access.acceptInvite(pool, raced.token, { actor: 'second' })
  ]);
  eq('exactly one of them gets in', [a.ok, b.ok].filter(Boolean).length, 1);

  section('an invitation for a closed family does not open it');
  const inv4 = await access.createInvite(pool, treeId, { by: 'Rufaro' });
  await pool.query(`UPDATE trees SET suspended_at = clock_timestamp() WHERE id = $1`, [treeId]);
  const refused = await access.acceptInvite(pool, inv4.token, {});
  eq('refused', refused.ok, false);
  eq('and says so plainly rather than pretending it never existed',
     refused.reason, 'suspended');
  await pool.query(`UPDATE trees SET suspended_at = NULL WHERE id = $1`, [treeId]);

  section('an invitation with more than one use runs out rather than going on');
  const shared = await access.createInvite(pool, treeId, { by: 'Rufaro', uses: 3 });
  const results = [];
  for (let i = 0; i < 4; i++) results.push((await access.acceptInvite(pool, shared.token, {})).ok);
  eq('three in, the fourth refused', results, [true, true, true, false]);

  await pool.end();
  report();
})();
