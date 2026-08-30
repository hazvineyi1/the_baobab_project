#!/usr/bin/env node
// `npm run migrate` — applies schema migrations only. The DATA migration
// (moving the family tree out of the kv_store blob) is a separate, deliberate
// step: scripts/migrate-data.js
const { createPool } = require('../db/pool');
const { migrate } = require('../db/migrate');
(async () => {
  const pool = createPool();
  if (!pool) { console.error('DATABASE_URL is not set'); process.exit(2); }
  await migrate(pool);
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
