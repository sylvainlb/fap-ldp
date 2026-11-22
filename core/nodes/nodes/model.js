// model.js — fap-ldp-model node: applies the deployment's business model at boot.
// Reads config/model.json (e.g. examples/supervision/model.json) and, idempotently:
//   1. creates the app.<table> tables + triggers (updated_at, versioning, tombstone, outbox);
//   2. sets FORCE ROW LEVEL SECURITY + read/write policies via auth.can();
//   3. records the container mapping in dsp.asset_mapping (published if published: true);
// The core (core/sql) stays generic: no hard-coded business model.
// Connection: admin role (boot = migration), NOT the runtime app/reader role.
const fs = require('fs');
const { createPool } = require('../lib/pgpool');

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
        await createTable(table, spec);
        await createTriggers(table, spec);
        await createRls(table, spec, baseIri, model);
        await registerMapping(table, spec, baseIri, model);
      }
      node.log('fap-ldp: model applied: ' + Object.keys(model.tables || {}).join(', ')); // marker grepped by compose/deploy.sh
    }

    // "bigint fk buildings(id)" → "bigint REFERENCES buildings(id)";
    // "text check in ('a','b')" → "text CHECK (<name> IN ('a','b'))";
    // "text (comment)" → "text"; anything else passes through as-is.
    function fieldToSql(name, def) {
      let d = def.trim();
      const chk = d.match(/^(.*?)\bcheck\s+in\s*(\(.*\))$/i);
      if (chk) return `${chk[1].trim()} CHECK (${name} IN ${chk[2]})`;
      const fk = d.match(/^(\S+)\s+\bfk\s+(\w+)\((\w+)\)$/i);
      if (fk) return `${fk[1]} REFERENCES app.${fk[2]}(${fk[3]})`;
      d = d.replace(/ \([^)]*\)\s*$/, ''); // trailing comment (space before the parenthesis); now() kept
      return d;
    }

    async function createTable(table, spec) {
      const cols = Object.entries(spec.fields || {}).map(([name, def]) => {
        const sql = fieldToSql(name, def);
        return name === spec.pk ? `${name} ${sql} PRIMARY KEY` : `${name} ${sql}`;
      });
      const q = `CREATE TABLE IF NOT EXISTS app.${table} (${cols.join(', ')})`;
      await node.pool.query(q);
      await node.pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON app.${table} TO app;
                             GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO app;`);
    }

    async function createTriggers(table, spec) {
      const has = (f) => spec.fields && spec.fields[f];
      const stmts = [];
      if (has('updated_at')) stmts.push(
        `CREATE TRIGGER set_updated_at BEFORE INSERT OR UPDATE ON app.${table}
         FOR EACH ROW EXECUTE FUNCTION app.set_updated_at()`);
      stmts.push(
        `CREATE TRIGGER versioning AFTER INSERT OR UPDATE ON app.${table}
         FOR EACH ROW EXECUTE FUNCTION app.version_trigger()`);
      if (spec.tombstone) stmts.push(
        `CREATE TRIGGER tombstone AFTER UPDATE ON app.${table}
         FOR EACH ROW EXECUTE FUNCTION app.tombstone_trigger()`);
      stmts.push(
        `CREATE TRIGGER outbox AFTER INSERT OR UPDATE ON app.${table}
         FOR EACH ROW EXECUTE FUNCTION app.outbox_trigger()`);
      for (const s of stmts) {
        await node.pool.query(`DROP TRIGGER IF EXISTS ${s.match(/CREATE TRIGGER (\w+)/)[1]} ON app.${table}`);
        await node.pool.query(s);
      }
    }

    function iriExpr(table, spec, model) {
      // EXPLICIT nesting: spec.parent + spec.parent_fk (e.g. comments: parent=tickets, parent_fk=ticket_id)
      // → nested IRI /<parent>/<parent_fk>/<table>/<pk>; otherwise flat container /<table>/
      if (spec.parent && spec.parent_fk) {
        const parent = spec.parent, fkField = spec.parent_fk;
        return {
          container: `/${parent}/*/${table}/`,
          pattern: `/${parent}/<${fkField}>/${table}/<${spec.pk}>`,
          expr: `rtrim(current_setting('app.base_iri', true), '/') || '/${parent}/' || ${fkField}::text || '/${table}/' || ${spec.pk}::text`,
          insertExpr: `rtrim(current_setting('app.base_iri', true), '/') || '/${parent}/' || ${fkField}::text`,
          where: `${fkField} = $1 AND ${spec.pk} = $2`
        };
      }
      return {
        container: `/${table}/`,
        pattern: `/${table}/<${spec.pk}>`,
        expr: `rtrim(current_setting('app.base_iri', true), '/') || '/${table}/' || ${spec.pk}::text`,
        insertExpr: `rtrim(current_setting('app.base_iri', true), '/') || '/${table}/'`,
        where: `${spec.pk} = $1`
      };
    }

    async function createRls(table, spec, baseIri, model) {
      const iri = iriExpr(table, spec, model);
      const containerIri = iri.insertExpr;
      const q = `
        ALTER TABLE app.${table} ENABLE ROW LEVEL SECURITY;
        ALTER TABLE app.${table} FORCE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS ${table}_read ON app.${table};
        CREATE POLICY ${table}_read ON app.${table} FOR SELECT
          USING (auth.can(${iri.expr}, 'read'));
        DROP POLICY IF EXISTS ${table}_insert ON app.${table};
        CREATE POLICY ${table}_insert ON app.${table} FOR INSERT
          WITH CHECK (auth.can(${containerIri}, 'write'));
        DROP POLICY IF EXISTS ${table}_write ON app.${table};
        CREATE POLICY ${table}_write ON app.${table} FOR UPDATE
          USING (auth.can(${iri.expr}, 'write')) WITH CHECK (auth.can(${iri.expr}, 'write'));
        DROP POLICY IF EXISTS ${table}_delete ON app.${table};
        CREATE POLICY ${table}_delete ON app.${table} FOR DELETE
          USING (auth.can(${iri.expr}, 'write'));`;
      await node.pool.query(q);
    }

    async function registerMapping(table, spec, baseIri, model) {
      const iri = iriExpr(table, spec, model);
      await node.pool.query(
        `INSERT INTO dsp.asset_mapping (asset_uri, container_uri, table_schema, table_name, resource_iri_pattern, published)
         VALUES ($1, $2, 'app', $3, $4, $5)
         ON CONFLICT (asset_uri) DO UPDATE SET container_uri = $2, resource_iri_pattern = $4, published = $5`,
        [iri.container, iri.container, table, iri.pattern, !!spec.published]);
    }
  }

  RED.nodes.registerType('fap-ldp-model', ModelNode);
};
