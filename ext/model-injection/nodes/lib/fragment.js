// fragment.js — ext/model-injection (E11) : validation, canonicalisation et compilation DDL
// du fragment de modèle déclaratif (annexe A de atlas/spec/model-injection-spec.md v0.3).
// Pur et sans dépendance (testable hors Node-RED) : tout nom passe par quoteIdent(),
// toute valeur littérale par quoteLiteral() → aucune injection SQL possible (§4.2/§4.6).
const crypto = require('crypto');

const SLUG_RE = /^[a-z][a-z0-9_]{1,30}$/;
const NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;
const TYPES = ['text', 'bigint', 'numeric', 'boolean', 'timestamptz', 'jsonb'];
const PG_TYPES = { text: 'text', bigint: 'bigint', numeric: 'numeric', boolean: 'boolean', timestamptz: 'timestamptz', jsonb: 'jsonb' };
const SAFE_DEFAULT_EXPRS = new Set(['now()', 'true', 'false']); // §4.6 : le reste passe en quote_literal
const TABLE_KEYS = new Set(['pk', 'owner', 'published', 'tombstone', 'outbox', 'fields']);
const FIELD_KEYS = new Set(['type', 'serial', 'not_null', 'unique', 'default', 'check_in', 'fk']);

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

// quote_ident / quote_literal (les noms sont déjà contraints par regex, on quote quand même)
function quoteIdent(name) { return '"' + String(name).replace(/"/g, '""') + '"'; }
function quoteLiteral(v) { return "'" + String(v).replace(/'/g, "''") + "'"; }

function physicalTable(slug, table) { return 'store_' + slug + '_' + table; }

// ---------- validation (annexe A + règles §4) ----------

function validateFragment(fragment, rawBytes) {
  if (rawBytes !== undefined && rawBytes > QUOTAS.maxPayloadBytes)
    throw new FragmentError('quota_exceeded', `payload fragment > ${QUOTAS.maxPayloadBytes} octets (§4.5)`);
  if (!fragment || typeof fragment !== 'object' || Array.isArray(fragment))
    throw new FragmentError('schema_violation', 'fragment: objet racine attendu');
  for (const k of Object.keys(fragment))
    if (k !== 'tables') throw new FragmentError('schema_violation', `clé racine non autorisée: ${k}`);
  const tables = fragment.tables;
  if (!tables || typeof tables !== 'object' || Array.isArray(tables))
    throw new FragmentError('schema_violation', 'fragment.tables: objet requis');
  const tableNames = Object.keys(tables);
  if (tableNames.length < 1) throw new FragmentError('schema_violation', 'fragment.tables: min 1 table');
  if (tableNames.length > QUOTAS.maxTables)
    throw new FragmentError('quota_exceeded', `> ${QUOTAS.maxTables} tables/package (§4.5)`);

  let totalFields = 0;
  for (const [tName, spec] of Object.entries(tables)) {
    if (!NAME_RE.test(tName)) throw new FragmentError('invalid_identifier', `nom de table hors regex: ${tName}`);
    if (!spec || typeof spec !== 'object' || Array.isArray(spec))
      throw new FragmentError('schema_violation', `table ${tName}: objet attendu`);
    for (const k of Object.keys(spec))
      if (!TABLE_KEYS.has(k)) throw new FragmentError('schema_violation', `table ${tName}: clé non autorisée ${k}`);
    if (typeof spec.pk !== 'string' || !NAME_RE.test(spec.pk))
      throw new FragmentError('invalid_identifier', `table ${tName}: pk invalide`);
    if (!spec.fields || typeof spec.fields !== 'object')
      throw new FragmentError('schema_violation', `table ${tName}: fields requis`);

    // v1 : les triggers génériques du socle (app.version_trigger etc.) utilisent NEW.id
    // → la pk d'une table injectée DOIT être la colonne "id" bigint serial.
    if (spec.pk !== 'id')
      throw new FragmentError('schema_violation', `table ${tName}: pk doit être "id" en v1 (triggers du socle)`);

    if (spec.owner !== undefined && spec.owner !== null) {
      if (!NAME_RE.test(spec.owner)) throw new FragmentError('invalid_identifier', `table ${tName}: owner invalide`);
    }
    if (spec.tombstone !== undefined && spec.tombstone !== null) {
      if (!NAME_RE.test(spec.tombstone)) throw new FragmentError('invalid_identifier', `table ${tName}: tombstone invalide`);
    }
    for (const b of ['published', 'outbox'])
      if (spec[b] !== undefined && typeof spec[b] !== 'boolean')
        throw new FragmentError('schema_violation', `table ${tName}: ${b} doit être booléen`);

    const fields = spec.fields;
    const fieldNames = Object.keys(fields);
    if (fieldNames.length < 1) throw new FragmentError('schema_violation', `table ${tName}: min 1 champ`);
    if (fieldNames.length > QUOTAS.maxFieldsPerTable)
      throw new FragmentError('quota_exceeded', `table ${tName}: > ${QUOTAS.maxFieldsPerTable} champs (§4.5)`);
    totalFields += fieldNames.length;

    for (const [fName, f] of Object.entries(fields)) {
      if (!NAME_RE.test(fName)) throw new FragmentError('invalid_identifier', `table ${tName}: champ hors regex: ${fName}`);
      if (!f || typeof f !== 'object' || Array.isArray(f))
        throw new FragmentError('schema_violation', `table ${tName}.${fName}: objet attendu`);
      for (const k of Object.keys(f))
        if (!FIELD_KEYS.has(k)) throw new FragmentError('schema_violation', `champ ${tName}.${fName}: clé non autorisée ${k}`);
      if (!TYPES.includes(f.type))
        throw new FragmentError('schema_violation', `champ ${tName}.${fName}: type non whitelisté: ${f.type}`);
      for (const b of ['serial', 'not_null', 'unique'])
        if (f[b] !== undefined && typeof f[b] !== 'boolean')
          throw new FragmentError('schema_violation', `champ ${tName}.${fName}: ${b} doit être booléen`);
      if (f.default !== undefined && !['string', 'number', 'boolean'].includes(typeof f.default))
        throw new FragmentError('schema_violation', `champ ${tName}.${fName}: default string|number|boolean`);
      if (f.check_in !== undefined) {
        if (!Array.isArray(f.check_in) || f.check_in.some(x => typeof x !== 'string'))
          throw new FragmentError('schema_violation', `champ ${tName}.${fName}: check_in = tableau de string`);
        if (f.check_in.length > QUOTAS.maxCheckIn)
          throw new FragmentError('quota_exceeded', `champ ${tName}.${fName}: check_in > ${QUOTAS.maxCheckIn} items`);
      }
      if (f.fk !== undefined && f.fk !== 'users')
        // §4.4 : FK autorisées uniquement vers app.users ; interdites entre packages
        throw new FragmentError('blacklisted_effect', `champ ${tName}.${fName}: fk autorisée uniquement vers "users" (§4.4)`);
    }

    // cohérence pk / owner / tombstone
    const pkF = fields[spec.pk];
    if (!pkF) throw new FragmentError('schema_violation', `table ${tName}: pk "${spec.pk}" absent de fields`);
    if (pkF.type !== 'bigint' || pkF.serial !== true)
      throw new FragmentError('schema_violation', `table ${tName}: pk "id" doit être {type:bigint, serial:true}`);
    if (spec.owner !== undefined && spec.owner !== null) {
      const o = fields[spec.owner];
      if (!o) throw new FragmentError('schema_violation', `table ${tName}: owner "${spec.owner}" absent de fields`);
      if (o.type !== 'bigint' || o.fk !== 'users')
        throw new FragmentError('schema_violation', `table ${tName}: owner doit être bigint fk users`);
    }
    if (spec.tombstone !== undefined && spec.tombstone !== null) {
      const t = fields[spec.tombstone];
      if (!t) throw new FragmentError('schema_violation', `table ${tName}: tombstone "${spec.tombstone}" absent de fields`);
      if (t.type !== 'timestamptz')
        throw new FragmentError('schema_violation', `table ${tName}: tombstone doit être timestamptz`);
    }
  }
  if (totalFields > QUOTAS.maxFieldsPerPackage)
    throw new FragmentError('quota_exceeded', `> ${QUOTAS.maxFieldsPerPackage} champs/package (§4.5)`);
  return true;
}

// ---------- canonicalisation (hash anti-drift, §5) ----------
// Forme canonique comparée au schéma live : structure colonnes uniquement (type/serial/not_null),
// triée récursivement → sha256 stable.

function canonicalForCompare(fragment) {
  const tables = {};
  for (const [tName, spec] of Object.entries(fragment.tables)) {
    const fields = {};
    for (const [fName, f] of Object.entries(spec.fields)) {
      // un champ serial est NOT NULL en base (bigserial) → normalisé pour comparer au schéma live
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

// ---------- compilation DDL (whitelist des effets, §4.3) ----------
// Retourne { hash, tables: [{ logical, physical, container, pattern, published, statements }] }
// Toutes les tables vivent dans le schéma app, nommées store_<slug>_<table> (préfixe tranché §1.4).

function compileFragment(slug, fragment) {
  if (!SLUG_RE.test(slug)) throw new FragmentError('invalid_identifier', `slug hors regex: ${slug}`);
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
      if (f.serial) sql += 'bigserial';                       // pk id serial (imposé en v1)
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

    // triggers génériques du socle (whitelist §4.3)
    const has = (f) => spec.fields[f] !== undefined;
    const trigger = (name, fn, event) => {
      statements.push(`DROP TRIGGER IF EXISTS ${name} ON app.${quoteIdent(physical)}`);
      statements.push(`CREATE TRIGGER ${name} ${event} ON app.${quoteIdent(physical)} FOR EACH ROW EXECUTE FUNCTION app.${fn}()`);
    };
    if (has('updated_at')) trigger('set_updated_at', 'set_updated_at', 'BEFORE INSERT OR UPDATE');
    trigger('versioning', 'version_trigger', 'AFTER INSERT OR UPDATE');
    if (spec.tombstone) trigger('tombstone', 'tombstone_trigger', 'AFTER UPDATE');
    if (spec.outbox) trigger('outbox', 'outbox_trigger', 'AFTER INSERT OR UPDATE');

    // RLS par défaut via auth.can (mêmes conventions que le core, IRI logique /apps/<slug>/<table>/)
    const qT = `app.${quoteIdent(physical)}`;
    const iriExpr = `rtrim(current_setting('app.base_iri', true), '/') || ${quoteLiteral(container)} || ${quoteIdent(spec.pk)}::text`;
    const containerExpr = `rtrim(current_setting('app.base_iri', true), '/') || ${quoteLiteral(container)}`;
    statements.push(`ALTER TABLE ${qT} ENABLE ROW LEVEL SECURITY`);
    statements.push(`ALTER TABLE ${qT} FORCE ROW LEVEL SECURITY`);
    const policy = (name, cmd, expr) => {
      statements.push(`DROP POLICY IF EXISTS ${name} ON ${qT}`);
      if (cmd === 'INSERT') // INSERT : WITH CHECK seul (comme le core)
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

// §4.6 : now()/true/false et nombres émis tels quels ; toute autre chaîne via quote_literal (sûr)
function defaultSql(d) {
  if (typeof d === 'number') return String(d);
  if (typeof d === 'boolean') return d ? 'true' : 'false';
  if (SAFE_DEFAULT_EXPRS.has(d)) return d;
  return quoteLiteral(d);
}

// ---------- schéma live → canonique (détection de drift au boot, §5) ----------
// Lit information_schema pour les app.store_<slug>_* et reconstruit la forme canonique comparable.

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
    if (!type) continue; // type non DSL → drift visible via hash différent
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
