// model.js — fap-ldp-model node: applies the deployment's business model at boot.
// Reads config/model.json (e.g. examples/supervision/model.json) and, idempotently:
//   1. creates the app.<table> tables + triggers (updated_at, versioning, tombstone, outbox);
//   2. sets FORCE ROW LEVEL SECURITY + read/write policies via auth.can();
//   3. records the container mapping in dsp.asset_mapping (published if published: true).
// The core (core/sql) stays generic: no hard-coded business model.
// The DDL builders live in ../lib/core-model.js (shared with ext/model-injection POST /admin/model,
// which applies the SAME conventions at runtime, hot).
// Connection: admin role (boot = migration), NOT the runtime app/reader role.
const fs = require('fs');
const { createPool } = require('../lib/pgpool');
const coreModel = require('../lib/core-model');

module.exports = function (RED) {
  function ModelNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.name = config.name;
    node.modelPath = config.modelPath || '/data/config/model.json';
    node.pool = createPool(config); // admin role at boot

    node.on('close', async () => { await node.pool.end().catch(() => {}); });

    applyModel().catch(e => node.error('boot model failed: ' + (e.stack || e.message)));

    async function applyModel() {
      const model = JSON.parse(fs.readFileSync(node.modelPath, 'utf8'));
      const baseIri = (model.base_iri || 'http://localhost:1880/').replace(/\/?$/, '/');
      // Tables created at boot belong to the admin role (boot): delegate to the runtime app role
      await node.pool.query(`
        ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app;
        ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT USAGE, SELECT ON SEQUENCES TO app;`);
      for (const [table, spec] of Object.entries(model.tables || {})) {
        for (const s of coreModel.createTableStatements(table, spec)) await node.pool.query(s);
        for (const s of coreModel.createTriggerStatements(table, spec)) await node.pool.query(s);
        for (const s of coreModel.rlsStatements(table, spec, model)) await node.pool.query(s);
        await coreModel.registerMapping(node.pool, table, spec, baseIri, model);
      }
      node.log('fap-ldp: model applied: ' + Object.keys(model.tables || {}).join(', ')); // marker grepped by compose/deploy.sh
    }
  }

  RED.nodes.registerType('fap-ldp-model', ModelNode);
};
