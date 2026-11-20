// fragment.test.js — tests unitaires du validateur/compilateur de fragments (ext/model-injection).
// Sans dépendance externe ni PG : node --test ext/model-injection/tck/fragment.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  validateFragment, compileFragment, fragmentHash, canonicalForCompare, stableStringify,
  FragmentError, quoteIdent, quoteLiteral, physicalTable, QUOTAS
} = require(path.join(__dirname, '..', 'nodes', 'lib', 'fragment'));

// Fragment exemple de l'annexe A de la spec (valide)
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

test('exemple annexe A : valide', () => {
  assert.equal(validateFragment(EXAMPLE, JSON.stringify(EXAMPLE).length), true);
});

test('préfixe : store_<slug>_<table> dans le schéma app', () => {
  assert.equal(physicalTable('flotte', 'vehicules'), 'store_flotte_vehicules');
  const c = compileFragment('flotte', EXAMPLE);
  assert.ok(c.tables[0].statements[0].includes('CREATE TABLE IF NOT EXISTS app."store_flotte_vehicules"'));
});

test('slug invalide → invalid_identifier', () => {
  assert.throws(() => compileFragment('Bad-Slug', EXAMPLE),
    e => e instanceof FragmentError && e.code === 'invalid_identifier');
});

test('nom de table/ champ hors regex → invalid_identifier', () => {
  const bad = JSON.parse(JSON.stringify(EXAMPLE));
  bad.tables['Bad Name'] = bad.tables.vehicules;
  assert.throws(() => validateFragment(bad), e => e.code === 'invalid_identifier');
  const bad2 = JSON.parse(JSON.stringify(EXAMPLE));
  bad2.tables.vehicules.fields['X'] = { type: 'text' };
  assert.throws(() => validateFragment(bad2), e => e.code === 'invalid_identifier');
});

test('clé non autorisée → schema_violation (whitelist stricte, annexe A)', () => {
  const bad = JSON.parse(JSON.stringify(EXAMPLE));
  bad.tables.vehicules.evil = 'DROP TABLE auth.acl';
  assert.throws(() => validateFragment(bad), e => e.code === 'schema_violation');
  const bad2 = JSON.parse(JSON.stringify(EXAMPLE));
  bad2.tables.vehicules.fields.prix.custom_sql = 'CHECK (1=0); DROP TABLE x';
  assert.throws(() => validateFragment(bad2), e => e.code === 'schema_violation');
});

test('type de champ hors whitelist → schema_violation', () => {
  const bad = JSON.parse(JSON.stringify(EXAMPLE));
  bad.tables.vehicules.fields.prix = { type: 'regclass' };
  assert.throws(() => validateFragment(bad), e => e.code === 'schema_violation');
});

test('fk entre packages / hors users → blacklisted_effect (§4.4)', () => {
  const bad = JSON.parse(JSON.stringify(EXAMPLE));
  bad.tables.vehicules.fields.prix = { type: 'bigint', fk: 'tickets' };
  assert.throws(() => validateFragment(bad), e => e.code === 'blacklisted_effect');
});

test('pk non "id" ou non serial → schema_violation (triggers du socle, v1)', () => {
  const bad = JSON.parse(JSON.stringify(EXAMPLE));
  bad.tables.vehicules.pk = 'immatriculation';
  assert.throws(() => validateFragment(bad), e => e.code === 'schema_violation');
  const bad2 = JSON.parse(JSON.stringify(EXAMPLE));
  bad2.tables.vehicules.fields.id = { type: 'bigint' }; // sans serial
  assert.throws(() => validateFragment(bad2), e => e.code === 'schema_violation');
});

test('quotas : >10 tables → quota_exceeded ; payload >256 Ko → quota_exceeded', () => {
  const big = { tables: {} };
  for (let i = 0; i < QUOTAS.maxTables + 1; i++) {
    big.tables['t' + i] = { pk: 'id', fields: { id: { type: 'bigint', serial: true } } };
  }
  assert.throws(() => validateFragment(big), e => e.code === 'quota_exceeded');
  assert.throws(() => validateFragment(EXAMPLE, QUOTAS.maxPayloadBytes + 1), e => e.code === 'quota_exceeded');
});

