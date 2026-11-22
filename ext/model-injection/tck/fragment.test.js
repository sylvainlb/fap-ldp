// fragment.test.js — unit tests of the fragment validator/compiler (ext/model-injection).
// No external dependency, no PG: node --test ext/model-injection/tck/fragment.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  validateFragment, compileFragment, fragmentHash, canonicalForCompare, stableStringify,
  FragmentError, quoteIdent, quoteLiteral, physicalTable, QUOTAS
} = require(path.join(__dirname, '..', 'nodes', 'lib', 'fragment'));

// Example fragment from annex A of the spec (valid)
const EXAMPLE = {
  tables: {
    vehicules: {
      pk: 'id', owner: 'created_by', published: true, tombstone: 'deleted_at', outbox: true,
      fields: {
        id: { type: 'bigint', serial: true },
        immatriculation: { type: 'text', not_null: true, unique: true },
        type: { type: 'text', check_in: ['voiture', 'camion', 'velo'] },
        prix: { type: 'numeric' },
        created_by: { type: 'bigint', fk: 'users' },
        created_at: { type: 'timestamptz', default: 'now()' },
        updated_at: { type: 'timestamptz', default: 'now()' },
        deleted_at: { type: 'timestamptz' }
      }
    }
  }
};

test('annex A example: valid', () => {
  assert.equal(validateFragment(EXAMPLE, JSON.stringify(EXAMPLE).length), true);
});

test('prefix: store_<slug>_<table> in the app schema', () => {
  assert.equal(physicalTable('flotte', 'vehicules'), 'store_flotte_vehicules');
  const c = compileFragment('flotte', EXAMPLE);
  assert.ok(c.tables[0].statements[0].includes('CREATE TABLE IF NOT EXISTS app."store_flotte_vehicules"'));
});

test('invalid slug → invalid_identifier', () => {
  assert.throws(() => compileFragment('Bad-Slug', EXAMPLE),
    e => e instanceof FragmentError && e.code === 'invalid_identifier');
});

test('table/field name outside regex → invalid_identifier', () => {
  const bad = JSON.parse(JSON.stringify(EXAMPLE));
  bad.tables['Bad Name'] = bad.tables.vehicules;
  assert.throws(() => validateFragment(bad), e => e.code === 'invalid_identifier');
  const bad2 = JSON.parse(JSON.stringify(EXAMPLE));
  bad2.tables.vehicules.fields['X'] = { type: 'text' };
  assert.throws(() => validateFragment(bad2), e => e.code === 'invalid_identifier');
});

test('unauthorized key → schema_violation (strict whitelist, annex A)', () => {
  const bad = JSON.parse(JSON.stringify(EXAMPLE));
  bad.tables.vehicules.evil = 'DROP TABLE auth.acl';
  assert.throws(() => validateFragment(bad), e => e.code === 'schema_violation');
  const bad2 = JSON.parse(JSON.stringify(EXAMPLE));
  bad2.tables.vehicules.fields.prix.custom_sql = 'CHECK (1=0); DROP TABLE x';
  assert.throws(() => validateFragment(bad2), e => e.code === 'schema_violation');
});

test('field type outside whitelist → schema_violation', () => {
  const bad = JSON.parse(JSON.stringify(EXAMPLE));
  bad.tables.vehicules.fields.prix = { type: 'regclass' };
  assert.throws(() => validateFragment(bad), e => e.code === 'schema_violation');
});

test('fk between packages / other than users → blacklisted_effect (§4.4)', () => {
  const bad = JSON.parse(JSON.stringify(EXAMPLE));
  bad.tables.vehicules.fields.prix = { type: 'bigint', fk: 'tickets' };
  assert.throws(() => validateFragment(bad), e => e.code === 'blacklisted_effect');
});

test('pk not "id" or not serial → schema_violation (base triggers, v1)', () => {
  const bad = JSON.parse(JSON.stringify(EXAMPLE));
  bad.tables.vehicules.pk = 'immatriculation';
  assert.throws(() => validateFragment(bad), e => e.code === 'schema_violation');
  const bad2 = JSON.parse(JSON.stringify(EXAMPLE));
  bad2.tables.vehicules.fields.id = { type: 'bigint' }; // without serial
  assert.throws(() => validateFragment(bad2), e => e.code === 'schema_violation');
});

test('quotas: >10 tables → quota_exceeded; payload >256 KB → quota_exceeded', () => {
  const big = { tables: {} };
  for (let i = 0; i < QUOTAS.maxTables + 1; i++) {
    big.tables['t' + i] = { pk: 'id', fields: { id: { type: 'bigint', serial: true } } };
  }
  assert.throws(() => validateFragment(big), e => e.code === 'quota_exceeded');
  assert.throws(() => validateFragment(EXAMPLE, QUOTAS.maxPayloadBytes + 1), e => e.code === 'quota_exceeded');
});

