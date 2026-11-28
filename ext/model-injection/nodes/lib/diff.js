// diff.js — ext/model-injection (E11 v1, canal POST /admin/model): PURE additive diff of the
// CORE model (config/model.json) + compilation of the core DDL. No I/O, no PG — node --test.
//
//   diffCoreModel(old, new)   → { creates, alters, refused }
//       creates : table nouvelle        → CREATE TABLE app.<t>
//       alters  : colonne nouvelle      → ALTER TABLE app.<t> ADD COLUMN IF NOT EXISTS …
//       refused : suppression / modification (v1 additif-only → 422, jamais appliqué)
//   compileCoreDdl(diff)      → { statements, creates, alters } — CREATE TABLE app.<t> avec la
//       génération de colonnes factorisée de compileFragment (columnSql, noms nus, PAS store_*),
//       triggers/RLS factorisés de core/nodes/lib/core-model.js (ex-model.js). Jamais de DROP
//       TABLE/COLUMN.
//   mergeCoreModel(old, new, diff) → le model.json cœur cible (dialecte core,écriture atomique)
//
// `old` = model.json courant (dialecte core : champs en chaînes SQL-ish, ex. "text not null",
// "bigint fk buildings(id)", "double precision") ; `new` = fragment annexe A (objets structurés)
// reçu dans le body { model }. Les deux dialectes sont normalisés avant comparaison.
// Validation du `new` : validateFragment de fragment.js, dialecte core (fk vers n'importe quelle
// table cœur, clés de table core, quotas package relaxés).
const {
  NAME_RE, FragmentError, quoteIdent, quoteLiteral, columnSql, validateFragment
} = require('./fragment');

// core-model builders shared with the core node (mounted as node-red-contrib-fap-ldp in ORCE,
// sibling directory in the repo) — try the deployed package name first, then the repo layout.
function requireCore(rel) {
  try { return require('node-red-contrib-fap-ldp/' + rel); }
  catch { return require('../../../../core/nodes/' + rel); }
}
const coreModel = requireCore('lib/core-model.js');

// ---------- dialects ----------

const PG_TYPE_STR = { text: 'text', bigint: 'bigint', numeric: 'numeric', boolean: 'boolean', timestamptz: 'timestamptz', jsonb: 'jsonb' };

// SQL type (core dialect) → annexe A whitelisted type (same mapping as the editor whitelistType)
function whitelistType(t) {
  t = String(t || '').toLowerCase();
  if (PG_TYPE_STR[t]) return t;
  if (t === 'double precision' || t === 'double' || t === 'real' || t === 'float' || t === 'float8') return 'numeric';
  if (t === 'integer' || t === 'int' || t === 'int4' || t === 'int8' || t === 'bigint' || t === 'smallint' || t === 'int2') return 'bigint';
  if (t === 'varchar' || t === 'char' || t === 'character varying' || t === 'text') return 'text';
  if (t === 'timestamp' || t === 'timestamp without time zone' || t === 'timestamptz' || t === 'timestamp with time zone') return 'timestamptz';
  if (t === 'json' || t === 'jsonb') return 'jsonb';
  if (t === 'boolean' || t === 'bool') return 'boolean';
  return 'text';
}

function normDefault(d) {
  if (d === undefined || d === null) return null;
  let s = String(d).trim();
  const m = s.match(/^'(.*)'$/s);
  if (m) s = m[1].replace(/''/g, "'");
  return s.toLowerCase() === 'now()' ? 'now()' : s;
}

// core string def ("text default 'OPEN' check in ('OPEN','CLOSED')", "bigint fk users(id)",
// "bigserial", "double precision", trailing comment) → structured field (annexe-A-shaped)
function parseCoreField(def) {
  if (def && typeof def === 'object') return def;
  let d = String(def ?? '').trim();
  const out = {};
  const chk = d.match(/^(.*?)\s+check\s+in\s*\((.*)\)\s*$/i);
  if (chk) {
    out.check_in = chk[2].split(',').map(s => s.trim().replace(/^'|'$/g, '').replace(/''/g, "'")).filter(Boolean);
    d = chk[1].trim();
  }
  const fk = d.match(/^(\S+)\s+fk\s+(\w+)\((\w+)\)\s*$/i);
  if (fk) { out.type = fk[1].toLowerCase(); out.fk = fk[2]; return out; }
  if (/\bbigserial\b/i.test(d)) { out.type = 'bigint'; out.serial = true; return out; }
  d = d.replace(/ \([^)]*\)\s*$/, '').trim(); // trailing comment
  const defm = d.match(/^(.*?)\s+default\s+('[^']*'|\S+)\s*$/i);
  if (defm) { out.default = normDefault(defm[2]); d = defm[1].trim(); }
  if (/\bnot\s+null\b/i.test(d)) out.not_null = true;
  if (/\bunique\b/i.test(d)) out.unique = true;
  out.type = d.split(/\s+/)[0].toLowerCase();
  return out;
}