test('anti-injection littéraux (§4.6) : check_in et default émis via quote_literal', () => {
  const evil = JSON.parse(JSON.stringify(EXAMPLE));
  evil.tables.vehicules.fields.type.check_in = ["voiture', 'x'); DROP TABLE auth.acl;--"];
  evil.tables.vehicules.fields.prix.default = "1); DROP TABLE dsp.contracts;--";
  validateFragment(evil); // valide (les littéraux sont sûrs une fois échappés)
  const c = compileFragment('flotte', evil);
  const ddl = c.tables[0].statements.join('\n');
  // la tentative d'injection apparaît échappée ('' doublés), jamais crue
  assert.ok(ddl.includes("'voiture'', ''x''); DROP TABLE auth.acl;--'"), 'check_in échappé via quote_literal');
  assert.ok(ddl.includes("DEFAULT '1); DROP TABLE dsp.contracts;--'"), 'default chaîne non whitelisté → quote_literal');
  // la séquence non échappée (qui sortirait du littéral SQL) ne doit jamais apparaître
  assert.ok(!ddl.includes("voiture', 'x'); DROP"), 'pas de littéral cru non échappé');
});

test('default now()/true/false/number émis tel quel (§4.6 whitelist)', () => {
  const c = compileFragment('flotte', EXAMPLE);
  const ddl = c.tables[0].statements.join('\n');
  assert.ok(ddl.includes('DEFAULT now()'));
});

test('tous les identifiants sont quotés (quote_ident) dans le DDL', () => {
  const c = compileFragment('flotte', EXAMPLE);
  for (const stmt of c.tables[0].statements) {
    if (stmt.startsWith('CREATE TABLE')) {
      assert.ok(stmt.includes('app."store_flotte_vehicules"'));
      assert.ok(stmt.includes('"id" bigserial PRIMARY KEY'));
      assert.ok(stmt.includes('REFERENCES app."users"("id")'));
    }
  }
});

test('RLS + mapping : conteneur logique /apps/<slug>/<table>/ (pas le nom physique)', () => {
  const c = compileFragment('flotte', EXAMPLE);
  const ddl = c.tables[0].statements.join('\n');
  assert.ok(ddl.includes("'/apps/flotte/vehicules/'"), 'IRI logique dans les policies RLS');
  assert.ok(ddl.includes('FORCE ROW LEVEL SECURITY'));
  assert.ok(ddl.includes('CREATE POLICY store_flotte_vehicules_read'));
  assert.equal(c.tables[0].container, '/apps/flotte/vehicules/');
  assert.equal(c.tables[0].pattern, '/apps/flotte/vehicules/<id>');
  assert.equal(c.tables[0].published, true);
});

test('triggers du socle posés selon déclaration (outbox/tombstone/updated_at)', () => {
  const c = compileFragment('flotte', EXAMPLE);
  const ddl = c.tables[0].statements.join('\n');
  for (const t of ['set_updated_at', 'versioning', 'tombstone', 'outbox'])
    assert.ok(ddl.includes(`CREATE TRIGGER ${t} `), `trigger ${t}`);
  // sans outbox déclaré → pas de trigger outbox
  const noOutbox = JSON.parse(JSON.stringify(EXAMPLE));
  delete noOutbox.tables.vehicules.outbox;
  const c2 = compileFragment('flotte', noOutbox);
  assert.ok(!c2.tables[0].statements.join('\n').includes('CREATE TRIGGER outbox '));
});

test('hash canonique stable (ordre des clés indifférent) et sensible aux changements', () => {
  const h1 = fragmentHash(EXAMPLE);
  const shuffled = { tables: { vehicules: JSON.parse(JSON.stringify(EXAMPLE.tables.vehicules)) } };
  // réordonne les champs
  const entries = Object.entries(shuffled.tables.vehicules.fields).reverse();
  shuffled.tables.vehicules.fields = Object.fromEntries(entries);
  assert.equal(fragmentHash(shuffled), h1, 'hash stable malgré le réordonnancement');
  const changed = JSON.parse(JSON.stringify(EXAMPLE));
  changed.tables.vehicules.fields.prix.not_null = true;
  assert.notEqual(fragmentHash(changed), h1, 'hash change si le schéma change (drift)');
  assert.equal(canonicalForCompare(EXAMPLE), stableStringify(JSON.parse(stableStringify({ tables: Object.fromEntries(Object.entries(EXAMPLE.tables).map(([k, v]) => [k, { pk: v.pk, fields: Object.fromEntries(Object.entries(v.fields).map(([f, d]) => [f, { type: d.type, serial: !!d.serial, not_null: !!d.not_null || !!d.serial }])) }])) }))));
});

test('quoteIdent/quoteLiteral : échappement standard PG', () => {
  assert.equal(quoteIdent('users'), '"users"');
  assert.equal(quoteLiteral("a'b"), "'a''b'");
});
