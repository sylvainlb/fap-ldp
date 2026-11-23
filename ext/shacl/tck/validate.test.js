// validate.test.js — ext/shacl J3 TCK, unit level: `node --test tck/`
// F4.1/C4: W3C SHACL results report over the compiled model; read-only semantics are
// structural (the endpoint never touches the write path — see shacl-serve.js handleValidate).
const test = require('node:test');
const assert = require('node:assert');
const { compile } = require('../nodes/lib/compiler');
const { validate } = require('../nodes/lib/validate');

const BASE = 'https://pod.example/';
const NS = BASE + 'ns/app/store_flotte_vehicules#';
const CORE_NS = BASE + 'ns/app/users#';

const fragment = {
  tables: {
    vehicules: {
      pk: 'id', published: true,
      fields: {
        id: { type: 'bigint', serial: true },
        immatriculation: { type: 'text', not_null: true, check_in: ['AA-111', 'BB-222'] },
        prix: { type: 'numeric' },
        description: { type: 'text', lang: true, align: 'dcterms:description' },
        created_by: { type: 'bigint', fk: 'users', node_kind: 'iri' }
      }
    }
  }
};

const coreModel = {
  tables: { users: { pk: 'id', published: true, fields: { id: { type: 'bigint', serial: true }, name: { type: 'text' } } } }
};

const pkg = compile({ fragment, baseIri: BASE, slug: 'flotte' });
const core = compile({ fragment: coreModel, baseIri: BASE, slug: null });
const shapes = [...core.shapes, ...pkg.shapes]; // F4.1: both graphs when FK users present

function dataDoc(node) {
  return {
    '@context': { ex: NS, core: CORE_NS, dcterms: 'http://purl.org/dc/terms/' },
    '@id': BASE + 'apps/flotte/vehicules/1',
    '@type': NS, // targetClass form (ns#); the served Camel form is also accepted (rev 4.1)
    'ex:immatriculation': 'AA-111',
    'ex:prix': 10.5,
    'dcterms:description': { '@value': 'Camion benne', '@language': 'fr' },
    'ex:created_by': { '@id': BASE + 'users/7' }
  };
}

test('C4: conformant data → sh:conforms true, empty results', () => {
  const doc = dataDoc();
  doc['@graph'] = [doc, { '@id': BASE + 'users/7', '@type': CORE_NS + 'Users', 'core:name': 'Alice' }];
  delete doc['@id']; delete doc['@type']; // wrap: put the vehicle node in @graph too
  const vehicle = dataDoc();
  const rep = validate({ '@context': doc['@context'], '@graph': [vehicle, { '@id': BASE + 'users/7', '@type': CORE_NS + 'Users' }] }, shapes);
  assert.strictEqual(rep['sh:conforms'], true);
  assert.strictEqual(rep['sh:result'].length, 0);
  assert.strictEqual(rep['@type'], 'sh:ValidationReport');
});

test('datatype violation → sh:DatatypeConstraintComponent with sh:value', () => {
  const doc = dataDoc();
  doc['ex:prix'] = 'pas un nombre';
  const rep = validate({ '@context': doc['@context'], '@graph': [doc] }, shapes);
  assert.strictEqual(rep['sh:conforms'], false);
  const r = rep['sh:result'].find(x => x['sh:sourceConstraintComponent']['@id'].endsWith('DatatypeConstraintComponent'));
  assert.ok(r, 'expected a datatype violation');
  assert.strictEqual(r['sh:focusNode']['@id'], BASE + 'apps/flotte/vehicules/1');
});

test('minCount violation (missing not_null field)', () => {
  const doc = dataDoc();
  delete doc['ex:immatriculation'];
  const rep = validate({ '@context': doc['@context'], '@graph': [doc] }, shapes);
  const r = rep['sh:result'].find(x => x['sh:sourceConstraintComponent']['@id'].endsWith('MinCountConstraintComponent'));
  assert.ok(r, 'expected a minCount violation');
});

test('sh:in violation', () => {
  const doc = dataDoc();
  doc['ex:immatriculation'] = 'ZZ-999';
  const rep = validate({ '@context': doc['@context'], '@graph': [doc] }, shapes);
  assert.ok(rep['sh:result'].some(x => x['sh:sourceConstraintComponent']['@id'].endsWith('InConstraintComponent')));
});

test('nodeKind IRI violation (fk as literal)', () => {
  const doc = dataDoc();
  doc['ex:created_by'] = 7;
  const rep = validate({ '@context': doc['@context'], '@graph': [doc] }, shapes);
  assert.ok(rep['sh:result'].some(x => x['sh:sourceConstraintComponent']['@id'].endsWith('NodeKindConstraintComponent')));
});

test('langString: plain literal on a lang field → datatype violation', () => {
  const doc = dataDoc();
  doc['dcterms:description'] = 'no lang tag';
  const rep = validate({ '@context': doc['@context'], '@graph': [doc] }, shapes);
  assert.ok(rep['sh:result'].some(x => x['sh:sourceConstraintComponent']['@id'].endsWith('DatatypeConstraintComponent')));
});

test('sh:class: FK pointing at a node of the wrong class → ClassConstraintComponent', () => {
  const vehicle = dataDoc();
  const wrongUser = { '@id': BASE + 'users/7', '@type': NS + 'Store_flotte_vehicules' }; // not the users class
  const rep = validate({ '@context': { ex: NS, core: CORE_NS, dcterms: 'http://purl.org/dc/terms/' }, '@graph': [vehicle, wrongUser] }, shapes);
  assert.ok(rep['sh:result'].some(x => x['sh:sourceConstraintComponent']['@id'].endsWith('ClassConstraintComponent')));
});

test('per-table endpoint: tableShapeIri restricts focus to that table shape', () => {
  const doc = dataDoc();
  doc['ex:immatriculation'] = 'ZZ-999';
  // validating only the vehicules shape still reports; a shape IRI of another table → no results
  const repOther = validate({ '@context': doc['@context'], '@graph': [doc] }, shapes, { tableShapeIri: BASE + 'ns/app/store_flotte_garages#Shape' });
  assert.strictEqual(repOther['sh:conforms'], true); // no focus nodes for that class
  const rep = validate({ '@context': doc['@context'], '@graph': [doc] }, shapes, { tableShapeIri: NS + 'Shape' });
  assert.strictEqual(rep['sh:conforms'], false);
});