// normalized, comparable signature of a field (both dialects) — structural keys only;
// semantic/contract keys (align, label_i18n…) are intentionally excluded (no DDL effect).
function fieldSignature(f) {
  f = parseCoreField(f);
  return JSON.stringify({
    type: whitelistType(f.type),
    serial: !!f.serial,
    not_null: !!f.not_null || !!f.serial,
    unique: !!f.unique,
    check_in: (f.check_in || []).map(String).slice().sort(),
    fk: f.fk || null,
    default: normDefault(f.default)
  });
}

const TABLE_STRUCT_KEYS = ['pk', 'owner', 'tombstone', 'published', 'parent', 'parent_fk', 'container_name'];

function normalizeModel(model) {
  const tables = {};
  for (const [t, spec] of Object.entries((model && model.tables) || {})) {
    const fields = {};
    for (const [f, fd] of Object.entries(spec.fields || {})) fields[f] = fieldSignature(fd);
    tables[t] = {
      pk: spec.pk ?? null,
      owner: spec.owner ?? null,
      tombstone: spec.tombstone ?? null,
      published: !!spec.published,
      parent: spec.parent ?? null,
      parent_fk: spec.parent_fk ?? null,
      container_name: spec.container_name ?? null,
      fields
    };
  }
  return { tables };
}

// ---------- diff (v1 additif-only) ----------

// diffCoreModel(old, new, rawBytes?) → { creates, alters, refused }
//   throws FragmentError (→ 422) when `new` is not a valid annexe A fragment (core dialect).
function diffCoreModel(oldModel, newModel, rawBytes) {
  validateFragment(newModel, rawBytes, { coreDialect: true }); // reuse of fragment.js validation
  const oldN = normalizeModel(oldModel);
  const newN = normalizeModel(newModel);
  const creates = [], alters = [], refused = [];

  for (const t of Object.keys(oldN.tables)) {
    if (!newN.tables[t]) refused.push({ table: t, reason: 'table_dropped' });
  }
  for (const [t, nSpec] of Object.entries(newN.tables)) {
    const oSpec = oldN.tables[t];
    if (!oSpec) { creates.push({ table: t, spec: newModel.tables[t] }); continue; }
    for (const k of TABLE_STRUCT_KEYS) {
      if (JSON.stringify(oSpec[k] ?? null) !== JSON.stringify(nSpec[k] ?? null))
        refused.push({ table: t, key: k, reason: 'table_key_modified', from: oSpec[k] ?? null, to: nSpec[k] ?? null });
    }
    for (const f of Object.keys(oSpec.fields)) {
      if (!nSpec.fields[f]) refused.push({ table: t, field: f, reason: 'column_dropped' });
    }
    for (const [f, nSig] of Object.entries(nSpec.fields)) {
      const oSig = oSpec.fields[f];
      if (!oSig) { alters.push({ table: t, field: f, spec: newModel.tables[t].fields[f] }); continue; }
      if (oSig !== nSig) refused.push({ table: t, field: f, reason: 'column_modified' });
    }
  }
  return { creates, alters, refused };
}

// ---------- DDL cœur ----------

// compileCoreDdl(diff) → { statements, creates, alters }
// creates : CREATE TABLE app.<t> (colonnes via columnSql de compileFragment, noms nus) +
//           GRANT + triggers + RLS (core-model.js, ex model.js). Jamais de DROP TABLE/COLUMN.
// alters  : ALTER TABLE app.<t> ADD COLUMN IF NOT EXISTS <col> (jamais de DROP).
function compileCoreDdl(diff) {
  const statements = [];
  const creates = [];
  for (const c of diff.creates || []) {
    const t = c.table, spec = c.spec;
    const q = `app.${quoteIdent(t)}`;
    const cols = Object.entries(spec.fields).map(([f, fd]) => columnSql(f, fd, spec.pk));
    if (Array.isArray(spec.unique)) for (const u of spec.unique) cols.push(`UNIQUE (${u.map(quoteIdent).join(', ')})`);
    statements.push(`CREATE TABLE IF NOT EXISTS ${q} (${cols.join(', ')})`);
    statements.push(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${q} TO app`);
    statements.push(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO app`);
    for (const s of coreModel.createTriggerStatements(t, spec)) statements.push(s);
    for (const s of coreModel.rlsStatements(t, spec)) statements.push(s);
    const iri = coreModel.iriExpr(t, spec);
    creates.push({ table: t, container: iri.container, pattern: iri.pattern, published: !!spec.published });
  }
  const alters = [];
  for (const a of diff.alters || []) {
    const col = columnSql(a.field, a.spec, null); // colonne ajoutée : jamais de PK ici
    statements.push(`ALTER TABLE app.${quoteIdent(a.table)} ADD COLUMN IF NOT EXISTS ${col}`);
    alters.push({ table: a.table, field: a.field });
  }
  // invariant v1 : aucun DROP de table/colonne ne peut sortir de ce compilateur
  for (const s of statements) {
    if (/^\s*DROP\s+(TABLE|COLUMN)\b/i.test(s))
      throw new FragmentError('blacklisted_effect', 'DROP TABLE/COLUMN forbidden (v1 additif-only)');
  }
  return { statements, creates, alters };
}

