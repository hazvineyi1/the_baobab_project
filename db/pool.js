// Shared Postgres pool.
//
// SSL is decided by the host, not hardcoded. Railway's Postgres terminates TLS
// with a certificate that does not chain to a public root, so the deployed app
// needs rejectUnauthorized:false — but applying that unconditionally makes the
// app impossible to run against a local cluster (which speaks no TLS at all)
// and silently weakens any host that does present a real certificate.
//
// Rule: local/socket connections get no SSL, everything else gets SSL. Override
// with PGSSLMODE=disable or PGSSLMODE=require when the guess is wrong.

const { Pool } = require('pg');

function sslFor(connectionString) {
  const mode = process.env.PGSSLMODE;
  if (mode === 'disable') return false;
  if (mode === 'require' || mode === 'no-verify') return { rejectUnauthorized: false };

  try {
    const host = new URL(connectionString).hostname;
    if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
  } catch {
    return false; // socket path or otherwise unparseable — assume local
  }
  return { rejectUnauthorized: false };
}

function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) return null;
  return new Pool({
    connectionString,
    ssl: sslFor(connectionString),
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: 30_000
  });
}

module.exports = { createPool, sslFor };
