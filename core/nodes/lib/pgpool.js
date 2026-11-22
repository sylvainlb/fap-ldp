// pgpool.js — per-role PG pool + PEP session helper.
// The PEP opens a transaction, sets the context (SET LOCAL app.webid / app.role / app.base_iri)
// from the token claims, runs the query (RLS then filters the rows), commits.
const { Pool } = require('pg');

function createPool(config) {
  // DSN takes priority (compose provides PG_*_DSN): postgres://user:pass@host:port/db
  if (config.pgDsn) {
    return new Pool({ connectionString: config.pgDsn, max: parseInt(config.pgPoolMax || '5', 10) });
  }
  return new Pool({
    host: config.pgHost || '127.0.0.1',
    port: parseInt(config.pgPort || '5432', 10),
    database: config.pgDatabase || 'postgres',
    user: config.pgUser || 'app',
    password: config.pgPassword || '',
    max: parseInt(config.pgPoolMax || '5', 10)
  });
}

// Runs fn(client) inside a transaction with the session context set.
async function withSession(pool, claims, baseIri, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // set_config accepts parameters ($1), unlike SET LOCAL x = $1
    await client.query("SELECT set_config('app.base_iri', $1, true)", [baseIri]);
    // external without webid: the DID acts as the ACL subject
    const webid = claims.webid || claims.did;
    if (webid) await client.query("SELECT set_config('app.webid', $1, true)", [webid]);
    if (claims.role) await client.query("SELECT set_config('app.role', $1, true)", [claims.role]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { createPool, withSession };