test('literal anti-injection (§4.6): check_in and default emitted via quote_literal', () => {
  const evil = JSON.parse(JSON.stringify(EXAMPLE));
  evil.tables.vehicules.fields.type.check_in = ["voiture', 'x'); DROP TABLE auth.acl;--"];
  evil.tables.vehicules.fields.prix.default = "1); DROP TABLE dsp.contracts;--";
  validateFragment(evil); // valid (literals are safe once escaped)
  const c = compileFragment('flotte', evil);
  const ddl = c.tables[0].statements.join('\n');
  // the injection attempt appears escaped ('' doubled), never raw
  assert.ok(ddl.includes("'voiture'', ''x''); DROP TABLE auth.acl;--'"), 'check_in escaped via quote_literal');
  assert.ok(ddl.includes("DEFAULT '1); DROP TABLE dsp.contracts;--'"), 'non-whitelisted string default → quote_literal');
  // the unescaped sequence (which would break out of the SQL literal) must never appear
  assert.ok(!ddl.includes("voiture', 'x'); DROP"), 'no raw unescaped literal');
});

test('default now()/true/false/number emitted as-is (§4.6 whitelist)', () => {
  const c = compileFragment('flotte', EXAMPLE);
  const ddl = c.tables[0].statements.join('\n');
  assert.ok(ddl.includes('DEFAULT now()'));
});

test('all identifiers are quoted (quote_ident) in the DDL', () => {
  const c = compileFragment('flotte', EXAMPLE);
  for (const stmt of c.tables[0].statements) {
    if (stmt.startsWith('CREATE TABLE')) {
      assert.ok(stmt.includes('app."store_flotte_vehicules"'));
      assert.ok(stmt.includes('"id" bigserial PRIMARY KEY'));
      assert.ok(stmt.includes('REFERENCES app."users"("id")'));
    }
  }
});

test('RLS + mapping: logical container /apps/<slug>/<table>/ (not the physical name)', () => {
  const c = compileFragment('flotte', EXAMPLE);
  const ddl = c.tables[0].statements.join('\n');
  assert.ok(ddl.includes("'/apps/flotte/vehicules/'"), 'logical IRI in the RLS policies');
  assert.ok(ddl.includes('FORCE ROW LEVEL SECURITY'));
  assert.ok(ddl.includes('CREATE POLICY store_flotte_vehicules_read'));
  assert.equal(c.tables[0].container, '/apps/flotte/vehicules/');
  assert.equal(c.tables[0].pattern, '/apps/flotte/vehicules/<id>');
  assert.equal(c.tables[0].published, true);
});

test('base triggers set per declaration (outbox/tombstone/updated_at)', () => {
  const c = compileFragment('flotte', EXAMPLE);
  const ddl = c.tables[0].statements.join('\n');
  for (const t of ['set_updated_at', 'versioning', 'tombstone', 'outbox'])
    assert.ok(ddl.includes(`CREATE TRIGGER ${t} `), `trigger ${t}`);
  // without outbox declared → no outbox trigger
  const noOutbox = JSON.parse(JSON.stringify(EXAMPLE));
  delete noOutbox.tables.vehicules.outbox;
  const c2 = compileFragment('flotte', noOutbox);
  assert.ok(!c2.tables[0].statements.join('\n').includes('CREATE TRIGGER outbox '));
});

test('canonical hash stable (key order irrelevant) and sensitive to changes', () => {
  const h1 = fragmentHash(EXAMPLE);
  const shuffled = { tables: { vehicules: JSON.parse(JSON.stringify(EXAMPLE.tables.vehicules)) } };
  // shuffle the fields
  const entries = Object.entries(shuffled.tables.vehicules.fields).reverse();
  shuffled.tables.vehicules.fields = Object.fromEntries(entries);
  assert.equal(fragmentHash(shuffled), h1, 'hash stable despite reshuffling');
  const changed = JSON.parse(JSON.stringify(EXAMPLE));
  changed.tables.vehicules.fields.prix.not_null = true;
  assert.notEqual(fragmentHash(changed), h1, 'hash changes when the schema changes (drift)');
  assert.equal(canonicalForCompare(EXAMPLE), stableStringify(JSON.parse(stableStringify({ tables: Object.fromEntries(Object.entries(EXAMPLE.tables).map(([k, v]) => [k, { pk: v.pk, fields: Object.fromEntries(Object.entries(v.fields).map(([f, d]) => [f, { type: d.type, serial: !!d.serial, not_null: !!d.not_null || !!d.serial }])) }])) }))));
});

test('quoteIdent/quoteLiteral: standard PG escaping', () => {
  assert.equal(quoteIdent('users'), '"users"');
  assert.equal(quoteLiteral("a'b"), "'a''b'");
});
