// corepatch.js — ext/model-injection (E11 v1): the POST /admin/model channel, core model hot
// patch (additive only). Orchestration (PG + file), kept OUT of mi-admin.js so it is testable
// via integration-pg.js style TCK (handleAdminModel is RED-free):
//
//   handleAdminModel({ pool, modelPath, baseIri, claims, method, ifMatch, body })
//     → { status: 200, body: { hash, contract } } | { status, code, message }
//
// Flow (invariants v1): admin only · If-Match obligatoire (sha256 of the raw model.json, the
// same hash GET /fragment serves) · validate (422) · diff additif-only (422 si refused) ·
// ONE PG transaction (advisory lock + DDL + asset_mapping + ACL + signed contract in
// dsp.contracts + audit — jamais de DDL partiel) · hot-reload (global.__fapShaclStore.reloadCore() + pg_notify
// Ordre v1.1: écriture atomique de model.json D'ABORD (.bak, tmp + rename) — si la transaction PG
// échoue, le fichier est restauré depuis .bak (jamais de drift fichier/DB).
// fap_core_model) → 200. No secret (token, password) is ever logged — only hashes and counts.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { FragmentError, quoteIdent } = require('./fragment');
const { diffCoreModel, compileCoreDdl, mergeCoreModel } = require('./diff');
const coreLib = (() => {
  try { return require('node-red-contrib-fap-ldp/lib/core-model.js'); }
  catch { return require('../../../../core/nodes/lib/core-model.js'); }
})();

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function sha256(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }

// If-Match: "<hash>" (strong or weak W/"…") — '*' accepted (force), anything else must equal
function normalizeIfMatch(h) {
  if (h === undefined || h === null || h === '') return null;
  return String(h).trim().replace(/^W\//i, '').replace(/^"|"$/g, '');
}

// optional cross-ext compile of the published contract (for the signed hash) — best effort
function compileShacl(fragment, baseIri) {
  try {
    const mod = (() => {
      try { return require('node-red-contrib-fap-ldp-shacl/nodes/lib/compiler.js'); }
      catch { return require('../../../shacl/nodes/lib/compiler.js'); }
    })();
    return mod.compile({ fragment, baseIri, slug: null, published: null });
  } catch { return null; }
}

// atomic write: backup <path>.bak, tmp file + rename. On failure, restore the backup.
function writeModelAtomic(modelPath, content) {
  const bak = modelPath + '.bak';
  const existed = fs.existsSync(modelPath);
  if (existed) fs.copyFileSync(modelPath, bak); // backup BEFORE any write
  const tmp = modelPath + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, modelPath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    if (existed) { try { fs.copyFileSync(bak, modelPath); } catch {} }
    throw e;
  }
  return { backup: existed ? bak : null };
}

async function audit(client, { agreementId, webid, resourceUri, mode }) {
  return client.query(
    'INSERT INTO dsp.audit (agreement_id, webid, resource_uri, mode, decision) VALUES ($1,$2,$3,$4,$5)',
    [agreementId || null, webid || null, resourceUri || null, mode || 'control', 'allow']);
}

