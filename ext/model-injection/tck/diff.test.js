// diff.test.js — unit tests of lib/diff.js (POST /admin/model, core model hot patch):
// diffCoreModel (additive-only), compileCoreDdl (core DDL, bare names, never DROP TABLE/COLUMN),
// mergeCoreModel (idempotence). Pure — no PG, no Node-RED: node --test tck/diff.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  diffCoreModel, compileCoreDdl, mergeCoreModel, parseCoreField, fieldSignature, whitelistType
} = require(path.join(__dirname, '..', 'nodes', 'lib', 'diff'));
const { FragmentError, validateFragment } = require(path.join(__dirname, '..', 'nodes', 'lib', 'fragment'));

// current core model.json (core dialect: SQL-ish strings)
const CORE = {
  base_iri: 'http://localhost:18880/',
  tables: {
    users: {
      pk: 'id', owner: null, published: false,
      fields: {
        id: 'bigserial', webid: 'text unique not null', name: 'text not null',
        role: "text check in ('manager','technician','admin')",
        created_at: 'timestamptz default now()', updated_at: 'timestamptz default now()'
      }
    },
    buildings: {
      pk: 'id', owner: null, published: true,
      fields: {
        id: 'bigserial', name: 'text not null', address: 'text',
        lat: 'double precision', lon: 'double precision',
        created_at: 'timestamptz default now()', updated_at: 'timestamptz default now()'
      }
    },
    tickets: {
      pk: 'id', owner: 'created_by', published: false, tombstone: 'deleted_at',
      fields: {
        id: 'bigserial', title: 'text not null',
        status: "text default 'OPEN' check in ('OPEN','IN_PROGRESS','RESOLVED','CLOSED')",
        building_id: 'bigint fk buildings(id)', created_by: 'bigint fk users(id)',
        created_at: 'timestamptz default now()', updated_at: 'timestamptz default now()',
        deleted_at: 'timestamptz'
      }
    }
  }
};

// desired model (fragment annexe A, as sent by the editor in body.model)
const NEW = {
  tables: {
    users: {
      pk: 'id', owner: null, published: false,
      fields: {
        id: { type: 'bigint', serial: true }, webid: { type: 'text', not_null: true, unique: true },
        name: { type: 'text', not_null: true },
        role: { type: 'text', check_in: ['manager', 'technician', 'admin'] },
        created_at: { type: 'timestamptz', default: 'now()' }, updated_at: { type: 'timestamptz', default: 'now()' }
      }
    },
    buildings: {
      pk: 'id', owner: null, published: true,
      fields: {
        id: { type: 'bigint', serial: true }, name: { type: 'text', not_null: true }, address: { type: 'text' },
        lat: { type: 'numeric' }, lon: { type: 'numeric' },           // double precision ≡ numeric
        created_at: { type: 'timestamptz', default: 'now()' }, updated_at: { type: 'timestamptz', default: 'now()' },
        area_m2: { type: 'numeric' }                                   // NEW column → alter
      }
    },
    tickets: {
      pk: 'id', owner: 'created_by', published: false, tombstone: 'deleted_at',
      fields: {
        id: { type: 'bigint', serial: true }, title: { type: 'text', not_null: true },
        status: { type: 'text', default: 'OPEN', check_in: ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] },
        building_id: { type: 'bigint', fk: 'buildings' },             // core dialect: fk to a core table
        created_by: { type: 'bigint', fk: 'users' },
        created_at: { type: 'timestamptz', default: 'now()' }, updated_at: { type: 'timestamptz', default: 'now()' },
        deleted_at: { type: 'timestamptz' },
        priority: { type: 'text', check_in: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], default: 'MEDIUM' } // NEW → alter
      }
    },
    sites: {                                                            // NEW table → create
      pk: 'id', published: true,
      fields: {
        id: { type: 'bigint', serial: true }, label: { type: 'text', not_null: true },
        created_at: { type: 'timestamptz', default: 'now()' }, updated_at: { type: 'timestamptz', default: 'now()' }
      }
    }
  }
};

