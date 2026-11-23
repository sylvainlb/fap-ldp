// fragment.js — ext/model-injection (E11): validation, canonicalization and DDL compilation
// of the declarative model fragment (annex A of atlas/spec/model-injection-spec.md v0.3).
// Pure and dependency-free (testable outside Node-RED): every name goes through quoteIdent(),
// every literal value through quoteLiteral() → no SQL injection possible (§4.2/§4.6).
const crypto = require('crypto');

const SLUG_RE = /^[a-z][a-z0-9_]{1,30}$/;
const NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;
const TYPES = ['text', 'bigint', 'numeric', 'boolean', 'timestamptz', 'jsonb'];
const PG_TYPES = { text: 'text', bigint: 'bigint', numeric: 'numeric', boolean: 'boolean', timestamptz: 'timestamptz', jsonb: 'jsonb' };
const SAFE_DEFAULT_EXPRS = new Set(['now()', 'true', 'false']); // §4.6: anything else goes through quote_literal
const TABLE_KEYS = new Set(['pk', 'owner', 'published', 'tombstone', 'outbox', 'fields',
  // v0.4 (app-shape-editor rev 4, J1): contract-only keys, no DDL effect (compileFragment ignores them,
  // canonicalForCompare strips them → fragment_hash/drift unaffected)
  'align_class', 'label_i18n', 'contract_exclude']);
const FIELD_KEYS = new Set(['type', 'serial', 'not_null', 'unique', 'default', 'check_in', 'fk',
  // v0.4: semantic profile keys, consumed by ext/shacl only
  'node_kind', 'lang', 'align', 'label_i18n']);
const ROOT_KEYS = new Set(['tables', 'supersedes']); // v0.4: supersedes (R1.6) = "<slug>@<version>"
// v0.4/A.2: table names colliding with routes reserved by the core for ext/shacl + E11
const RESERVED_TABLES = new Set(['meta', 'shapes', 'validate', 'fragment']);
const IRI_RE = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/;   // full IRI or prefixed form (geo:lat, dcterms:description)
const LOCALE_RE = /^[a-z]{2}(-[A-Za-z0-9]{2,8})?$/;   // en, fr, en-US…
const SUPERSEDES_RE = /^[a-z][a-z0-9_]{1,30}@[^^\s]+$/; // "<slug>@<version>", version pinned without ^

const QUOTAS = {
  maxTables: 10,            // §4.5 quotas par package
  maxFieldsPerTable: 40,
  maxFieldsPerPackage: 200,
  maxPayloadBytes: 256 * 1024,
  maxCheckIn: 32
};

class FragmentError extends Error {
  constructor(code, message) { super(message); this.name = 'FragmentError'; this.code = code; }
}

