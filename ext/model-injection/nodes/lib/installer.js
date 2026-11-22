// installer.js — ext/model-injection (E11): governed application of model fragments.
// installPackage: ONE transaction (spec §3.1) = advisory lock → validation → quotas →
//   contribution agreement (dsp.contracts) → compiled DDL → app.app_packages → upsert app.features
//   → dsp.asset_mapping → initial ACLs → audit. Any error → ROLLBACK, nothing applied (AC-B2).
// revokePackage / applyFragmentsAtBoot: revocation (AC-B4) and idempotent boot application
//   + drift detection (AC-B7).
const crypto = require('crypto');
const {
  SLUG_RE, QUOTAS, FragmentError, quoteIdent, quoteLiteral,
  validateFragment, compileFragment, fragmentHash, canonicalForCompare, liveCanonical
} = require('./fragment');

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function audit(client, { agreementId, webid, resourceUri, mode, decision }) {
  return client.query(
    'INSERT INTO dsp.audit (agreement_id, webid, resource_uri, mode, decision) VALUES ($1,$2,$3,$4,$5)',
    [agreementId || null, webid || null, resourceUri || null, mode, decision || 'allow']);
}

// ---------- install (POST /admin/apps) ----------

async function installPackage(pool, opts) {
  const { slug, version, sri = null, meta = {}, model_fragment, retention = 'drop', webid, baseIri, maxPackages = 50 } = opts;

  if (!SLUG_RE.test(String(slug || ''))) throw new FragmentError('invalid_identifier', `slug outside regex: ${slug}`);
  if (!version || typeof version !== 'string' || version.includes('^'))
    throw new FragmentError('schema_violation', 'version required, pinned (no ^)');
  if (!model_fragment) throw new FragmentError('schema_violation', 'model_fragment required');
  if (!['drop', 'archive30d'].includes(retention))
    throw new FragmentError('schema_violation', "retention must be 'drop' or 'archive30d'");
  const rawBytes = Buffer.byteLength(JSON.stringify(model_fragment), 'utf8');
  validateFragment(model_fragment, rawBytes); // throws FragmentError (422, AC-B2)

  const base = String(baseIri || 'http://localhost:1880/').replace(/\/?$/, '/');
  const compiled = compileFragment(slug, model_fragment);
  const containerRoot = `/apps/${slug}/`;
  const containerRootIri = base + containerRoot.replace(/^\//, '');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // §3.3: a single winner if two admins run in parallel
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['model-injection:' + slug]);

    const existing = await client.query('SELECT slug, state FROM app.app_packages WHERE slug = $1', [slug]);
    if (existing.rows.length) throw new HttpError(409, 'Conflict', `package "${slug}" already installed (v1: no upgrade, §3.1)`);

    // Prefix/physical-name collision: store_<slug>_<table> must not overlap any table
    // of another installed package (e.g. slug x + table y_z vs slug x_y + table z), nor a
    // table already present in the DB. The unique index §2 covers the exact prefix; here the full overlap.
    const others = await client.query(
      "SELECT slug, model_fragment FROM app.app_packages WHERE state = 'installed' AND slug <> $1", [slug]);
    const taken = new Set();
    for (const o of others.rows)
      for (const t of Object.keys(o.model_fragment.tables || {})) taken.add('store_' + o.slug + '_' + t);
    for (const t of compiled.tables) {
      if (taken.has(t.physical)) throw new FragmentError('prefix_collision', `table ${t.physical} already taken by another package`);
      const exists = await client.query('SELECT to_regclass($1) IS NOT NULL AS ok', ['app.' + t.physical]);
      if (exists.rows[0].ok) throw new FragmentError('prefix_collision', `table app.${t.physical} already exists`);
    }

    const podCount = await client.query("SELECT count(*)::int AS n FROM app.app_packages WHERE state = 'installed'");
    if (podCount.rows[0].n >= maxPackages)
      throw new FragmentError('quota_exceeded', `pod quota reached (${maxPackages} packages installed, §4.5)`);

    // FK users → app.users must exist (§4.4)
    const usesFk = JSON.stringify(model_fragment).includes('"fk"');
    if (usesFk) {
      const hasUsers = await client.query("SELECT to_regclass('app.users') IS NOT NULL AS ok");
      if (!hasUsers.rows[0].ok)
        throw new FragmentError('schema_violation', 'fk "users" requires app.users (missing from the deployment)');
    }

    // contribution agreement (dsp.contracts contract, like DSP sharing, §1.2)
    const agreementId = `agr-mi-${slug}-${Date.now()}`;
    const policy = { '@context': { facis: 'https://facis.eu/ns#' }, 'facis:retention': retention };
    const contract = await client.query(
      `INSERT INTO dsp.contracts (asset_uri, assignee_did, policy_jsonld, state, agreement_id)
       VALUES ($1, $2, $3, 'active', $4) RETURNING agreement_id`,
      [containerRootIri, webid, policy, agreementId]);

    // DDL (effect whitelist, compiled and quoted) — transactional in Postgres
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT USAGE, SELECT ON SEQUENCES TO app`);
    for (const t of compiled.tables) {
      for (const stmt of t.statements) await client.query(stmt);
      // mapping 1 DSP asset = 1 LDP container (spec §1.3)
      await client.query(
        `INSERT INTO dsp.asset_mapping (asset_uri, container_uri, table_schema, table_name, resource_iri_pattern, published)
         VALUES ($1, $2, 'app', $3, $4, $5)
         ON CONFLICT (asset_uri) DO UPDATE SET container_uri = $2, table_name = $3, resource_iri_pattern = $4, published = $5`,
        [t.container, t.container, t.physical, t.pattern, t.published]);
    }

    // initial ACLs (owner = control, §1.4) on the package root container
    const aclRows = [
      [containerRootIri, webid, '{read,write,control}', true],
      [containerRootIri, 'role:admin', '{read,write,control}', true]
    ];
    // published containers: readable by any external with a valid DSP contract (foaf:Agent)
    for (const t of compiled.tables) {
      if (t.published) aclRows.push([base + t.container.replace(/^\//, ''), 'foaf:Agent', '{read}', true]);
    }
    for (const [res, subject, modes, inherited] of aclRows) {
      await client.query(
        `INSERT INTO auth.acl (resource_uri, subject, modes, inherited)
         SELECT $1, $2, $3, $4
         WHERE NOT EXISTS (SELECT 1 FROM auth.acl WHERE resource_uri = $1 AND subject = $2)`,
        [res, subject, modes, inherited]);
    }

    await client.query(
      `INSERT INTO app.app_packages (slug, version, sri, model_fragment, fragment_hash, contract_id, state, installed_by)
       VALUES ($1,$2,$3,$4,$5,$6,'installed',$7)`,
      [slug, version, sri, JSON.stringify(model_fragment), compiled.hash, agreementId, webid]);

    // upsert app.features (app store catalog) if the app store base is installed (L3)
    const hasFeatures = await client.query("SELECT to_regclass('app.features') IS NOT NULL AS ok");
    if (hasFeatures.rows[0].ok) {
      const colRows = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='app' AND table_name='features'`);
      const featureCols = new Set(colRows.rows.map((r) => r.column_name));
      // meta → app.features column, 1:1 without transformation (spec §3.1). Fallback = DDL default
      // when the column exists but is missing from meta (NOT NULL columns: title_i18n, icon…).
      // v2 columns (020_features_v2.sql): present only if the v2 base is applied.
      const metaMap = [
        ['title_i18n', meta.title_i18n ?? {}],
        ['description_i18n', meta.description_i18n ?? {}],
        ['icon', meta.icon ?? 'extension'],
        ['menu_order', meta.menu_order ?? 0],
        ['component', meta.component ?? null],
        ['route', meta.route ?? null],
        ['role_min', meta.role_min ?? 'all'],
        ['config_schema', meta.config_schema ?? { fields: [] }],
        ['default_enabled', meta.default_enabled ?? false],
        ['in_menu', meta.in_menu ?? true],
        // v2 — remote feature: npm/CDN binary + SRI (package version/sri by default)
        ['npm_package', meta.npm_package ?? null],
        ['version', meta.version ?? version],
        ['cdn_url', meta.cdn_url ?? null],
        ['sri', meta.sri ?? sri ?? null],
        ['tag', meta.tag ?? null],
      ];
      const cols = ['slug'];
      const vals = [slug];
      for (const [col, val] of metaMap) {
        if (featureCols.has(col)) { cols.push(col); vals.push(val); }
      }
      if (featureCols.has('model_injected')) { cols.push('model_injected'); vals.push(true); }
      await client.query(
        `INSERT INTO app.features (${cols.join(',')}) VALUES (${cols.map((_, i) => '$' + (i + 1)).join(',')})
         ON CONFLICT (slug) DO UPDATE SET ${cols.slice(1).map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`, vals);
    }

    await audit(client, { agreementId, webid, resourceUri: containerRootIri, mode: 'control' });
    await client.query('COMMIT');
    return { slug, agreement_id: agreementId, location: base + `apps/${slug}/meta`, tables: compiled.tables.map(t => t.physical) };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e instanceof FragmentError || e instanceof HttpError) throw e;
    if (e.code === '23505') { // unique violation: slug pk → 409, prefix index → 422 prefix_collision
      if (String(e.constraint || '').includes('prefix')) throw new FragmentError('prefix_collision', 'prefix already taken (unique index)');
      throw new HttpError(409, 'Conflict', 'slug already installed');
    }
    throw e;
  } finally {
    client.release();
  }
}