// ---------- fusion → model.json cœur cible (dialecte core) ----------

const SEM_KEYS = ['node_kind', 'lang', 'align', 'label_i18n', 'description_i18n'];
const STRUCT_FIELD_KEYS = ['type', 'serial', 'not_null', 'unique', 'default', 'check_in', 'fk'];
const TABLE_META_KEYS = ['pk', 'owner', 'published', 'tombstone', 'parent', 'parent_fk', 'container_name',
  'unique', 'internal', 'label_i18n', 'align_class', 'contract_exclude'];

// structured field → core string def ("text not null", "bigint fk users(id)", …)
function toCoreFieldString(f) {
  let s = f.serial ? 'bigserial' : PG_TYPE_STR[whitelistType(f.type)];
  if (f.not_null && !f.serial) s += ' not null';
  if (f.unique) s += ' unique';
  if (f.default !== undefined) {
    const d = f.default;
    s += ' default ' + (typeof d === 'number' ? String(d)
      : typeof d === 'boolean' ? (d ? 'true' : 'false')
      : ['now()', 'true', 'false'].includes(String(d)) ? String(d)
      : quoteLiteral(d));
  }
  if (f.check_in) s += ` check in (${f.check_in.map(v => quoteLiteral(v)).join(',')})`;
  if (f.fk) s += ` fk ${f.fk}(id)`;
  return s;
}

// structured field → core-dialect field (string, or structured object when it carries semantic
// keys — both dialects are accepted by core-model.js fieldToSql and by ext/shacl compiler)
function toCoreField(f) {
  if (!SEM_KEYS.some(k => f[k] !== undefined)) return toCoreFieldString(f);
  const out = {};
  const base = parseCoreField(f);
  out.type = whitelistType(base.type);
  for (const k of STRUCT_FIELD_KEYS) if (k !== 'type' && base[k] !== undefined) out[k] = base[k];
  for (const k of SEM_KEYS) if (f[k] !== undefined) out[k] = f[k];
  return out;
}

function toCoreTableSpec(spec) {
  const out = {};
  for (const k of TABLE_META_KEYS) if (spec[k] !== undefined) out[k] = spec[k];
  out.fields = {};
  for (const [f, fd] of Object.entries(spec.fields || {})) out.fields[f] = toCoreField(fd);
  return out;
}

// mergeCoreModel(old, new, diff) → nouveau model.json (dialecte core) :
// tables existantes conservées telles quelles + colonnes ajoutées + clés sémantiques (contrat
// seul) rafraîchies ; tables nouvelles converties en dialecte core. Aucun champ supprimé.
function mergeCoreModel(oldModel, newModel, diff) {
  const merged = { ...(oldModel || {}) };
  merged.tables = { ...((oldModel && oldModel.tables) || {}) };
  for (const c of diff.creates) merged.tables[c.table] = toCoreTableSpec(c.spec);
  for (const [t, nSpec] of Object.entries((newModel && newModel.tables) || {})) {
    if (!merged.tables[t]) continue; // create déjà pris en compte
    const tNew = { ...merged.tables[t] };
    for (const k of ['label_i18n', 'align_class', 'contract_exclude', 'internal'])
      if (nSpec[k] !== undefined) tNew[k] = nSpec[k];
    tNew.fields = { ...(merged.tables[t].fields || {}) };
    for (const a of diff.alters) {
      if (a.table !== t) continue;
      tNew.fields[a.field] = toCoreField(a.spec);
    }
    for (const [f, nfd] of Object.entries(nSpec.fields || {})) {
      if (!tNew.fields[f] || typeof nfd !== 'object') continue;
      if (!SEM_KEYS.some(k => nfd[k] !== undefined)) continue; // champ inchangé → on garde la déf old
      tNew.fields[f] = toCoreField({ ...parseCoreField(tNew.fields[f]), ...pickSem(nfd) });
    }
    merged.tables[t] = tNew;
  }
  return merged;
}

function pickSem(o) { const out = {}; for (const k of SEM_KEYS) if (o[k] !== undefined) out[k] = o[k]; return out; }

module.exports = {
  diffCoreModel, compileCoreDdl, mergeCoreModel,
  parseCoreField, fieldSignature, normalizeModel, whitelistType,
  toCoreFieldString, toCoreTableSpec
};
