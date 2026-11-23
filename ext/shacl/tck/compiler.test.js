// compiler.test.js — ext/shacl TCK, unit level (no PG needed): run with `node --test tck/`
// Covers spec app-shape-editor rev 4: F2.1 mappings, R1.2 physical IRIs, R1.4 exclusions,
// F2.5 no sh:closed, F5.3 idempotence, F5.4 semantic keys, C3 align, F3.3 published scope.
const test = require('node:test');
const assert = require('node:assert');
const { compile } = require('../nodes/lib/compiler');

const BASE = 'https://pod.example/';

const fragment = {
  supersedes: 'old-app@1.0.0',
  tables: {
    vehicules: {
      pk: 'id',
      published: true,
      label_i18n: { en: 'Vehicle', fr: 'Véhicule' },
      contract_exclude: ['internal_note'],
      fields: {
        id: { type: 'bigint', serial: true },
        immatriculation: { type: 'text', not_null: true, unique: true, label_i18n: { en: 'Plate' } },
        type: { type: 'text', check_in: ['voiture', 'camion', 'velo'] },
        prix: { type: 'numeric' },
        actif: { type: 'boolean' },
        created_by: { type: 'bigint', fk: 'users', node_kind: 'iri' },
        created_at: { type: 'timestamptz', default: 'now()' },
        updated_at: { type: 'timestamptz', default: 'now()' },
        deleted_at: { type: 'timestamptz' },
        internal_note: { type: 'text' },
        description: { type: 'text', lang: true, align: 'dcterms:description' },
        reference: { type: 'text', node_kind: 'iri' },
        meta: { type: 'jsonb' },
        vu_le: { type: 'timestamptz' }
      }
    },
    garages: { pk: 'id', published: false, fields: { id: { type: 'bigint', serial: true }, nom: { type: 'text' } } }
  }
};

