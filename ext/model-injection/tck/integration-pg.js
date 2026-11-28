// integration-pg.js — real integration test of ext/model-injection against a Postgres 16
// (core fap-ldp applied). Covers what the e2e shell cannot: idempotent boot + drift
// (AC-B7), RLS/auth.can on the injected tables, outbox/versioning, fragment-aware purge.
//
//   PG_ADMIN_DSN=postgres://admin:***@localhost:5432/fap node tck/integration-pg.js
//
// The script cleans up its artifacts (slugs mi_test_*) on exit.
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { installPackage, revokePackage, applyFragmentsAtBoot } = require(path.join(__dirname, '..', 'nodes', 'lib', 'installer'));
const { FragmentError, compileFragment } = require(path.join(__dirname, '..', 'nodes', 'lib', 'fragment'));

const DSN = process.env.PG_ADMIN_DSN;
if (!DSN) { console.error('PG_ADMIN_DSN required'); process.exit(2); }
const BASE = process.env.BASE_IRI || 'http://localhost:18880/';
const WEBID = 'https://supervision.example/users/1';

const FRAGMENT = {
  tables: {
    vehicles: {
      pk: 'id', owner: 'created_by', published: true, tombstone: 'deleted_at', outbox: true,
      fields: {
        id: { type: 'bigint', serial: true },
        registration: { type: 'text', not_null: true, unique: true },
        type: { type: 'text', check_in: ['car', 'truck', 'bike'] },
        price: { type: 'numeric' },
        created_by: { type: 'bigint', fk: 'users' },
        created_at: { type: 'timestamptz', default: 'now()' },
        updated_at: { type: 'timestamptz', default: 'now()' },
        deleted_at: { type: 'timestamptz' }
      }
    }
  }
};
const FRAGMENT2 = {
  tables: {
    places: {
      pk: 'id', published: false,
      fields: {
        id: { type: 'bigint', serial: true }, label: { type: 'text', not_null: true },
        created_at: { type: 'timestamptz', default: 'now()' }, updated_at: { type: 'timestamptz', default: 'now()' }
      }
    }
  }
};

let pass = 0, fail = 0;
function ck(name, fn) {
  return Promise.resolve().then(fn).then(() => { pass++; console.log('PASS', name); })
    .catch(e => { fail++; console.log('FAIL', name, '-', e.message); });
}