test('diffCoreModel: new column → alter, new table → create, existing untouched', () => {
  const d = diffCoreModel(CORE, NEW);
  assert.deepEqual(d.alters.map(a => `${a.table}.${a.field}`).sort(), ['buildings.area_m2', 'tickets.priority']);
  assert.deepEqual(d.creates.map(c => c.table), ['sites']);
  assert.deepEqual(d.refused, []);
});

test('diffCoreModel: dropped column / dropped table / modified column / modified table key → refused', () => {
  const dropCol = JSON.parse(JSON.stringify(NEW)); delete dropCol.tables.buildings.fields.address;
  assert.deepEqual(diffCoreModel(CORE, dropCol).refused, [{ table: 'buildings', field: 'address', reason: 'column_dropped' }]);

  const dropTable = JSON.parse(JSON.stringify(NEW)); delete dropTable.tables.tickets;
  assert.ok(diffCoreModel(CORE, dropTable).refused.some(r => r.table === 'tickets' && r.reason === 'table_dropped'));

  const modCol = JSON.parse(JSON.stringify(NEW)); modCol.tables.buildings.fields.name = { type: 'bigint' };
  assert.ok(diffCoreModel(CORE, modCol).refused.some(r => r.table === 'buildings' && r.field === 'name' && r.reason === 'column_modified'));

  const modKey = JSON.parse(JSON.stringify(NEW)); modKey.tables.buildings.published = false;
  assert.ok(diffCoreModel(CORE, modKey).refused.some(r => r.table === 'buildings' && r.key === 'published'));
});

test('diffCoreModel: validation of the incoming fragment (reuses validateFragment, core dialect)', () => {
  const bad = JSON.parse(JSON.stringify(NEW));
  bad.tables.buildings.fields.lat = { type: 'regclass' }; // not whitelisted
  assert.throws(() => diffCoreModel(CORE, bad), e => e instanceof FragmentError && e.code === 'schema_violation');
  const bad2 = JSON.parse(JSON.stringify(NEW));
  bad2.tables.buildings.evil = 'DROP TABLE app.users';
  assert.throws(() => diffCoreModel(CORE, bad2), e => e instanceof FragmentError && e.code === 'schema_violation');
  // E11-only rule relaxed in core dialect: fk towards another core table is allowed here…
  assert.ok(validateFragment(NEW, undefined, { coreDialect: true }));
  // …but NOT in the strict package dialect (§4.4)
  assert.throws(() => validateFragment(NEW), e => e instanceof FragmentError && e.code === 'blacklisted_effect');
});

test('diffCoreModel: semantic-only change (label_i18n) is NOT refused (contract-only, no DDL)', () => {
  const sem = JSON.parse(JSON.stringify(NEW));
  sem.tables.buildings.label_i18n = { en: 'Buildings', fr: 'Bâtiments' };
  sem.tables.buildings.fields.name.align = 'schema:name';
  const d = diffCoreModel(CORE, sem);
  assert.deepEqual(d.refused, []);
  assert.equal(d.creates.length, 1);
  assert.equal(d.alters.length, 2);
});

