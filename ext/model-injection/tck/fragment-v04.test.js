// fragment-v04.test.js — J1 (app-shape-editor rev 4): appendix A v0.4 semantic keys.
// Additive bump: existing tck/fragment.test.js must pass UNCHANGED (C6). Run: node --test tck/
const test = require('node:test');
const assert = require('node:assert');
const { validateFragment, compileFragment, fragmentHash, FragmentError } = require('../nodes/lib/fragment');

const base = () => ({
  tables: {
    vehicles: {
      pk: 'id', published: true,
      fields: {
        id: { type: 'bigint', serial: true },
        registration: { type: 'text', not_null: true, unique: true },
        created_by: { type: 'bigint', fk: 'users' }
      }
    }
  }
});

test('v0.4: full semantic profile validates (root supersedes, table keys, field keys)', () => {
  const f = base();
  f.supersedes = 'old_app@1.0.0';
  const t = f.tables.vehicles;
  t.align_class = 'https://schema.org/Vehicle';
  t.label_i18n = { en: 'Vehicle', fr: 'Véhicule' };
  t.contract_exclude = ['registration'];
  t.fields.registration.node_kind = 'literal';
  t.fields.registration.lang = false;
  t.fields.registration.align = 'dcterms:identifier'; // prefixed form accepted
  t.fields.registration.label_i18n = { en: 'Plate' };
  assert.strictEqual(validateFragment(f), true);
});

test('v0.4: unknown keys still rejected 422 schema_violation (additionalProperties:false)', () => {
  const f = base();
  f.tables.vehicles.fields.id.bogus = 1;
  assert.throws(() => validateFragment(f), e => e instanceof FragmentError && e.code === 'schema_violation');
  const g = base();
  g.tables.vehicles.bogus = 1;
  assert.throws(() => validateFragment(g), e => e.code === 'schema_violation');
  const h = base();
  h.bogus = 1;
  assert.throws(() => validateFragment(h), e => e.code === 'schema_violation');
});

test('v0.4/A.2: reserved table names (meta|shapes|validate|fragment) rejected', () => {
  for (const name of ['meta', 'shapes', 'validate', 'fragment']) {
    const f = { tables: { [name]: base().tables.vehicles } };
    assert.throws(() => validateFragment(f), e => e.code === 'schema_violation' && /reserved/.test(e.message), name);
  }
});

test('v0.4: validation rules on the new keys', () => {
  const bad = (mutate, code = 'schema_violation') => {
    const f = base(); mutate(f);
    assert.throws(() => validateFragment(f), e => e.code === code, JSON.stringify(mutate));
  };
  bad(f => { f.supersedes = 'Bad Slug@1'; });
  bad(f => { f.supersedes = 'ok@1^2'; });            // version must be pinned without ^
  bad(f => { f.tables.vehicles.fields.id.node_kind = 'blank'; });
  bad(f => { f.tables.vehicles.fields.id.lang = 'yes'; });
  bad(f => { f.tables.vehicles.fields.id.align = 'not an iri'; });
  bad(f => { f.tables.vehicles.label_i18n = { fr: 'Véhicule' }; });          // pivot en mandatory (R1.1)
  bad(f => { f.tables.vehicles.label_i18n = { en: 42 }; });
  bad(f => { f.tables.vehicles.contract_exclude = ['nope']; });               // unknown field
  bad(f => { f.tables.vehicles.contract_exclude = 'id'; });
  bad(f => { f.tables.vehicles.align_class = 42; });
});

test('v0.4 drift-safety: fragment_hash ignores semantic keys (canonicalForCompare strips them)', () => {
  const plain = base();
  const annotated = base();
  annotated.supersedes = 'x@1.0.0';
  annotated.tables.vehicles.align_class = 'https://schema.org/Vehicle';
  annotated.tables.vehicles.label_i18n = { en: 'Vehicle' };
  annotated.tables.vehicles.contract_exclude = ['registration'];
  annotated.tables.vehicles.fields.registration.align = 'dcterms:identifier';
  annotated.tables.vehicles.fields.registration.lang = true;
  annotated.tables.vehicles.fields.registration.label_i18n = { en: 'Plate', fr: 'Plaque' };
  assert.strictEqual(fragmentHash(annotated), fragmentHash(plain));
});

test('v0.4 DDL-safety: compileFragment emits identical SQL with and without annotations', () => {
  const plain = compileFragment('fleet', base());
  const annotated = base();
  annotated.supersedes = 'old@1.0.0';
  annotated.tables.vehicles.align_class = 'https://schema.org/Vehicle';
  annotated.tables.vehicles.label_i18n = { en: 'Vehicle' };
  annotated.tables.vehicles.contract_exclude = ['registration'];
  annotated.tables.vehicles.fields.registration.align = 'dcterms:identifier';
  annotated.tables.vehicles.fields.registration.node_kind = 'iri';
  const ann = compileFragment('fleet', annotated);
  assert.deepStrictEqual(ann, plain); // semantic keys never reach the DDL
});
