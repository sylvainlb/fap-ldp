// chantier3-compat.test.mjs — the REAL chantier 3 contract reader (app-ui-editor/src/contract.js)
// must parse what ext/shacl really compiles. Run: node --test tck/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { compile } = require('../nodes/lib/compiler.js');
const { indexEntry } = require('../nodes/lib/store.js');
// chantier 3 consumer (ESM)
const { parseContract, propertyByLocal, propertyByIri, isServiceIri } = await import(
  fileURLToPath(new URL('../../../../app-ui-editor/src/contract.js', import.meta.url)));

const BASE = 'https://pod.example/';
const model = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../../../app-supervision-backend/config/model.json', import.meta.url)), 'utf8'));

test('chantier 3 parseContract reads the compiled CORE contract (demo model.json)', () => {
  const c = compile({ fragment: model, baseIri: BASE, slug: null, published: null });
  const m = parseContract(c.jsonld);
  // ns# form, as the chantier 3 fixture expects; first NodeShape wins for classIri (sorted tables)
  assert.equal(m.classIri, `${BASE}ns/app/buildings#`);
  assert.ok(m.properties.length > 10); // all 4 core tables' properties are in the model
  const title = propertyByLocal(m, 'title');
  assert.equal(title.datatype, 'http://www.w3.org/2001/XMLSchema#string');
  assert.equal(title.minCount, 1);
  const status = propertyByLocal(m, 'status');
  assert.deepEqual(status.in, ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']);
  // FK without node_kind:iri → served form (integer), no classIri (rev 4.1)
  const building = propertyByLocal(m, 'building_id');
  assert.equal(building.datatype, 'http://www.w3.org/2001/XMLSchema#integer');
  assert.equal(building.classIri, undefined);
  // service fields absent from the contract, recognised by isServiceIri (R1.7)
  for (const sf of ['id', 'created_at', 'updated_at', 'deleted_at']) {
    assert.equal(propertyByLocal(m, sf), undefined);
    assert.ok(isServiceIri(`${BASE}ns/app/tickets#${sf}`));
  }
  assert.ok(propertyByIri(m, `${BASE}ns/app/tickets#due_date`) === undefined); // no such column here
});

test('chantier 3 parseContract reads a compiled PACKAGE contract (physical IRIs, align, lang, labels, fk-iri)', () => {
  const fragment = {
    tables: {
      vehicules: {
        pk: 'id', published: true,
        label_i18n: { en: 'Vehicle', fr: 'Véhicule' },
        fields: {
          id: { type: 'bigint', serial: true },
          immatriculation: { type: 'text', not_null: true, check_in: ['AA', 'BB'], label_i18n: { en: 'Plate', fr: 'Plaque' } },
          description: { type: 'text', lang: true, align: 'dcterms:description' },
          created_by: { type: 'bigint', fk: 'users', node_kind: 'iri' }
        }
      }
    }
  };
  const c = compile({ fragment, baseIri: BASE, slug: 'flotte' });
  const m = parseContract(c.jsonld);
  assert.equal(m.classIri, `${BASE}ns/app/store_flotte_vehicules#`); // physical name (R1.2)
  const imm = propertyByLocal(m, 'immatriculation');
  assert.equal(imm.iri, `${BASE}ns/app/store_flotte_vehicules#immatriculation`);
  assert.equal(imm.minCount, 1);
  assert.deepEqual(imm.in, ['AA', 'BB']);
  assert.deepEqual(imm.label, { en: 'Plate', fr: 'Plaque' }); // localized map form
  const desc = propertyByIri(m, 'http://purl.org/dc/terms/description'); // align wins over local IRI
  assert.ok(desc, 'aligned property present by IRI');
  assert.equal(desc.lang, true);                                 // rdf:langString via @type
  assert.equal(desc.datatype, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString');
  const cb = propertyByLocal(m, 'created_by');
  assert.equal(cb.nodeKind, 'http://www.w3.org/ns/shacl#IRI');
  assert.equal(cb.classIri, `${BASE}ns/app/users#`);             // class IRI, ns# form
  // table label
  const shape = c.jsonld['@graph'].find(n => n['@type'] === 'sh:NodeShape');
  assert.deepEqual(shape['rdfs:label'], { en: 'Vehicle', fr: 'Véhicule' });
});

test('index entries carry the fields chantier 3 editor.js reads: contract + package', () => {
  const pkg = indexEntry({ kind: 'package', slug: 'flotte', version: '1.0.0', state: 'installed', fragmentHash: 'h', supersedes: 'old@1.0.0', hasContract: true }, BASE);
  assert.equal(pkg.contract, `${BASE}apps/flotte/shapes`);
  assert.equal(pkg.package, '/apps/flotte/meta'); // editor derives contract URL from it
  const core = indexEntry({ kind: 'core', slug: null, version: null, state: 'installed', fragmentHash: 'h', supersedes: null, hasContract: true }, BASE);
  assert.equal(core.contract, `${BASE}shapes`);
  assert.equal(core.package, null); // editor falls back to '/shapes'
});
