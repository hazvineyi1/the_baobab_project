// Runs every test file in sequence against TEST_DATABASE_URL, each in its own
// freshly-created database so one suite cannot leak state into the next.
const { execFileSync } = require('child_process');
const { Client } = require('pg');
const path = require('path');

const FILES = ['gate.test.js', 'ops.test.js', 'concurrency.test.js', 'reads.test.js',
               'duplicates.test.js', 'parity.test.js', 'kinship.test.js', 'totems.test.js', 'palettes.test.js',
               'frontier.test.js', 'setaside.test.js', 'setaside.frontend.test.js', 'migration.test.js', 'migrate-runner.test.js', 'hometree.test.js', 'familykeys.test.js', 'crosstree.test.js', 'scale.test.js'];
const fs = require('fs');

(async () => {
  const admin = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!admin) { console.error('Set TEST_DATABASE_URL'); process.exit(2); }
  let failed = 0;
  for (const f of FILES) {
    if (!fs.existsSync(path.join(__dirname, f))) continue;
    const dbName = 'muti_t_' + f.replace(/\W/g, '_').slice(0, 30);
    const url = new URL(admin);
    const root = new Client({ connectionString: new URL('/postgres', url).href.replace(url.pathname, '/postgres') });
    try {
      await root.connect();
      await root.query(`DROP DATABASE IF EXISTS ${dbName}`);
      await root.query(`CREATE DATABASE ${dbName}`);
      await root.end();
    } catch (e) { console.error(`could not prepare ${dbName}: ${e.message}`); process.exit(2); }
    const target = new URL(admin); target.pathname = '/' + dbName;
    console.log(`\n${'='.repeat(60)}\n${f}\n${'='.repeat(60)}`);
    try {
      execFileSync(process.execPath, [path.join(__dirname, f)],
        { stdio: 'inherit', env: { ...process.env, TEST_DATABASE_URL: target.href } });
    } catch { failed++; }
  }
  console.log(`\n${'='.repeat(60)}`);
  console.log(failed ? `${failed} suite(s) FAILED` : 'all suites passed');
  process.exit(failed ? 1 : 0);
})();
