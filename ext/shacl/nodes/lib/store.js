// store.js — ext/shacl: read-only access to the real sources of truth + compiled-contract cache.
//   - packages: app.app_packages (slug, version, state, model_fragment, fragment_hash)
//   - published scope: dsp.asset_mapping (published flag per container) — spec §2
//   - core model: config model.json (FAP_LDP_CONFIG or config.modelPath)
// Compilation is lazy (F3.1): first read compiles, cache indexed by fragment_hash; the boot
// node only prewarms. Revocation (pg_notify fap_revoked) clears the cache (C2).
const fs = require('fs');
const crypto = require('crypto');
const { compile } = require('./compiler');

function createStore({ pool, modelPath }) {
  const cache = new Map(); // fragment_hash → { turtle, jsonld, hash, shapes }

  function canonicalHash(obj) {
    // deterministic JSON (sorted keys) → sha256, used for the core model.json hash
    const s = JSON.stringify(sortDeep(obj));
    return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
  }
  function sortDeep(v) {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortDeep(v[k])]));
    }
    return v;
  }

  async function publishedMaps() {
    // dsp.asset_mapping: container_uri '/apps/<slug>/<table>/' (packages) or core containers
    const r = await pool.query(
      'SELECT container_uri, table_schema, table_name, published FROM dsp.asset_mapping');
    const core = new Set();
    const pkgs = new Map(); // slug → Set(logical table)
    for (const row of r.rows) {
      if (!row.published) continue;
      const m = String(row.container_uri || '').match(/^\/apps\/([^/]+)\/([^/]+)\/?$/);
      if (m) {
        if (!pkgs.has(m[1])) pkgs.set(m[1], new Set());
        pkgs.get(m[1]).add(m[2]);
      } else if (row.table_schema === 'app' && !String(row.container_uri || '').startsWith('/apps/')) {
        core.add(row.table_name);
      }
    }
    return { core, pkgs };
  }

  async function loadPackage(slug) {
    const r = await pool.query(
      `SELECT slug, version, state, model_fragment, fragment_hash FROM app.app_packages WHERE slug = $1`,
      [slug]);
    return r.rows[0] || null;
  }

  async function listPackages() {
    const r = await pool.query(
      `SELECT slug, version, state, fragment_hash, model_fragment FROM app.app_packages ORDER BY installed_at`);
    return r.rows;
  }

  function loadCoreModel() {
    const raw = fs.readFileSync(modelPath, 'utf8');
    return { model: JSON.parse(raw), rawHash: crypto.createHash('sha256').update(raw, 'utf8').digest('hex') };
  }

  function compileCached(fragment, baseIri, slug, published, hashKey) {
    if (cache.has(hashKey)) return cache.get(hashKey);
    const out = compile({ fragment, baseIri, slug, published });
    cache.set(hashKey, out);
    return out;
  }

  // kind: 'core' | slug of a package. Returns null when no contract is exposed
  // (unknown/revoked package, or no published table — F3.3/F3.4).
  async function contract(kind, baseIri) {
    const pub = await publishedMaps();
    if (kind === 'core') {
      const { model, rawHash } = loadCoreModel();
      return compileCached(model, baseIri, null, pub.core.size ? pub.core : null, 'core:' + rawHash);
    }
    const pkg = await loadPackage(kind);
    if (!pkg || pkg.state === 'revoked') return null;
    const published = pub.pkgs.get(kind) || new Set();
    return compileCached(pkg.model_fragment, baseIri, kind, published, `pkg:${kind}:${pkg.fragment_hash}`);
  }

  async function fragmentOf(kind) {
    if (kind === 'core') {
      const { model, rawHash } = loadCoreModel();
      return { kind: 'core', model, fragmentHash: rawHash };
    }
    const pkg = await loadPackage(kind);
    if (!pkg) return null;
    return {
      kind: 'package', slug: pkg.slug, version: pkg.version, state: pkg.state,
      fragmentHash: pkg.fragment_hash, model: pkg.model_fragment,
      supersedes: pkg.model_fragment && pkg.model_fragment.supersedes || null
    };
  }

  async function index(baseIri) {
    const pub = await publishedMaps();
    const core = loadCoreModel();
    const sources = [{
      kind: 'core', slug: null, contractUri: `${baseIri}shapes`,
      fragmentHash: core.rawHash,
      published: pub.core.size > 0
    }];
    for (const p of await listPackages()) {
      const hasContract = p.state !== 'revoked' && (pub.pkgs.get(p.slug) || new Set()).size > 0;
      sources.push({
        kind: 'package', slug: p.slug, version: p.version, state: p.state,
        contractUri: hasContract ? `${baseIri}apps/${p.slug}/shapes` : null,
        fragmentUri: `${baseIri}apps/${p.slug}/fragment`,
        fragmentHash: p.fragment_hash,
        supersedes: (p.model_fragment && p.model_fragment.supersedes) || null,
        published: hasContract
      });
    }
    return { sources };
  }

  return {
    contract, fragmentOf, index, publishedMaps, loadPackage, listPackages,
    clearCache: () => cache.clear(),
    cacheSize: () => cache.size
  };
}

module.exports = { createStore };