// ---------- revoke (DELETE /admin/apps/<slug>) ----------

async function revokePackage(pool, slug, webid) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['model-injection:' + slug]);
    const r = await client.query('SELECT * FROM app.app_packages WHERE slug = $1 FOR UPDATE', [slug]);
    if (!r.rows.length) throw new HttpError(404, 'NotFound', `unknown package "${slug}"`);
    if (r.rows[0].state === 'revoked') throw new HttpError(409, 'Conflict', 'package already revoked');

    // revoked contract → dsp.contracts trigger notifies 'fap_revoked' → PDP cache purge (AC-L9)
    await client.query("UPDATE dsp.contracts SET state = 'revoked' WHERE agreement_id = $1", [r.rows[0].contract_id]);
    // asset removed from the catalog (published=false, row kept for audit, §6)
    await client.query("UPDATE dsp.asset_mapping SET published = false WHERE container_uri LIKE $1", [`/apps/${slug}/%`]);
    await client.query("UPDATE app.app_packages SET state = 'revoked', revoked_at = now() WHERE slug = $1", [slug]);
    // app store catalog entry removed (tombstone → filtered out of the /features/ container,
    // the PEP only lists deleted_at IS NULL) — otherwise the ghost feature stays visible in /store
    await client.query("UPDATE app.features SET deleted_at = now() WHERE slug = $1 AND deleted_at IS NULL", [slug]);
    await audit(client, { agreementId: r.rows[0].contract_id, webid, resourceUri: `/apps/${slug}/`, mode: 'control' });
    await client.query('COMMIT');
    // the store_<slug>_* tables are dropped after the 30-day purge by app.mi_drop_revoked_packages (001_mi_maintenance.sql)
    return { slug };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ---------- boot: idempotent fragment application + drift (AC-B7) ----------