test('F2.1 type mappings + not_null + check_in + fk anchor + node_kind + lang', () => {
  const { turtle } = compile({ fragment, baseIri: BASE, slug: 'flotte' });
  assert.match(turtle, /sh:datatype xsd:string/);
  assert.match(turtle, /sh:datatype xsd:decimal/);   // numeric
  assert.match(turtle, /sh:datatype xsd:boolean/);
  assert.match(turtle, /sh:datatype xsd:dateTime/);    // timestamptz
  assert.match(turtle, /sh:datatype xsd:integer/);     // bigint (via created_by)
  assert.match(turtle, /sh:minCount 1/);               // not_null
  assert.match(turtle, /sh:in \( "camion" "velo" "voiture" \)/); // check_in, sorted → canonical
  assert.match(turtle, /sh:nodeKind sh:IRI/);          // node_kind: iri + fk
  assert.match(turtle, /sh:class <https:\/\/pod\.example\/ns\/app\/users#Shape>/); // fk users → core contract
  assert.match(turtle, /sh:datatype rdf:langString/);  // lang: true
  assert.match(turtle, /sh:path <http:\/\/purl\.org\/dc\/terms\/description>/); // align prefix expanded
});

test('R1.2/R1.3 IRIs on PHYSICAL table name for packages (store_<slug>_<table>)', () => {
  const { turtle } = compile({ fragment, baseIri: BASE, slug: 'flotte' });
  assert.match(turtle, /<https:\/\/pod\.example\/ns\/app\/store_flotte_vehicules#Shape>/);
  assert.match(turtle, /sh:path <https:\/\/pod\.example\/ns\/app\/store_flotte_vehicules#immatriculation>/);
  assert.match(turtle, /sh:targetClass <https:\/\/pod\.example\/ns\/app\/store_flotte_vehicules#Store_flotte_vehicules>/); // served @type = prefix:Camel(table)
  assert.doesNotMatch(turtle, /ns\/app\/vehicules#/); // logical name never used for IRIs
});

test('R1.2 core model: physical = table name', () => {
  const core = { tables: { tickets: { pk: 'id', fields: { id: { type: 'bigint', serial: true }, status: { type: 'text' } } } } };
  const { turtle } = compile({ fragment: core, baseIri: BASE, slug: null });
  assert.match(turtle, /<https:\/\/pod\.example\/ns\/app\/tickets#Shape>/);
  assert.match(turtle, /sh:targetClass <https:\/\/pod\.example\/ns\/app\/tickets#Tickets>/);
  assert.match(turtle, /sh:path <https:\/\/pod\.example\/ns\/app\/tickets#status>/);
});

test('R1.4 service fields + contract_exclude excluded; jsonb omitted (F2.1)', () => {
  const { turtle } = compile({ fragment, baseIri: BASE, slug: 'flotte' });
  for (const f of ['id', 'created_at', 'updated_at', 'deleted_at', 'internal_note', 'meta']) {
    assert.ok(!turtle.includes('#' + f + 'Property'), `field ${f} must not appear in the contract`);
  }
});

test('F2.5 never sh:closed', () => {
  const { turtle } = compile({ fragment, baseIri: BASE, slug: 'flotte' });
  assert.doesNotMatch(turtle, /sh:closed/);
});

test('F5.3 idempotence: same fragment → same hash, byte-identical Turtle', () => {
  const a = compile({ fragment, baseIri: BASE, slug: 'flotte' });
  const b = compile({ fragment, baseIri: BASE, slug: 'flotte' });
  assert.strictEqual(a.hash, b.hash);
  assert.strictEqual(a.turtle, b.turtle);
  assert.match(a.hash, /^[0-9a-f]{64}$/);
});

test('F5.4/C3 semantic keys: align wins over local IRI; without align → local convention', () => {
  const withAlign = compile({ fragment, baseIri: BASE, slug: 'flotte' });
  assert.match(withAlign.turtle, /sh:path <http:\/\/purl\.org\/dc\/terms\/description>/); // dcterms:description expanded
  const noAlign = JSON.parse(JSON.stringify(fragment));
  delete noAlign.tables.vehicules.fields.description.align;
  const without = compile({ fragment: noAlign, baseIri: BASE, slug: 'flotte' });
  assert.match(without.turtle, /sh:path <https:\/\/pod\.example\/ns\/app\/store_flotte_vehicules#description>/);
});

test('R1.1 label_i18n → sh:name (pivot en) + rdfs:label per locale', () => {
  const { turtle } = compile({ fragment, baseIri: BASE, slug: 'flotte' });
  assert.match(turtle, /sh:name "Vehicle"/);
  assert.match(turtle, /rdfs:label "Vehicle"@en/);
  assert.match(turtle, /rdfs:label "V\u00e9hicule"@fr/);
  assert.match(turtle, /sh:name "Plate"/); // field-level label
});

test('align_class replaces sh:targetClass', () => {
  const f = { tables: { t: { pk: 'id', align_class: 'https://schema.org/Vehicle', fields: { id: { type: 'bigint', serial: true }, n: { type: 'text' } } } } };
  const { turtle } = compile({ fragment: f, baseIri: BASE, slug: 'x' });
  assert.match(turtle, /sh:targetClass <https:\/\/schema\.org\/Vehicle>/);
});

test('F3.3/F3.4 published scope: unpublished table has no shape in the contract', () => {
  const all = compile({ fragment, baseIri: BASE, slug: 'flotte' });
  assert.match(all.turtle, /store_flotte_garages#Shape/); // published=null → all tables
  const pubOnly = compile({ fragment, baseIri: BASE, slug: 'flotte', published: new Set(['vehicules']) });
  assert.match(pubOnly.turtle, /store_flotte_vehicules#Shape/);
  assert.doesNotMatch(pubOnly.turtle, /garages/);
});

test('JSON-LD serialization is offered and deterministic', () => {
  const a = compile({ fragment, baseIri: BASE, slug: 'flotte' });
  const b = compile({ fragment, baseIri: BASE, slug: 'flotte' });
  assert.strictEqual(JSON.stringify(a.jsonld), JSON.stringify(b.jsonld));
  assert.ok(Array.isArray(a.jsonld['@graph']));
  const ps = a.jsonld['@graph'].find(n => n['@type'] === 'sh:PropertyShape' && n['sh:path']['@id'].endsWith('#immatriculation'));
  assert.strictEqual(ps['sh:datatype'], 'xsd:string');
  assert.strictEqual(ps['sh:minCount'], 1);
});