// quote_ident / quote_literal (names are already regex-constrained, we quote anyway)
function quoteIdent(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }
function quoteLiteral(v) { return "'" + String(v).replace(/'/g, "''") + "'"; }

function physicalTable(slug, table) { return 'store_' + slug + '_' + table; }

// ---------- validation (annex A + §4 rules) ----------

// v0.4/R1.1: label_i18n = locales object, pivot "en" mandatory when the key is present
function validateLabelI18n(v, where) {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new FragmentError('schema_violation', `${where}: label_i18n must be an object of locales`);
  const keys = Object.keys(v);
  if (keys.length < 1) throw new FragmentError('schema_violation', `${where}: label_i18n empty`);
  if (!('en' in v)) throw new FragmentError('schema_violation', `${where}: label_i18n requires the pivot key "en" (R1.1)`);
  for (const k of keys) {
    if (!LOCALE_RE.test(k)) throw new FragmentError('schema_violation', `${where}: invalid locale key "${k}"`);
    if (typeof v[k] !== 'string' || !v[k]) throw new FragmentError('schema_violation', `${where}: label_i18n.${k} must be a non-empty string`);
  }
}

function validateFragment(fragment, rawBytes) {
  if (rawBytes !== undefined && rawBytes > QUOTAS.maxPayloadBytes)
    throw new FragmentError('quota_exceeded', `fragment payload > ${QUOTAS.maxPayloadBytes} bytes (§4.5)`);
  if (!fragment || typeof fragment !== 'object' || Array.isArray(fragment))
    throw new FragmentError('schema_violation', 'fragment: root object expected');
  for (const k of Object.keys(fragment))
    if (!ROOT_KEYS.has(k)) throw new FragmentError('schema_violation', `unauthorized root key: ${k}`);
  if (fragment.supersedes !== undefined &&
      (typeof fragment.supersedes !== 'string' || !SUPERSEDES_RE.test(fragment.supersedes)))
    throw new FragmentError('schema_violation', 'fragment.supersedes must be "<slug>@<version>" (R1.6)');
  const tables = fragment.tables;
  if (!tables || typeof tables !== 'object' || Array.isArray(tables))
    throw new FragmentError('schema_violation', 'fragment.tables: object required');
  const tableNames = Object.keys(tables);
  if (tableNames.length < 1) throw new FragmentError('schema_violation', 'fragment.tables: min 1 table');
  if (tableNames.length > QUOTAS.maxTables)
    throw new FragmentError('quota_exceeded', `> ${QUOTAS.maxTables} tables/package (§4.5)`);

  let totalFields = 0;
  for (const [tName, spec] of Object.entries(tables)) {
    if (!NAME_RE.test(tName)) throw new FragmentError('invalid_identifier', `table name outside regex: ${tName}`);
    if (RESERVED_TABLES.has(tName)) // v0.4/A.2: collides with a reserved route → 422 schema_violation
      throw new FragmentError('schema_violation', `table name reserved (A.2): ${tName}`);
    if (!spec || typeof spec !== 'object' || Array.isArray(spec))
      throw new FragmentError('schema_violation', `table ${tName}: object expected`);
    for (const k of Object.keys(spec))
      if (!TABLE_KEYS.has(k)) throw new FragmentError('schema_violation', `table ${tName}: unauthorized key ${k}`);
    if (typeof spec.pk !== 'string' || !NAME_RE.test(spec.pk))
      throw new FragmentError('invalid_identifier', `table ${tName}: invalid pk`);
    if (!spec.fields || typeof spec.fields !== 'object')
      throw new FragmentError('schema_violation', `table ${tName}: fields required`);

    // v1: the base generic triggers (app.version_trigger etc.) use NEW.id
    // → the pk of an injected table MUST be the "id" bigint serial column.
    if (spec.pk !== 'id')
      throw new FragmentError('schema_violation', `table ${tName}: pk must be "id" in v1 (base triggers)`);

    if (spec.owner !== undefined && spec.owner !== null) {
      if (!NAME_RE.test(spec.owner)) throw new FragmentError('invalid_identifier', `table ${tName}: invalid owner`);
    }
    if (spec.tombstone !== undefined && spec.tombstone !== null) {
      if (!NAME_RE.test(spec.tombstone)) throw new FragmentError('invalid_identifier', `table ${tName}: invalid tombstone`);
    }
    for (const b of ['published', 'outbox'])
      if (spec[b] !== undefined && typeof spec[b] !== 'boolean')
        throw new FragmentError('schema_violation', `table ${tName}: ${b} must be boolean`);
    // v0.4 table keys
    if (spec.align_class !== undefined &&
        (typeof spec.align_class !== 'string' || !IRI_RE.test(spec.align_class)))
      throw new FragmentError('schema_violation', `table ${tName}: align_class must be an IRI (or prefixed form)`);
    if (spec.label_i18n !== undefined) validateLabelI18n(spec.label_i18n, `table ${tName}`);
    if (spec.contract_exclude !== undefined) {
      if (!Array.isArray(spec.contract_exclude) || spec.contract_exclude.some(x => typeof x !== 'string' || !NAME_RE.test(x)))
        throw new FragmentError('schema_violation', `table ${tName}: contract_exclude = array of field names`);
      if (spec.contract_exclude.length > QUOTAS.maxFieldsPerTable)
        throw new FragmentError('quota_exceeded', `table ${tName}: contract_exclude > ${QUOTAS.maxFieldsPerTable} items`);
    }

    const fields = spec.fields;
    const fieldNames = Object.keys(fields);
    if (fieldNames.length < 1) throw new FragmentError('schema_violation', `table ${tName}: min 1 field`);
    if (fieldNames.length > QUOTAS.maxFieldsPerTable)
      throw new FragmentError('quota_exceeded', `table ${tName}: > ${QUOTAS.maxFieldsPerTable} fields (§4.5)`);
    totalFields += fieldNames.length;

    for (const [fName, f] of Object.entries(fields)) {
      if (!NAME_RE.test(fName)) throw new FragmentError('invalid_identifier', `table ${tName}: field outside regex: ${fName}`);
      if (!f || typeof f !== 'object' || Array.isArray(f))
        throw new FragmentError('schema_violation', `table ${tName}.${fName}: object expected`);
      for (const k of Object.keys(f))
        if (!FIELD_KEYS.has(k)) throw new FragmentError('schema_violation', `field ${tName}.${fName}: unauthorized key ${k}`);
      if (!TYPES.includes(f.type))
        throw new FragmentError('schema_violation', `field ${tName}.${fName}: type not whitelisted: ${f.type}`);
      for (const b of ['serial', 'not_null', 'unique'])
        if (f[b] !== undefined && typeof f[b] !== 'boolean')
          throw new FragmentError('schema_violation', `field ${tName}.${fName}: ${b} must be boolean`);
      if (f.default !== undefined && !['string', 'number', 'boolean'].includes(typeof f.default))
        throw new FragmentError('schema_violation', `field ${tName}.${fName}: default must be string|number|boolean`);
      if (f.check_in !== undefined) {
        if (!Array.isArray(f.check_in) || f.check_in.some(x => typeof x !== 'string'))
          throw new FragmentError('schema_violation', `field ${tName}.${fName}: check_in = array of strings`);
        if (f.check_in.length > QUOTAS.maxCheckIn)
          throw new FragmentError('quota_exceeded', `field ${tName}.${fName}: check_in > ${QUOTAS.maxCheckIn} items`);
      }
      if (f.fk !== undefined && f.fk !== 'users')
        // §4.4: FKs allowed only towards app.users; forbidden between packages
        throw new FragmentError('blacklisted_effect', `field ${tName}.${fName}: fk allowed only towards "users" (§4.4)`);
      // v0.4 field keys (semantic profile — contract-only)
      if (f.node_kind !== undefined && !['iri', 'literal'].includes(f.node_kind))
        throw new FragmentError('schema_violation', `field ${tName}.${fName}: node_kind must be "iri"|"literal"`);
      if (f.lang !== undefined && typeof f.lang !== 'boolean')
        throw new FragmentError('schema_violation', `field ${tName}.${fName}: lang must be boolean`);
      if (f.align !== undefined && (typeof f.align !== 'string' || !IRI_RE.test(f.align)))
        throw new FragmentError('schema_violation', `field ${tName}.${fName}: align must be an IRI (or prefixed form)`);
      if (f.label_i18n !== undefined) validateLabelI18n(f.label_i18n, `field ${tName}.${fName}`);
    }

    // v0.4: contract_exclude entries must name existing fields of this table
    if (spec.contract_exclude)
      for (const x of spec.contract_exclude)
        if (!fields[x]) throw new FragmentError('schema_violation', `table ${tName}: contract_exclude names unknown field "${x}"`);

    // pk / owner / tombstone consistency
    const pkF = fields[spec.pk];
    if (!pkF) throw new FragmentError('schema_violation', `table ${tName}: pk "${spec.pk}" missing from fields`);
    if (pkF.type !== 'bigint' || pkF.serial !== true)
      throw new FragmentError('schema_violation', `table ${tName}: pk "id" must be {type:bigint, serial:true}`);
    if (spec.owner !== undefined && spec.owner !== null) {
      const o = fields[spec.owner];
      if (!o) throw new FragmentError('schema_violation', `table ${tName}: owner "${spec.owner}" missing from fields`);
      if (o.type !== 'bigint' || o.fk !== 'users')
        throw new FragmentError('schema_violation', `table ${tName}: owner must be bigint fk users`);
    }
    if (spec.tombstone !== undefined && spec.tombstone !== null) {
      const t = fields[spec.tombstone];
      if (!t) throw new FragmentError('schema_violation', `table ${tName}: tombstone "${spec.tombstone}" missing from fields`);
      if (t.type !== 'timestamptz')
        throw new FragmentError('schema_violation', `table ${tName}: tombstone must be timestamptz`);
    }
  }
  if (totalFields > QUOTAS.maxFieldsPerPackage)
    throw new FragmentError('quota_exceeded', `> ${QUOTAS.maxFieldsPerPackage} fields/package (§4.5)`);
  return true;
}

// ---------- canonicalization (anti-drift hash, §5) ----------
// Canonical form compared to the live schema: column structure only (type/serial/not_null),
// recursively sorted → stable sha256. v0.4 semantic keys (node_kind/lang/align/label_i18n/
// align_class/contract_exclude/supersedes) are INTENTIONALLY excluded: they shape the published
// contract (ext/shacl), not the DDL → annotating a fragment never triggers a false drift.

function canonicalForCompare(fragment) {
  const tables = {};
  for (const [tName, spec] of Object.entries(fragment.tables)) {
    const fields = {};
    for (const [fName, f] of Object.entries(spec.fields)) {
      // a serial field is NOT NULL in the DB (bigserial) → normalized to compare with the live schema
      fields[fName] = { type: f.type, serial: !!f.serial, not_null: !!f.not_null || !!f.serial };
    }
    tables[tName] = { pk: spec.pk, fields };
  }
  return stableStringify({ tables });
}

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

function fragmentHash(fragment) {
  return crypto.createHash('sha256').update(canonicalForCompare(fragment), 'utf8').digest('hex');
}

// ---------- DDL compilation (effect whitelist, §4.3) ----------
// Returns { hash, tables: [{ logical, physical, container, pattern, published, statements }] }
// All tables live in the app schema, named store_<slug>_<table> (truncated prefix §1.4).

function compileFragment(slug, fragment) {
  if (!SLUG_RE.test(slug)) throw new FragmentError('invalid_identifier', `slug outside regex: ${slug}`);
  const tables = [];
  for (const [tName, spec] of Object.entries(fragment.tables)) {
    const physical = physicalTable(slug, tName);
    const container = `/apps/${slug}/${tName}/`;
    const pattern = `/apps/${slug}/${tName}/<${spec.pk}>`;
    const statements = [];

    // CREATE TABLE (idempotent)
    const cols = [];
    for (const [fName, f] of Object.entries(spec.fields)) {
      let sql = quoteIdent(fName) + ' ';
      if (f.serial) sql += 'bigserial';                       // serial id pk (enforced in v1)
      else sql += PG_TYPES[f.type];
      if (fName === spec.pk) sql += ' PRIMARY KEY';
      if (f.not_null && fName !== spec.pk) sql += ' NOT NULL';
      if (f.unique) sql += ' UNIQUE';
      if (f.default !== undefined) sql += ' DEFAULT ' + defaultSql(f.default);
      if (f.check_in) sql += ` CHECK (${quoteIdent(fName)} IN (${f.check_in.map(quoteLiteral).join(', ')}))`;
      if (f.fk === 'users') sql += ` REFERENCES app.${quoteIdent('users')}(${quoteIdent('id')})`;
      cols.push(sql);
    }
    statements.push(`CREATE TABLE IF NOT EXISTS app.${quoteIdent(physical)} (${cols.join(', ')})`);
    statements.push(`GRANT SELECT, INSERT, UPDATE, DELETE ON app.${quoteIdent(physical)} TO app`);
    statements.push(`GRANT USAGE, SELECT ON SEQUENCE app.${quoteIdent(physical + '_' + spec.pk + '_seq')} TO app`);

    // base generic triggers (whitelist §4.3)
    const has = (f) => spec.fields[f] !== undefined;
    const trigger = (name, fn, event) => {
      statements.push(`DROP TRIGGER IF EXISTS ${name} ON app.${quoteIdent(physical)}`);
      statements.push(`CREATE TRIGGER ${name} ${event} ON app.${quoteIdent(physical)} FOR EACH ROW EXECUTE FUNCTION app.${fn}()`);
    };
    if (has('updated_at')) trigger('set_updated_at', 'set_updated_at', 'BEFORE INSERT OR UPDATE');
    trigger('versioning', 'version_trigger', 'AFTER INSERT OR UPDATE');
    if (spec.tombstone) trigger('tombstone', 'tombstone_trigger', 'AFTER UPDATE');
    if (spec.outbox) trigger('outbox', 'outbox_trigger', 'AFTER INSERT OR UPDATE');

    // default RLS via auth.can (same conventions as the core, logical IRI /apps/<slug>/<table>/)
    const qT = `app.${quoteIdent(physical)}`;
    const iriExpr = `rtrim(current_setting('app.base_iri', true), '/') || ${quoteLiteral(container)} || ${quoteIdent(spec.pk)}::text`;
    const containerExpr = `rtrim(current_setting('app.base_iri', true), '/') || ${quoteLiteral(container)}`;
    statements.push(`ALTER TABLE ${qT} ENABLE ROW LEVEL SECURITY`);
    statements.push(`ALTER TABLE ${qT} FORCE ROW LEVEL SECURITY`);
    const policy = (name, cmd, expr) => {
      statements.push(`DROP POLICY IF EXISTS ${name} ON ${qT}`);
      if (cmd === 'INSERT') // INSERT: WITH CHECK only (like the core)
        statements.push(`CREATE POLICY ${name} ON ${qT} FOR INSERT WITH CHECK (${expr})`);
      else if (cmd === 'UPDATE')
        statements.push(`CREATE POLICY ${name} ON ${qT} FOR UPDATE USING (${expr}) WITH CHECK (${expr})`);
      else
        statements.push(`CREATE POLICY ${name} ON ${qT} FOR ${cmd} USING (${expr})`);
    };
    policy(`${physical}_read`, 'SELECT', `auth.can(${iriExpr}, 'read')`);
    policy(`${physical}_insert`, 'INSERT', `auth.can(${containerExpr}, 'write')`);
    policy(`${physical}_write`, 'UPDATE', `auth.can(${iriExpr}, 'write')`);
    policy(`${physical}_delete`, 'DELETE', `auth.can(${iriExpr}, 'write')`);

    tables.push({ logical: tName, physical, container, pattern, published: !!spec.published, statements });
  }
  return { hash: fragmentHash(fragment), tables };
}

// §4.6: now()/true/false and numbers emitted as-is; any other string via quote_literal (safe)
function defaultSql(d) {
  if (typeof d === 'number') return String(d);
  if (typeof d === 'boolean') return d ? 'true' : 'false';
  if (SAFE_DEFAULT_EXPRS.has(d)) return d;
  return quoteLiteral(d);
}

// ---------- live schema → canonical (drift detection at boot, §5) ----------
// Reads information_schema for app.store_<slug>_* and rebuilds the comparable canonical form.

async function liveCanonical(client, slug) {
  const prefix = 'store_' + slug + '_';
  const cols = await client.query(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'app' AND table_name LIKE $1
     ORDER BY table_name, ordinal_position`, [prefix + '%']);
  const pks = await client.query(
    `SELECT kcu.table_name, kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     WHERE tc.table_schema = 'app' AND tc.constraint_type = 'PRIMARY KEY'
       AND kcu.table_name LIKE $1`, [prefix + '%']);
  const pkOf = {};
  for (const r of pks.rows) pkOf[r.table_name] = r.column_name;
  const tables = {};
  for (const r of cols.rows) {
    const logical = r.table_name.slice(prefix.length);
    const typeMap = { 'bigint': 'bigint', 'text': 'text', 'numeric': 'numeric', 'boolean': 'boolean', 'timestamp with time zone': 'timestamptz', 'jsonb': 'jsonb' };
    const type = typeMap[r.data_type];
    if (!type) continue; // non-DSL type → drift visible via different hash
    tables[logical] = tables[logical] || { pk: pkOf[r.table_name] || 'id', fields: {} };
    tables[logical].fields[r.column_name] = {
      type,
      serial: typeof r.column_default === 'string' && r.column_default.startsWith('nextval('),
      not_null: r.is_nullable === 'NO'
    };
  }
  return stableStringify({ tables });
}

module.exports = {
  SLUG_RE, NAME_RE, QUOTAS, FragmentError,
  quoteIdent, quoteLiteral, physicalTable,
  validateFragment, compileFragment, fragmentHash, canonicalForCompare, stableStringify, liveCanonical
};
