// pgpool-lite.js — ext/shacl: minimal PG pool (the ext is a standalone package,
// it does not depend on the core's internal libs). Admin role: boot + admin endpoint (DDL).
const { Pool } = require('pg');

function createPool(config) {
  if (config.pgDsn) {
    return new Pool({ connectionString: config.pgDsn, max: parseInt(config.pgPoolMax || '2', 10) });
  }
  return new Pool({
    host: config.pgHost || '127.0.0.1',
    port: parseInt(config.pgPort || '5432', 10),
    database: config.pgDatabase || 'postgres',
    user: config.pgUser || 'admin',
    password: config.pgPassword || '',
    max: parseInt(config.pgPoolMax || '2', 10)
  });
}

module.exports = { createPool };
