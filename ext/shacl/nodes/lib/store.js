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
    const sources = [indexEntry({
      kind: 'core', slug: null, version: null, state: 'installed',
      fragmentHash: core.rawHash, supersedes: null, hasContract: pub.core.size > 0,
      tables: tablesFromFragment(core.model, null, baseIri, pub.core, 'core:' + core.rawHash + ':reg')
    }, baseIri)];
    for (const p of await listPackages()) {
      const hasContract = p.state !== 'revoked' && (pub.pkgs.get(p.slug) || new Set()).size > 0;
      sources.push(indexEntry({
        kind: 'package', slug: p.slug, version: p.version, state: p.state,
        fragmentHash: p.fragment_hash, supersedes: (p.model_fragment && p.model_fragment.supersedes) || null,
        hasContract,
        tables: p.state === 'revoked' ? [] : tablesFromFragment(p.model_fragment, p.slug, baseIri, pub.pkgs.get(p.slug) || new Set(), `pkg:${p.slug}:${p.fragment_hash}:reg`)
      }, baseIri));
    }
    return { sources };
  }

  // Registre des objets (chantier 3 rev 8): TOUTES les tables du modèle — publiées ou non —
  // chacune avec son flag published : 1 shape = 1 objet = 1 entrée. Le contrat publié
  // (contract()) ne garde que les tables publiées (R1.4/F3.3) ; le registre liste tout.
  function tablesFromFragment(fragment, slug, baseIri, publishedSet, cacheKey) {
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    // compile SANS filtre published → toutes les shapes
    const full = compile({ fragment, baseIri, slug, published: null });
    const toMap = (labels, fallback) => {
      const m = {};
      for (const l of labels ?? []) m[l.lang ?? 'en'] = l.value;
      if (!Object.keys(m).length) m.en = (typeof fallback === 'object' ? fallback?.en : fallback) ?? '';
      return m;
    };
    const tables = full.shapes.map((sh) => {
      const phys = sh.iri.split('/ns/app/').pop()?.replace(/#.*$/, '') ?? sh.iri;
      const logical = slug ? phys.replace(`store_${slug}_`, '') : phys;
      return {
        table: logical,
        phys,                                        // R1.2: physical PG name
        label: toMap(sh.labels, sh.name),            // localized map { en, fr? }
        published: publishedSet.has(logical),
        count: sh.properties.length,                 // number of contract fields
        fields: sh.properties.map((p) => toMap(p.labels, p.name)), // localized field labels
      };
    });
    cache.set(cacheKey, tables);
    return tables;
  }

  async function registryOf(kind, baseIri) {
    const pub = await publishedMaps();
    if (kind === 'core') {
      const { model, rawHash } = loadCoreModel();
      return tablesFromFragment(model, null, baseIri, pub.core, 'core:' + rawHash + ':reg');
    }
    const pkg = await loadPackage(kind);
    if (!pkg || pkg.state === 'revoked') return null;
    return tablesFromFragment(pkg.model_fragment, kind, baseIri, pub.pkgs.get(kind) || new Set(), `pkg:${kind}:${pkg.fragment_hash}:reg`);
  }

  // Shape unique d'un objet : GET /shapes/<table> (core) / /apps/<slug>/shapes/<table> —
  // chantier 3 rev 8 : la shape en JSON-LD avec reg:published embarqué (null → 404).
  async function shapeOf(kind, table, baseIri) {
    const reg = await registryOf(kind, baseIri);
    const hit = reg?.find((t) => t.table === table || t.phys === table);
    if (!hit) return null;
    const fragment = kind === 'core' ? loadCoreModel().model : (await loadPackage(kind)).model_fragment;
    const full = compile({ fragment, baseIri, slug: kind === 'core' ? null : kind, published: null });
    const shape = full.shapes.find((sh) => sh.iri.endsWith(`/ns/app/${hit.phys}#Shape`));
    if (!shape) return null;
    const node = full.jsonld['@graph'].find((n) => n['@id'] === shape.iri);
    return node ? { ...node, 'reg:published': hit.published } : null;
  }

  return {
    contract, fragmentOf, index, registryOf, shapeOf, publishedMaps, loadPackage, listPackages,
    clearCache: () => cache.clear(),
    cacheSize: () => cache.size
  };
}

// Pure index entry — chantier 3 (app-ui-editor/src/editor.js) reads `sources[]` with
// `contract` (URL) and `package` ('/apps/<slug>/meta'); F3.6 fields (contractUri, state,
// fragmentHash, supersedes…) are kept alongside for the model editor.
function indexEntry(s, baseIri) {
  const isCore = s.kind === 'core';
  const contract = s.hasContract ? (isCore ? `${baseIri}shapes` : `${baseIri}apps/${s.slug}/shapes`) : null;
  return {
    kind: s.kind,
    slug: s.slug,
    version: s.version,
    state: s.state,
    contract,                                   // chantier 3 primary field
    package: isCore ? null : `/apps/${s.slug}/meta`, // chantier 3 fallback derivation
    contractUri: contract,
    fragmentUri: isCore ? `${baseIri}fragment` : `${baseIri}apps/${s.slug}/fragment`,
    fragmentHash: s.fragmentHash,
    supersedes: s.supersedes,
    published: s.hasContract,
    tables: s.tables ?? []                      // chantier 3 rev 8: registre des objets (all tables + flag published)
  };
}

module.exports = { createStore, indexEntry };