async function handleAdminModel(opts) {
  const { pool, modelPath, baseIri, claims, method = 'POST', ifMatch, body } = opts;
  const base = String(baseIri || 'http://localhost:1880/').replace(/\/?$/, '/');
  const err = (status, code, message) => ({ status, code, message });

  if (!claims) return err(401, 'Unauthorized', 'authentication required');
  if (claims.role !== 'admin') return err(403, 'Forbidden', 'admin role required (v1, §3.2)');
  if (method !== 'POST') return err(405, 'MethodNotAllowed', `${method} not allowed on /admin/model (any status ≠ 404 means the channel exists)`);

  const model = body && body.model;
  if (!model || typeof model !== 'object' || Array.isArray(model))
    return err(422, 'schema_violation', 'body must be { "model": <fragment annexe A> }');

  // ---- read cœur + hash (same raw sha256 as GET /fragment / store.loadCoreModel) ----
  let raw;
  try { raw = fs.readFileSync(modelPath, 'utf8'); }
  catch (e) { throw new Error(`core model not readable at ${modelPath}: ${e.message}`); }
  const currentHash = sha256(raw);
  const currentModel = JSON.parse(raw);

  const want = normalizeIfMatch(ifMatch);
  if (!want) return err(428, 'PreconditionRequired', 'If-Match header required (sha256 of the current model.json, see GET /fragment)');
  if (want !== '*' && want !== currentHash)
    return err(409, 'Conflict', 'If-Match stale: the core model changed on the server since it was read (reload, GET /fragment)');

  // ---- validate (422) + diff additif-only (422 si refused) ----
  const rawBytes = Buffer.byteLength(JSON.stringify(model), 'utf8');
  let diff;
  try {
    diff = diffCoreModel(currentModel, model, rawBytes);
  } catch (e) {
    if (e instanceof FragmentError) return err(422, e.code, e.message);
    throw e;
  }
  if (diff.refused.length) {
    const r = diff.refused[0];
    const what = r.field ? `${r.table}.${r.field}` : (r.key ? `${r.table}.${r.key}` : r.table);
    return err(422, 'non_additive',
      `v1 additif-only: ${r.reason} on ${what} (${diff.refused.length} refused change(s)) — drop/rename/change-type are out of scope v1`);
  }

  // ---- merged core model (core dialect) + new hash ----
  const merged = mergeCoreModel(currentModel, model, diff);
  const newRaw = JSON.stringify(merged, null, 1) + '\n';
  const newHash = sha256(newRaw);
  const webid = claims.webid || claims.did || null;

  // recompile the published contract (pure) for the signature — best effort
  const compiled = compileShacl(merged, base);

  // ---- atomic write of model.json FIRST (.bak backup, tmp + rename); restored if the DB tx fails ----
  let written;
  try {
    written = writeModelAtomic(modelPath, newRaw);
  } catch (e) {
    throw new Error(`model.json write failed (nothing committed to the DB): ${e.message}`);
  }

  // ---- ONE PG transaction: DDL + mapping + ACL + signed contract + audit ----
  const client = await pool.connect();
  let agreementId, signature;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['model-injection:core-model']);

    // a create must not collide with an existing app.* table outside the model
    for (const c of diff.creates) {
      const exists = await client.query('SELECT to_regclass($1) IS NOT NULL AS ok', ['app.' + c.table]);
      if (exists.rows[0].ok)
        throw new FragmentError('prefix_collision', `table app.${c.table} already exists outside the core model`);
    }

    if (diff.creates.length || diff.alters.length) {
      await client.query('ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app');
      await client.query('ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT USAGE, SELECT ON SEQUENCES TO app');
      const ddl = compileCoreDdl(diff);
      for (const s of ddl.statements) await client.query(s);
      // mapping + initial ACLs (façon 102_acl_init.sql) of the NEW tables only
      for (const c of ddl.creates) {
        await coreLib.registerMapping(client, c.table,
          { ...(model.tables[c.table] || {}), pk: (model.tables[c.table] || {}).pk }, base, merged);
        await coreLib.insertAcl(client, coreLib.aclRows(base, c.table, model.tables[c.table] || {}));
      }
    }

    // ---- signed republished contract in dsp.contracts (hash chain: new ← previous) ----
    agreementId = `agr-core-model-${newHash.slice(0, 12)}-${Date.now()}`;
    signature = sha256([agreementId, newHash, currentHash, compiled ? compiled.hash : '', webid || ''].join(':'));
    const policy = {
      '@context': { facis: 'https://facis.eu/ns#' },
      'facis:modelContract': {
        uri: base + 'shapes',
        model_hash: newHash,
        previous_model_hash: currentHash,
        contract_hash: compiled ? compiled.hash : null,
        algorithm: 'sha256',
        signature,
        signed_by: webid,
        additive: { creates: diff.creates.length, alters: diff.alters.length }
      }
    };
    await client.query(
      `INSERT INTO dsp.contracts (asset_uri, assignee_did, policy_jsonld, state, agreement_id)
       VALUES ($1, $2, $3, 'active', $4)`,
      [base, webid, policy, agreementId]);

    await audit(client, { agreementId, webid, resourceUri: base + 'shapes', mode: 'control' });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    // v1.1: rollback fichier aussi — the model.json on disk stays at the pre-request state
    try { if (written && written.backup) fs.copyFileSync(written.backup, modelPath); } catch {}
    if (e instanceof FragmentError) return err(422, e.code, e.message);
    if (e instanceof HttpError) return err(e.status, e.code, e.message);
    throw e;
  } finally {
    client.release();
  }

  // ---- hot-reload: invalidate the shacl store cache (keyed by rawHash) + pg_notify ----
  try {
    const store = global.__fapShaclStore;
    if (store && typeof store.reloadCore === 'function') store.reloadCore();
  } catch {}
  await pool.query("SELECT pg_notify('fap_core_model', $1)", [newHash]).catch(() => {});

  return {
    status: 200,
    body: {
      hash: newHash,
      contract: {
        agreement_id: agreementId,
        uri: base + 'shapes',
        model_hash: newHash,
        previous_model_hash: currentHash,
        contract_hash: compiled ? compiled.hash : null,
        signature,
        algorithm: 'sha256',
        signed_by: webid,
        creates: diff.creates.map(c => c.table),
        alters: diff.alters.map(a => `${a.table}.${a.field}`),
        backup: written.backup
      }
    }
  };
}

module.exports = { handleAdminModel, writeModelAtomic, normalizeIfMatch, HttpError, sha256 };
