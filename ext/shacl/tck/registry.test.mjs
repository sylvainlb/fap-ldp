// registry.test.mjs — TCK du registre des objets (chantier 3 rev 8, note de statut F3.6
// de app-shape-editor rev 4.2) : l'index /shapes/ expose tables[] (TOUTES les tables du modèle,
// publiées ou non, avec flag published), et GET /shapes/<table> / /apps/<slug>/shapes/<table>
// servent la shape unique en JSON-LD avec reg:published (1 shape = 1 JSON = 1 objet).
// Le contrat publié reste filtré aux seules tables publiées (R1.4/F3.3).
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

// fragment annexe A v0.4 (clés sémantiques ratifiées au bump J1)
const PKG_FRAGMENT = {
  supersedes: 'old-flotte@1.0.0',
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

// pool factice : dsp.asset_mapping (cœur: buildings+tickets publiés, users non) + app.app_packages (flotte)
const pool = {
  async query(sql, params) {
    if (sql.includes('dsp.asset_mapping')) {
      return {
        rows: [
          { container_uri: '/buildings/', table_schema: 'app', table_name: 'buildings', published: true },
          { container_uri: '/tickets/', table_schema: 'app', table_name: 'tickets', published: true },
          { container_uri: '/users/', table_schema: 'app', table_name: 'users', published: false },
          { container_uri: '/apps/flotte/vehicles/', table_schema: 'app', table_name: 'store_flotte_vehicles', published: true },
        ],
      };
    }
    if (sql.includes('app.app_packages')) {
      const row = { slug: 'flotte', version: '1.2.0', state: 'installed', fragment_hash: 'fh-flotte', model_fragment: PKG_FRAGMENT };
      if (sql.includes('WHERE slug')) return { rows: params?.[0] === 'flotte' ? [row] : [] };
      return { rows: [row] };
    }
    throw new Error('unexpected query: ' + sql);
  },
};

const store = createStore({ pool, modelPath: MODEL_PATH });
const CORE_TABLES = JSON.parse(readFileSync(MODEL_PATH, 'utf8')).tables;

test('index /shapes/ : chaque source expose tables[] — TOUTES les tables, flag published par table', async () => {
  const idx = await store.index(BASE);
  const core = idx.sources.find((s) => s.kind === 'core');
  assert.ok(core, 'source cœur présente');
  assert.equal(core.tables.length, Object.keys(CORE_TABLES).length, 'toutes les tables du modèle cœur listées');
  const t = Object.fromEntries(core.tables.map((x) => [x.table, x]));
  assert.equal(t.buildings.published, true);
  assert.equal(t.tickets.published, true);
  assert.equal(t.users.published, false, 'table non publiée listée mais flaguée');
  assert.equal(t.tickets.phys, 'tickets');
  assert.ok(t.tickets.label.en, 'label localisé présent (map)');
  assert.ok(t.tickets.count > 0 && Array.isArray(t.tickets.fields), 'count + fields[] exposés');
  assert.ok(t.tickets.fields[0].en, 'fields[] = labels localisés');
  const pkg = idx.sources.find((s) => s.slug === 'flotte');
  assert.equal(pkg.tables.length, 1);
  assert.equal(pkg.tables[0].table, 'vehicles', 'nom logique côté package');
  assert.equal(pkg.tables[0].phys, 'store_flotte_vehicles', 'nom physique (R1.2)');
  assert.equal(pkg.tables[0].published, true);
  assert.deepEqual(pkg.tables[0].label, { en: 'Vehicle', fr: 'Véhicule' }, 'label_i18n → map localisée');
});

test('registryOf : registre complet cœur + package (1 shape = 1 objet)', async () => {
  const reg = await store.registryOf('core', BASE);
  assert.equal(reg.length, Object.keys(CORE_TABLES).length);
  const pkgReg = await store.registryOf('flotte', BASE);
  assert.deepEqual(pkgReg.map((t) => t.table), ['vehicles']);
  assert.equal(await store.registryOf('inconnu', BASE), null, 'package inconnu → null');
});

test('shapeOf : shape unique JSON-LD + reg:published embarqué (1 shape = 1 JSON = 1 objet)', async () => {
  const sh = await store.shapeOf('core', 'tickets', BASE);
  assert.ok(sh, 'shape tickets trouvée');
  assert.equal(sh['@type'], 'sh:NodeShape');
  assert.equal(sh['sh:targetClass']?.['@id'] ?? sh['sh:targetClass'], `${BASE}ns/app/tickets#`);
  assert.equal(sh['reg:published'], true, 'flag de publication embarqué');
  assert.ok(Array.isArray(sh['sh:property']) && sh['sh:property'].length > 0);
  const users = await store.shapeOf('core', 'users', BASE);
  assert.equal(users['reg:published'], false, 'table non publiée : shape servie, flag false');
  assert.equal(await store.shapeOf('core', 'nope', BASE), null, 'table inconnue → null (404 côté HTTP)');
  const pkgSh = await store.shapeOf('flotte', 'vehicles', BASE);
  assert.equal(pkgSh['sh:targetClass']?.['@id'] ?? pkgSh['sh:targetClass'], `${BASE}ns/app/store_flotte_vehicles#`);
  assert.equal(pkgSh['reg:published'], true);
  // par nom physique aussi
  assert.equal((await store.shapeOf('flotte', 'store_flotte_vehicles', BASE))?.['@id'], pkgSh['@id']);
  // contrat du package : @id = IRI de SON contrat (pas celui du cœur)
  const c = await store.contract('flotte', BASE);
  assert.equal(c.jsonld['@id'], `${BASE}apps/flotte/shapes`);
});

test('contrat publié inchangé : seules les tables publiées y figurent (R1.4/F3.3)', async () => {
  const c = await store.contract('core', BASE);
  const shapes = c.jsonld['@graph'].filter((n) => n['@type'] === 'sh:NodeShape');
  const targets = shapes.map((s) => s['sh:targetClass']?.['@id'] ?? s['sh:targetClass']).sort();
  assert.deepEqual(targets, [`${BASE}ns/app/buildings#`, `${BASE}ns/app/tickets#`], 'contrat = tables publiées seulement');
});
