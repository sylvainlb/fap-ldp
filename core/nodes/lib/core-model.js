// core-model.js — builders of the CORE business-model DDL, extracted from nodes/model.js so
// that ext/model-injection (POST /admin/model, hot additive patch of the core model) reuses the
// EXACT same conventions at runtime: app.<table> (bare names), base triggers, FORCE RLS via
// auth.can(), dsp.asset_mapping, initial ACLs (façon sql/102_acl_init.sql of the deployments).
// Pure statement builders (no I/O) + registerMapping (parameterized executor).
// All identifiers go through quoteIdent(); literals through quoteLiteral() → no SQL injection.
function quoteIdent(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }
function quoteLiteral(v) { return "'" + String(v).replace(/'/g, "''") + "'"; }

// "bigint fk buildings(id)" → "bigint REFERENCES app.buildings(id)";
// "text check in ('a','b')" → "text CHECK ("name" IN ('a','b'))";
// "text (comment)" → "text"; anything else passes through as-is.
function fieldToSql(name, def) {
  if (def && typeof def === 'object') {
    // structured (annexe A) field — same generation as ext/model-injection fragment.js columnSql
    const PG_TYPES = { text: 'text', bigint: 'bigint', numeric: 'numeric', boolean: 'boolean', timestamptz: 'timestamptz', jsonb: 'jsonb' };
    let d = def.serial ? 'bigserial' : (PG_TYPES[def.type] || def.type);
    if (def.not_null) d += ' NOT NULL';
    if (def.unique) d += ' UNIQUE';
    if (def.default !== undefined) d += ' DEFAULT ' + defaultSql(def.default);
    if (def.check_in) d += ` CHECK (${quoteIdent(name)} IN (${def.check_in.map(quoteLiteral).join(', ')}))`;
    if (def.fk) d += ` REFERENCES app.${quoteIdent(def.fk)}(${quoteIdent('id')})`;
    return d;
  }
  let d = String(def ?? '').trim();
  const chk = d.match(/^(.*?)\bcheck\s+in\s*(\(.*\))$/i);
  if (chk) return `${chk[1].trim()} CHECK (${quoteIdent(name)} IN ${chk[2]})`;
  const fk = d.match(/^(\S+)\s+\bfk\s+(\w+)\((\w+)\)$/i);
  if (fk) return `${fk[1]} REFERENCES app.${quoteIdent(fk[2])}(${quoteIdent(fk[3])})`;
  d = d.replace(/ \([^)]*\)\s*$/, ''); // trailing comment (space before the parenthesis); now() kept
  return d;
}

// safe default literal (same rule as ext/model-injection §4.6)
function defaultSql(d) {
  if (typeof d === 'number') return String(d);
  if (typeof d === 'boolean') return d ? 'true' : 'false';
  if (['now()', 'true', 'false'].includes(String(d))) return String(d);
  return quoteLiteral(d);
}

// container / resource IRI pattern of a core table (flat /<table>/, or nested
// /<parent>/<parent_fk>/<container_name>/ when spec.parent + spec.parent_fk are set)
function iriExpr(table, spec) {
  if (spec.parent && spec.parent_fk) {
    const parent = spec.parent, fkField = spec.parent_fk;
    const cname = spec.container_name ?? table;
    return {
      container: `/${parent}/*/${cname}/`,
      pattern: `/${parent}/<${fkField}>/${cname}/<${spec.pk}>`,
      expr: `rtrim(current_setting('app.base_iri', true), '/') || '/${parent}/' || ${quoteIdent(fkField)}::text || '/${cname}/' || ${quoteIdent(spec.pk)}::text`,
      insertExpr: spec.container_name
        ? `rtrim(current_setting('app.base_iri', true), '/') || '/${parent}/' || ${quoteIdent(fkField)}::text || '/${cname}/'`
        : `rtrim(current_setting('app.base_iri', true), '/') || '/${parent}/' || ${quoteIdent(fkField)}::text`,
      where: `${quoteIdent(fkField)} = $1 AND ${quoteIdent(spec.pk)} = $2`
    };
  }
  return {
    container: `/${table}/`,
    pattern: `/${table}/<${spec.pk}>`,
    expr: `rtrim(current_setting('app.base_iri', true), '/') || '/${table}/' || ${quoteIdent(spec.pk)}::text`,
    insertExpr: `rtrim(current_setting('app.base_iri', true), '/') || '/${table}/'`,
    where: `${quoteIdent(spec.pk)} = $1`
  };
}

function createTableStatements(table, spec) {
  const cols = Object.entries(spec.fields || {}).map(([name, def]) => {
    const sql = fieldToSql(name, def);
    return name === spec.pk ? `${quoteIdent(name)} ${sql} PRIMARY KEY` : `${quoteIdent(name)} ${sql}`;
  });
  if (Array.isArray(spec.unique)) {
    for (const u of spec.unique) cols.push(`UNIQUE (${u.map(quoteIdent).join(', ')})`);
  }
  const q = `app.${quoteIdent(table)}`;
  return [
    `CREATE TABLE IF NOT EXISTS ${q} (${cols.join(', ')})`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ${q} TO app`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO app`
  ];
}

// base generic triggers of the socle (same whitelist as at boot): set_updated_at when the
// column exists, versioning + outbox always, tombstone when spec.tombstone is set.
function createTriggerStatements(table, spec) {
  const has = (f) => spec.fields && spec.fields[f];
  const q = `app.${quoteIdent(table)}`;
  const defs = [];
  if (has('updated_at')) defs.push(['set_updated_at',
    `CREATE TRIGGER set_updated_at BEFORE INSERT OR UPDATE ON ${q} FOR EACH ROW EXECUTE FUNCTION app.set_updated_at()`]);
  defs.push(['versioning',
    `CREATE TRIGGER versioning AFTER INSERT OR UPDATE ON ${q} FOR EACH ROW EXECUTE FUNCTION app.version_trigger()`]);
  if (spec.tombstone) defs.push(['tombstone',
    `CREATE TRIGGER tombstone AFTER UPDATE ON ${q} FOR EACH ROW EXECUTE FUNCTION app.tombstone_trigger()`]);
  defs.push(['outbox',
    `CREATE TRIGGER outbox AFTER INSERT OR UPDATE ON ${q} FOR EACH ROW EXECUTE FUNCTION app.outbox_trigger()`]);
  const out = [];
  for (const [name, create] of defs) {
    out.push(`DROP TRIGGER IF EXISTS ${name} ON ${q}`);
    out.push(create);
  }
  return out;
}

function rlsStatements(table, spec) {
  const iri = iriExpr(table, spec);
  const q = `app.${quoteIdent(table)}`;
  return [
    `ALTER TABLE ${q} ENABLE ROW LEVEL SECURITY`,
    `ALTER TABLE ${q} FORCE ROW LEVEL SECURITY`,
    `DROP POLICY IF EXISTS ${table}_read ON ${q}`,
    `CREATE POLICY ${table}_read ON ${q} FOR SELECT USING (auth.can(${iri.expr}, 'read'))`,
    `DROP POLICY IF EXISTS ${table}_insert ON ${q}`,
    `CREATE POLICY ${table}_insert ON ${q} FOR INSERT WITH CHECK (auth.can(${iri.insertExpr}, 'write'))`,
    `DROP POLICY IF EXISTS ${table}_write ON ${q}`,
    `CREATE POLICY ${table}_write ON ${q} FOR UPDATE USING (auth.can(${iri.expr}, 'write')) WITH CHECK (auth.can(${iri.expr}, 'write'))`,
    `DROP POLICY IF EXISTS ${table}_delete ON ${q}`,
    `CREATE POLICY ${table}_delete ON ${q} FOR DELETE USING (auth.can(${iri.expr}, 'write'))`
  ];
}

// dsp.asset_mapping: 1 DSP asset = 1 LDP container (idempotent upsert)
async function registerMapping(client, table, spec, baseIri, model) {
  const iri = iriExpr(table, spec, model);
  await client.query(
    `INSERT INTO dsp.asset_mapping (asset_uri, container_uri, table_schema, table_name, resource_iri_pattern, published)
     VALUES ($1, $2, 'app', $3, $4, $5)
     ON CONFLICT (asset_uri) DO UPDATE SET container_uri = $2, resource_iri_pattern = $4, published = $5`,
    [iri.container, iri.container, table, iri.pattern, !!spec.published]);
}

// initial ACLs of a NEW core table, façon deployments' 102_acl_init.sql (INSERT … SELECT …
// WHERE NOT EXISTS, inherited on the container): admin full control; published → foaf:Agent read.
function aclRows(baseIri, table, spec) {
  const base = String(baseIri || 'http://localhost:1880/').replace(/\/?$/, '/');
  const container = base + table + '/';
  const rows = [[container, 'role:admin', '{read,write,append,control}', true]];
  if (spec.published) rows.push([container, 'foaf:Agent', '{read}', true]);
  return rows;
}

async function insertAcl(client, rows) {
  for (const [res, subject, modes, inherited] of rows) {
    await client.query(
      `INSERT INTO auth.acl (resource_uri, subject, modes, inherited)
       SELECT $1, $2, $3, $4
       WHERE NOT EXISTS (SELECT 1 FROM auth.acl WHERE resource_uri = $1 AND subject = $2)`,
      [res, subject, modes, inherited]);
  }
}

module.exports = {
  quoteIdent, quoteLiteral, fieldToSql, defaultSql, iriExpr,
  createTableStatements, createTriggerStatements, rlsStatements,
  registerMapping, aclRows, insertAcl
};