async function applyFragmentsAtBoot(pool, baseIri, log) {
  const base = String(baseIri || 'http://localhost:1880/').replace(/\/?$/, '/');
  const client = await pool.connect();
  const applied = [];
  const drifted = [];
  try {
    await client.query('BEGIN');
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT USAGE, SELECT ON SEQUENCES TO app`);
    const r = await client.query(
      "SELECT slug, version, state, model_fragment, fragment_hash, contract_id, installed_by FROM app.app_packages WHERE state IN ('installed','drift') ORDER BY installed_at");
    for (const row of r.rows) {
      const compiled = compileFragment(row.slug, row.model_fragment);
      for (const t of compiled.tables) {
        for (const stmt of t.statements) await client.query(stmt);
        await client.query(
          `INSERT INTO dsp.asset_mapping (asset_uri, container_uri, table_schema, table_name, resource_iri_pattern, published)
           VALUES ($1,$2,'app',$3,$4,$5)
           ON CONFLICT (asset_uri) DO UPDATE SET container_uri=$2, table_name=$3, resource_iri_pattern=$4, published=$5`,
          [t.container, t.container, t.physical, t.pattern, t.published]);
        // initial ACLs if missing (clean reinstall)
        await client.query(
          `INSERT INTO auth.acl (resource_uri, subject, modes, inherited)
           SELECT $1, $2, '{read,write,control}', true
           WHERE NOT EXISTS (SELECT 1 FROM auth.acl WHERE resource_uri=$1 AND subject=$2)`,
          [base + `apps/${row.slug}/`.replace(/^\//, ''), row.installed_by]);
      }
      // drift: live schema hash (information_schema) vs stored fragment hash (§5)
      const liveHash = crypto.createHash('sha256').update(await liveCanonical(client, row.slug), 'utf8').digest('hex');
      if (liveHash !== row.fragment_hash) {
        drifted.push(row.slug);
        await client.query("UPDATE app.app_packages SET state = 'drift' WHERE slug = $1", [row.slug]);
        await audit(client, { agreementId: row.contract_id, webid: 'boot', resourceUri: `/apps/${row.slug}/`, mode: 'control' });
      } else if (row.state === 'drift') {
        await client.query("UPDATE app.app_packages SET state = 'installed' WHERE slug = $1", [row.slug]);
      }
      applied.push(row.slug);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    throw e;
  }
  client.release();
  for (const slug of drifted) {
    const msg = `fap-ldp ext/model-injection: DRIFT detected on package "${slug}" (live schema ≠ fragment_hash) — state set to 'drift', audit written (§5)`;
    (log || console.error)(msg);
  }
  return { applied, drifted };
}

// ---------- reads (GET /apps/, GET /apps/<slug>/meta) ----------

async function listPackages(pool) {
  const r = await pool.query(
    `SELECT slug, version, sri, state, contract_id, installed_by, installed_at, revoked_at,
            jsonb_object_keys(model_fragment->'tables') AS table_name
     FROM app.app_packages ORDER BY installed_at`);
  const bySlug = {};
  for (const row of r.rows) {
    bySlug[row.slug] = bySlug[row.slug] || { ...row, tables: [] };
    bySlug[row.slug].tables.push(row.table_name);
  }
  return Object.values(bySlug);
}

async function packageMeta(pool, slug) {
  const r = await pool.query(
    `SELECT slug, version, sri, state, contract_id, installed_by, installed_at, revoked_at, model_fragment
     FROM app.app_packages WHERE slug = $1`, [slug]);
  if (!r.rows.length) return null;
  const row = r.rows[0];
  return { ...row, tables: Object.keys(row.model_fragment.tables || {}) };
}

module.exports = { installPackage, revokePackage, applyFragmentsAtBoot, listPackages, packageMeta, HttpError };
