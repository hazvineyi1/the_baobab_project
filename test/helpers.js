// Minimal test harness. No framework — the app has two runtime dependencies
// and it is worth keeping it that way.

const { createPool } = require('../db/pool');
const { migrate } = require('../db/migrate');

const TEST_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

let passed = 0, failed = 0;
const failures = [];

function check(label, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok    ${label}`); }
  else { failed++; failures.push(label); console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`); }
  return cond;
}

const eq = (label, actual, expected) =>
  check(label, JSON.stringify(actual) === JSON.stringify(expected),
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

// Assert that a call fails, and how.
async function rejects(label, fn, { status, code } = {}) {
  try {
    await fn();
    return check(label, false, 'expected a rejection, but it succeeded');
  } catch (e) {
    if (status && e.status !== status) return check(label, false, `expected status ${status}, got ${e.status ?? '(none)'}: ${e.message}`);
    if (code && e.code !== code) return check(label, false, `expected code ${code}, got ${e.code ?? '(none)'}: ${e.message}`);
    return check(label, true);
  }
}

function section(name) { console.log(`\n${name}`); }

async function freshPool() {
  if (!TEST_URL) {
    console.error('TEST_DATABASE_URL (or DATABASE_URL) must be set to run the tests.');
    process.exit(2);
  }
  const pool = createPool(TEST_URL);
  await migrate(pool, () => {});
  return pool;
}

async function newTree(pool, name = 'test') {
  const { rows } = await pool.query('INSERT INTO trees (name) VALUES ($1) RETURNING id', [name]);
  return rows[0].id;
}

function report() {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('failures:'); failures.forEach(f => console.log(`  - ${f}`)); }
  process.exit(failed ? 1 : 0);
}

module.exports = { check, eq, rejects, section, freshPool, newTree, report };