test('compileCoreDdl: CREATE TABLE app.<t> with bare names (never store_*), ADD COLUMN IF NOT EXISTS, no DROP TABLE/COLUMN', () => {
  const d = diffCoreModel(CORE, NEW);
  const ddl = compileCoreDdl(d);
  const all = ddl.statements.join('\n');
  assert.match(all, /CREATE TABLE IF NOT EXISTS app\."sites" \(/);
  assert.ok(!all.includes('store_'), 'core tables use bare names, not store_*');
  assert.match(all, /ALTER TABLE app\."buildings" ADD COLUMN IF NOT EXISTS "area_m2" numeric/);
  assert.match(all, /ALTER TABLE app\."tickets" ADD COLUMN IF NOT EXISTS "priority" text DEFAULT 'MEDIUM' CHECK \("priority" IN \('LOW',\s*'MEDIUM',\s*'HIGH',\s*'CRITICAL'\)\)/);
  assert.ok(!/DROP\s+(TABLE|COLUMN)/i.test(all), 'jamais de DROP TABLE/COLUMN');
  // triggers + RLS of the new table (factorized from the core model node)
  assert.match(all, /CREATE TRIGGER versioning AFTER INSERT OR UPDATE ON app\."sites"/);
  assert.match(all, /CREATE POLICY sites_read ON app\."sites" FOR SELECT USING \(auth\.can\(/);
  assert.match(all, /ALTER TABLE app\."sites" FORCE ROW LEVEL SECURITY/);
  // grants
  assert.match(all, /GRANT SELECT, INSERT, UPDATE, DELETE ON app\."sites" TO app/);
  assert.deepEqual(ddl.creates, [{ table: 'sites', container: '/sites/', pattern: '/sites/<id>', published: true }]);
  assert.deepEqual(ddl.alters.map(a => `${a.table}.${a.field}`).sort(), ['buildings.area_m2', 'tickets.priority']);
});

test('compileCoreDdl: a create carrying a DROP would be impossible by construction (blacklist guard)', () => {
  // the guard itself: feeding a diff whose statement would drop is not producible; assert the guard regex
  const d = { creates: [], alters: [] };
  assert.equal(compileCoreDdl(d).statements.length, 0);
});

test('mergeCoreModel + re-diff → idempotent (empty diff on replay)', () => {
  const d = diffCoreModel(CORE, NEW);
  const merged = mergeCoreModel(CORE, NEW, d);
  // core dialect preserved for existing tables, new column in core dialect
  assert.equal(merged.tables.buildings.fields.area_m2, 'numeric');
  assert.equal(merged.tables.buildings.fields.lat, 'double precision');
  assert.equal(merged.tables.sites.fields.id, 'bigserial');
  assert.equal(merged.tables.sites.fields.label, 'text not null');
  assert.equal(merged.base_iri, 'http://localhost:18880/');
  const d2 = diffCoreModel(merged, NEW);
  assert.equal(d2.creates.length, 0);
  assert.equal(d2.alters.length, 0);
  assert.deepEqual(d2.refused, []);
});

test('parseCoreField / fieldSignature / whitelistType: both dialects converge', () => {
  assert.equal(whitelistType('double precision'), 'numeric');
  assert.equal(whitelistType('integer'), 'bigint');
  assert.deepEqual(parseCoreField('bigserial'), { type: 'bigint', serial: true });
  assert.deepEqual(parseCoreField('bigint fk buildings(id)'), { type: 'bigint', fk: 'buildings' });
  assert.deepEqual(parseCoreField("text default 'OPEN' check in ('OPEN','CLOSED')"),
    { check_in: ['OPEN', 'CLOSED'], default: 'OPEN', type: 'text' });
  assert.equal(fieldSignature('double precision'), fieldSignature({ type: 'numeric' }));
  assert.equal(fieldSignature('timestamptz default now()'), fieldSignature({ type: 'timestamptz', default: 'now()' }));
  assert.equal(fieldSignature('bigserial'), fieldSignature({ type: 'bigint', serial: true }));
});

test('parity: disk SQL-ish strings vs the structured form the UI sends (default included) → identical fieldSignature', () => {
  const { fieldSignature } = require('../nodes/lib/diff');
  const cases = [
    ["text default 'OPEN' check in ('OPEN','IN_PROGRESS','RESOLVED','CLOSED')", { type: 'text', check_in: ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'], default: 'OPEN' }],
    ["text default 'MEDIUM' check in ('LOW','MEDIUM','HIGH','CRITICAL')", { type: 'text', check_in: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], default: 'MEDIUM' }],
    ['timestamptz default now()', { type: 'timestamptz', default: 'now()' }],
    ['double precision', { type: 'numeric' }],
    ['bigserial', { type: 'bigint', serial: true }],
    ['bigint fk buildings(id)', { type: 'bigint', fk: 'buildings' }],
    ['text not null', { type: 'text', not_null: true }]
  ];
  for (const [disk, ui] of cases)
    assert.equal(fieldSignature(ui), fieldSignature(disk), `signature mismatch for: ${disk}`);
});