async function main() {
  const pool = new Pool({ connectionString: DSN, max: 3 });
  const q = (s, p) => pool.query(s, p);

  // ext migrations (000 + 001), replayable
  for (const f of ['000_model_injection.sql', '001_mi_maintenance.sql']) {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', f), 'utf8');
    await q(sql);
  }
  console.log('PASS migrations 000+001 applied');

  // initial cleanup (tables left from a previous run + rows)
  await q("DELETE FROM app.app_packages WHERE slug LIKE 'mi_test_%'");
  await q(`DO $$ DECLARE r record; BEGIN
    FOR r IN SELECT table_name FROM information_schema.tables WHERE table_schema='app' AND table_name LIKE 'store_mi\\_test\\_%'
    LOOP EXECUTE format('DROP TABLE IF EXISTS app.%I CASCADE', r.table_name); END LOOP;
  END $$`);

  await ck('AC-B1 valid install → 201-equivalent (tables/mapping/contract/ACL/row)', async () => {
    const out = await installPackage(pool, {
      slug: 'mi_test_fleet', version: '1.0.0', meta: { title_i18n: { en: 'Fleet', fr: 'Flotte' } },
      model_fragment: FRAGMENT, webid: WEBID, baseIri: BASE
    });
    assert.equal(out.tables[0], 'store_mi_test_fleet_vehicles');
    assert.ok((await q("SELECT to_regclass('app.store_mi_test_fleet_vehicles')")).rows[0].to_regclass);
    const m = await q("SELECT * FROM dsp.asset_mapping WHERE container_uri='/apps/mi_test_fleet/vehicles/'");
    assert.equal(m.rows[0].published, true);
    assert.equal(m.rows[0].table_name, 'store_mi_test_fleet_vehicles');
    const acl = await q("SELECT subject, modes FROM auth.acl WHERE resource_uri=$1 ORDER BY subject", [BASE + 'apps/mi_test_fleet/']);
    assert.deepEqual(acl.rows.map(r => r.subject).sort(), ['role:admin', WEBID].sort());
    const c = await q("SELECT state FROM dsp.contracts WHERE agreement_id=$1", [out.agreement_id]);
    assert.equal(c.rows[0].state, 'active');
    // published → foaf:Agent read on the table container
    const pub = await q("SELECT modes FROM auth.acl WHERE resource_uri=$1 AND subject='foaf:Agent'", [BASE + 'apps/mi_test_fleet/vehicles/']);
    assert.equal(pub.rows[0].modes.join(','), 'read');
  });

  await ck('AC-B8 POST same slug → 409 Conflict', async () => {
    await assert.rejects(
      installPackage(pool, { slug: 'mi_test_fleet', version: '1.0.1', model_fragment: FRAGMENT, webid: WEBID, baseIri: BASE }),
      e => e.status === 409);
  });

  await ck('AC-B2 invalid fragment → 422 schema_violation, nothing applied', async () => {
    const bad = JSON.parse(JSON.stringify(FRAGMENT));
    bad.tables.vehicles.fields.price = { type: 'regclass' };
    await assert.rejects(
      installPackage(pool, { slug: 'mi_test_bad', version: '1.0.0', model_fragment: bad, webid: WEBID, baseIri: BASE }),
      e => e instanceof FragmentError && e.code === 'schema_violation');
    assert.equal((await q("SELECT to_regclass('app.store_mi_test_bad_vehicles')")).rows[0].to_regclass, null);
    assert.equal((await q("SELECT count(*)::int AS n FROM app.app_packages WHERE slug='mi_test_bad'")).rows[0].n, 0);
  });

  await ck('AC-B2 physical name collision (slug a + table y_z vs slug a_y + table z) → prefix_collision', async () => {
    // store_mi_test_a_y_z is produced by BOTH combinations → the 2nd must be rejected
    await installPackage(pool, { slug: 'mi_test_a', version: '1.0.0', model_fragment: { tables: { y_z: { pk: 'id', fields: { id: { type: 'bigint', serial: true } } } } }, webid: WEBID, baseIri: BASE });
    await assert.rejects(
      installPackage(pool, { slug: 'mi_test_a_y', version: '1.0.0', model_fragment: { tables: { z: { pk: 'id', fields: { id: { type: 'bigint', serial: true } } } } }, webid: WEBID, baseIri: BASE }),
      e => e instanceof FragmentError && e.code === 'prefix_collision');
  });

  await ck('AC-B3 second package coexists', async () => {
    await installPackage(pool, { slug: 'mi_test_garages', version: '0.1.0', model_fragment: FRAGMENT2, webid: WEBID, baseIri: BASE });
    assert.ok((await q("SELECT to_regclass('app.store_mi_test_garages_places')")).rows[0].to_regclass);
  });

  await ck('AC-B5 write → outbox + versioning (RG-3)', async () => {
    await q("INSERT INTO app.store_mi_test_fleet_vehicles (registration, type, created_by) VALUES ('AA-123-BB','car',1)");
    const ob = await q("SELECT event_type FROM app.outbox WHERE event_type LIKE 'store_mi_test_fleet_vehicles.%' ORDER BY id DESC LIMIT 1");
    assert.equal(ob.rows[0].event_type, 'store_mi_test_fleet_vehicles.insert');
    const v = await q("SELECT count(*)::int AS n FROM app.versions WHERE table_name='store_mi_test_fleet_vehicles'");
    assert.ok(v.rows[0].n >= 1);
  });

  await ck('RLS/auth.can: owner reads, other webid filtered on UNPUBLISHED table (FORCE RLS)', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.base_iri', $1, true)", [BASE]);
      await c.query('SET ROLE app');
      await c.query("SELECT set_config('app.webid', $1, true)", [WEBID]);
      const mine = await c.query('SELECT count(*)::int AS n FROM app.store_mi_test_garages_places');
      assert.ok(mine.rows[0].n >= 0);
      await c.query("INSERT INTO app.store_mi_test_garages_places (label) VALUES ('place-1')");
      const mine2 = await c.query('SELECT count(*)::int AS n FROM app.store_mi_test_garages_places');
      assert.equal(mine2.rows[0].n, 1, 'owner writes/sees (owner ACL inherited from the package container)');
      await c.query("SELECT set_config('app.webid', 'https://supervision.example/users/999', true)");
      const other = await c.query('SELECT count(*)::int AS n FROM app.store_mi_test_garages_places');
      assert.equal(other.rows[0].n, 0, 'other webid: RLS filters everything (unpublished table)');
    } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
  });

  await ck('RLS/auth.can: published table readable by foaf:Agent (published asset, DSP contract at the PDP)', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.base_iri', $1, true)", [BASE]);
      await c.query('SET ROLE app');
      await c.query("SELECT set_config('app.webid', 'https://autre.example/users/1', true)");
      const pub = await c.query('SELECT count(*)::int AS n FROM app.store_mi_test_fleet_vehicles');
      assert.ok(pub.rows[0].n >= 1, 'foaf:Agent reads the published table');
    } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
  });

  await ck('idempotent boot: reapplication without error, no drift (negative AC-B7)', async () => {
    const r = await applyFragmentsAtBoot(pool, BASE, () => {});
    assert.ok(r.applied.includes('mi_test_fleet'));
    assert.deepEqual(r.drifted, []);
  });

  await ck('AC-B7 drift: column added by hand → drift state + alarm', async () => {
    await q('ALTER TABLE app.store_mi_test_fleet_vehicles ADD COLUMN hack_col text');
    const alarms = [];
    const r = await applyFragmentsAtBoot(pool, BASE, m => alarms.push(m));
    assert.ok(r.drifted.includes('mi_test_fleet'), 'drift detected');
    assert.ok(alarms.length >= 1, 'alarm logged');
    const st = await q("SELECT state FROM app.app_packages WHERE slug='mi_test_fleet'");
    assert.equal(st.rows[0].state, 'drift');
    await q('ALTER TABLE app.store_mi_test_fleet_vehicles DROP COLUMN hack_col');
    const r2 = await applyFragmentsAtBoot(pool, BASE, () => {});
    assert.deepEqual(r2.drifted, [], 'clean reboot after fix → back to installed');
  });

  await ck('AC-B4 revocation → contract revoked, asset unpublished, state revoked', async () => {
    await revokePackage(pool, 'mi_test_garages', WEBID);
    const st = await q("SELECT state, revoked_at IS NOT NULL AS has_revoked_at FROM app.app_packages WHERE slug='mi_test_garages'");
    assert.equal(st.rows[0].state, 'revoked');
    assert.equal(st.rows[0].has_revoked_at, true);
    const pub = await q("SELECT published FROM dsp.asset_mapping WHERE container_uri='/apps/mi_test_garages/places/'");
    assert.equal(pub.rows[0].published, false);
    const c = await q("SELECT c.state FROM dsp.contracts c JOIN app.app_packages p ON p.contract_id=c.agreement_id WHERE p.slug='mi_test_garages'");
    assert.equal(c.rows[0].state, 'revoked');
  });

  await ck('fragment-aware purge: drop of the revoked package tables after retention', async () => {
    await q("UPDATE app.app_packages SET revoked_at = now() - interval '31 days' WHERE slug='mi_test_garages'");
    await q("SELECT app.mi_drop_revoked_packages(interval '30 days')");
    assert.equal((await q("SELECT to_regclass('app.store_mi_test_garages_places')")).rows[0].to_regclass, null);
  });

  // cleanup
  await q("UPDATE app.app_packages SET revoked_at = now() - interval '31 days' WHERE slug LIKE 'mi_test_%'");
  await q("SELECT app.mi_drop_revoked_packages(interval '30 days')");
  await q("DELETE FROM app.app_packages WHERE slug LIKE 'mi_test_%'");
  await q(`DO $$ DECLARE r record; BEGIN
    FOR r IN SELECT table_name FROM information_schema.tables WHERE table_schema='app' AND table_name LIKE 'store_mi\\_test\\_%'
    LOOP EXECUTE format('DROP TABLE IF EXISTS app.%I CASCADE', r.table_name); END LOOP;
  END $$`);
  await q("DELETE FROM dsp.asset_mapping WHERE container_uri LIKE '/apps/mi_test_%'");
  await q("DELETE FROM auth.acl WHERE resource_uri LIKE $1", [BASE + 'apps/mi_test_%']);
  await q("DELETE FROM dsp.contracts WHERE agreement_id LIKE 'agr-mi-mi_test_%'");
  await q("DELETE FROM dsp.audit WHERE resource_uri LIKE '/apps/mi_test_%'");
  await pool.end();
  console.log(`== ${pass} PASS, ${fail} FAIL ==`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('FATAL ERROR', e); process.exit(1); });
