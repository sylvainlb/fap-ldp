// reload-core.test.mjs — TCK of the core-model hot reload (E11 POST /admin/model → GET /shapes
// serves the NEW contract without restart). The store cache is keyed by rawHash; reloadCore()
// purges the core:* entries (package entries untouched). Run: node --test tck/
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createStore } = require('../nodes/lib/store.js');

const BASE = 'https://pod.example/';

// fake pool: dsp.asset_mapping only (core tables, published flags drive the contract filter)
function fakePool(publishedContainers) {
  return {
    async query(sql) {
      if (sql.includes('dsp.asset_mapping')) {
        return {
          rows: publishedContainers.map(([uri, table, published]) => ({
            container_uri: uri, table_schema: 'app', table_name: table, published
          }))
        };
      }
      if (sql.includes('app.app_packages')) return { rows: [] };
      throw new Error('unexpected query: ' + sql.slice(0, 60));
    }
  };
}

const MODEL_V1 = {
  base_iri: BASE,
  tables: {
    buildings: {
      pk: 'id', published: true,
      fields: { id: 'bigserial', name: 'text not null', created_at: 'timestamptz default now()', updated_at: 'timestamptz default now()' }
    }
  }
};
const MODEL_V2 = JSON.parse(JSON.stringify(MODEL_V1));
MODEL_V2.tables.buildings.fields.area_m2 = 'numeric'; // hot-added column
const MODEL_V3 = JSON.parse(JSON.stringify(MODEL_V2));
MODEL_V3.tables.sites = { // hot-added table
  pk: 'id', published: true,
  fields: { id: 'bigserial', label: 'text not null', created_at: 'timestamptz default now()', updated_at: 'timestamptz default now()' }
};

function setup(model) {
  const dir = mkdtempSync(join(tmpdir(), 'shacl-reload-'));
  const modelPath = join(dir, 'model.json');
  writeFileSync(modelPath, JSON.stringify(model, null, 1) + '\n');
  const store = createStore({ pool: fakePool([['/buildings/', 'buildings', true], ['/sites/', 'sites', true]]), modelPath });
  return { dir, modelPath, store };
}

test('reloadCore: GET /shapes-equivalent serves the new contract after a hot model patch, no restart', async () => {
  const { dir, modelPath, store } = setup(MODEL_V1);
  try {
    // first read compiles + caches (keyed by rawHash)
    const c1 = await store.contract('core', BASE);
    assert.ok(c1.hash);
    assert.ok(c1.turtle.includes('buildings#nameProperty') || c1.shapes.some(s => s.iri.includes('buildings')));
    assert.ok(!c1.shapes.some(s => s.iri.includes('sites')), 'v1: no sites shape');
    assert.ok(store.cacheSize() >= 1, 'cache warm');

    // E11 POST /admin/model rewrites model.json (v2: +column) — same process or pg_notify fap_core_model
    writeFileSync(modelPath, JSON.stringify(MODEL_V2, null, 1) + '\n');
    const purged = store.reloadCore();
    assert.ok(purged >= 1, 'core:* entries purged');
    const c2 = await store.contract('core', BASE);
    assert.notEqual(c2.hash, c1.hash, 'new contract compiled');
    const bShape = c2.shapes.find(s => s.iri.includes('buildings'));
    assert.ok(bShape.properties.some(p => p.iri.endsWith('#area_m2Property')), 'new column in the served contract');

    // v3: +table sites
    writeFileSync(modelPath, JSON.stringify(MODEL_V3, null, 1) + '\n');
    store.reloadCore();
    const c3 = await store.contract('core', BASE);
    assert.notEqual(c3.hash, c2.hash);
    assert.ok(c3.shapes.some(s => s.iri.includes('sites')), 'new table shape served');
    // fragmentOf serves the new raw hash (what the editor sends back as If-Match)
    const f = await store.fragmentOf('core');
    assert.equal(f.fragmentHash, c3 ? require('node:crypto').createHash('sha256').update(readFileSync(modelPath, 'utf8')).digest('hex') : null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reloadCore purges only core:* entries (package cache untouched) + clearCache still global', async () => {
  const { dir, store } = setup(MODEL_V1);
  try {
    await store.contract('core', BASE);
    assert.ok(store.cacheSize() >= 1);
    // simulate a package cache entry
    store.contract; // (package entries are keyed pkg:<slug>:<hash>)
    const before = store.cacheSize();
    const purged = store.reloadCore();
    assert.equal(purged, before, 'all warm entries were core:* here');
    assert.equal(store.cacheSize(), 0);
    store.clearCache(); // still available for fap_revoked
    assert.equal(store.cacheSize(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
