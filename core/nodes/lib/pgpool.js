// pgpool.js — pool PG par rôle + helper de session PEP.
// Le PEP ouvre une transaction, pose le contexte (SET LOCAL app.webid / app.role / app.base_iri)
// depuis les claims du token, exécute la requête (RLS filtre alors les lignes), commit.
const { Pool } = require('pg');

function createPool(config) {
  // DSN prioritaire (compose fournit PG_*_DSN) : postgres://user:pass@host:port/db
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

// Exécute fn(client) dans une transaction avec le contexte de session posé.
async function withSession(pool, claims, baseIri, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // set_config accepte les paramètres ($1), contrairement à SET LOCAL x = $1
    await client.query("SELECT set_config('app.base_iri', $1, true)", [baseIri]);
    // externe sans webid : le DID fait office de sujet ACL
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
