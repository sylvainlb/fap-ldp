// registry.test.mjs — TCK of the object registry (workstream 3 rev 8, status note F3.6
// of app-shape-editor rev 4.2): the /shapes/ index exposes tables[] (ALL tables of the model,
// published or not, with the published flag), and GET /shapes/<table> / /apps/<slug>/shapes/<table>
// serve the single shape in JSON-LD with reg:published (1 shape = 1 JSON = 1 object).
// The published contract stays filtered to published tables only (R1.4/F3.3).
// Run: node --test tck/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createStore } = require('../nodes/lib/store.js');

const BASE = 'https://pod.example/';
const MODEL_PATH = fileURLToPath(new URL('../../../../app-supervision-backend/config/model.json', import.meta.url));

// appendix A v0.4 fragment (semantic keys ratified at the J1 bump)
const PKG_FRAGMENT = {
  supersedes: 'old-fleet@1.0.0',
  tables: {
    vehicles: {
      label_i18n: { en: 'Vehicle', fr: 'Véhicule' },
      fields: {
        plate: { type: 'text', not_null: true, label_i18n: { en: 'Plate', fr: 'Plaque' } },
        status: { type: 'text', check_in: ['ACTIVE', 'RETIRED'], label_i18n: { en: 'Status' } },
      },
    },
  },
};

// fake pool: dsp.asset_mapping (core: buildings+tickets published, users not) + app.app_packages (fleet)
const pool = {
  async query(sql, params) {
    if (sql.includes('dsp.asset_mapping')) {
      return {
        rows: [
          { container_uri: '/buildings/', table_schema: 'app', table_name: 'buildings', published: true },
          { container_uri: '/tickets/', table_schema: 'app', table_name: 'tickets', published: true },
          { container_uri: '/users/', table_schema: 'app', table_name: 'users', published: false },
          { container_uri: '/apps/fleet/vehicles/', table_schema: 'app', table_name: 'store_fleet_vehicles', published: true },
        ],
      };
    }
    if (sql.includes('app.app_packages')) {
      const row = { slug: 'fleet', version: '1.2.0', state: 'installed', fragment_hash: 'fh-fleet', model_fragment: PKG_FRAGMENT };
      if (sql.includes('WHERE slug')) return { rows: params?.[0] === 'fleet' ? [row] : [] };
      return { rows: [row] };
    }
    throw new Error('unexpected query: ' + sql);
  },
};

const store = createStore({ pool, modelPath: MODEL_PATH });
const CORE_TABLES = JSON.parse(readFileSync(MODEL_PATH, 'utf8')).tables;

test('index /shapes/ : each source exposes tables[] — ALL tables, published flag per table', async () => {
  const idx = await store.index(BASE);
  const core = idx.sources.find((s) => s.kind === 'core');
  assert.ok(core, 'core source present');
  assert.equal(core.tables.length, Object.keys(CORE_TABLES).length, 'all core model tables listed');
  const t = Object.fromEntries(core.tables.map((x) => [x.table, x]));
  assert.equal(t.buildings.published, true);
  assert.equal(t.tickets.published, true);
  assert.equal(t.users.published, false, 'unpublished table listed but flagged');
  assert.equal(t.tickets.phys, 'tickets');
  assert.ok(t.tickets.label.en, 'localized label present (map)');
  assert.ok(t.tickets.count > 0 && Array.isArray(t.tickets.fields), 'count + fields[] exposed');
  assert.ok(t.tickets.fields[0].en, 'fields[] = localized labels');
  const pkg = idx.sources.find((s) => s.slug === 'fleet');
  assert.equal(pkg.tables.length, 1);
  assert.equal(pkg.tables[0].table, 'vehicles', 'logical name on the package side');
  assert.equal(pkg.tables[0].phys, 'store_fleet_vehicles', 'physical name (R1.2)');
  assert.equal(pkg.tables[0].published, true);
  assert.deepEqual(pkg.tables[0].label, { en: 'Vehicle', fr: 'Véhicule' }, 'label_i18n → map localisée');
});

test('registryOf : full core + package registry (1 shape = 1 object)', async () => {
  const reg = await store.registryOf('core', BASE);
  assert.equal(reg.length, Object.keys(CORE_TABLES).length);
  const pkgReg = await store.registryOf('fleet', BASE);
  assert.deepEqual(pkgReg.map((t) => t.table), ['vehicles']);
  assert.equal(await store.registryOf('unknown', BASE), null, 'unknown package → null');
});

test('shapeOf : single JSON-LD shape + embedded reg:published (1 shape = 1 JSON = 1 object)', async () => {
  const sh = await store.shapeOf('core', 'tickets', BASE);
  assert.ok(sh, 'tickets shape found');
  assert.equal(sh['@type'], 'sh:NodeShape');
  assert.equal(sh['sh:targetClass']?.['@id'] ?? sh['sh:targetClass'], `${BASE}ns/app/tickets#`);
  assert.equal(sh['reg:published'], true, 'publication flag embedded');
  assert.ok(Array.isArray(sh['sh:property']) && sh['sh:property'].length > 0);
  const users = await store.shapeOf('core', 'users', BASE);
  assert.equal(users['reg:published'], false, 'unpublished table: shape served, flag false');
  assert.equal(await store.shapeOf('core', 'nope', BASE), null, 'unknown table → null (404 at HTTP layer)');
  const pkgSh = await store.shapeOf('fleet', 'vehicles', BASE);
  assert.equal(pkgSh['sh:targetClass']?.['@id'] ?? pkgSh['sh:targetClass'], `${BASE}ns/app/store_fleet_vehicles#`);
  assert.equal(pkgSh['reg:published'], true);
  // by physical name too
  assert.equal((await store.shapeOf('fleet', 'store_fleet_vehicles', BASE))?.['@id'], pkgSh['@id']);
  // package contract: @id = the IRI of ITS OWN contract (not the core one)
  const c = await store.contract('fleet', BASE);
  assert.equal(c.jsonld['@id'], `${BASE}apps/fleet/shapes`);
});

test('published contract unchanged: only published tables appear in it (R1.4/F3.3)', async () => {
  const c = await store.contract('core', BASE);
  const shapes = c.jsonld['@graph'].filter((n) => n['@type'] === 'sh:NodeShape');
  const targets = shapes.map((s) => s['sh:targetClass']?.['@id'] ?? s['sh:targetClass']).sort();
  assert.deepEqual(targets, [`${BASE}ns/app/buildings#`, `${BASE}ns/app/tickets#`], 'contract = published tables only');
});

test('rev 4.5 — tables[] carries the internal flag (system tables of the server itself)', async () => {
  const idx = await store.index(BASE);
  const core = idx.sources.find((s) => s.kind === 'core');
  const t = Object.fromEntries(core.tables.map((x) => [x.table, x]));
  assert.equal(t.components.internal, true, 'components = system table');
  assert.equal(t.ai_models.internal, true, 'ai_models = system table');
  assert.equal(t.user_components.internal, true, 'user_components = system table');
  assert.equal(t.buildings.internal, false, 'business table is not internal');
  assert.equal(t.users.internal, false, 'users is business (unpublished), not system');
  // package side: no internal key → false
  const pkg = idx.sources.find((s) => s.slug === 'fleet');
  assert.equal(pkg.tables[0].internal, false);
});
