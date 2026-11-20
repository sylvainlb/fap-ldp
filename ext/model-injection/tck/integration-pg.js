// integration-pg.js — test d'intégration réel de ext/model-injection contre un Postgres 16
// (core fap-ldp appliqué). Couvre ce que le shell e2e ne peut pas : boot idempotent + drift
// (CA-B7), RLS/auth.can sur les tables injectées, outbox/versioning, purge fragment-aware.
//
//   PG_ADMIN_DSN=postgres://admin:***@localhost:5432/fap node tck/integration-pg.js
//
// Le script nettoie ses artefacts (slugs mi_test_*) en sortie.
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { installPackage, revokePackage, applyFragmentsAtBoot } = require(path.join(__dirname, '..', 'nodes', 'lib', 'installer'));
const { FragmentError, compileFragment } = require(path.join(__dirname, '..', 'nodes', 'lib', 'fragment'));

const DSN = process.env.PG_ADMIN_DSN;
if (!DSN) { console.error('PG_ADMIN_DSN requis'); process.exit(2); }
const BASE = process.env.BASE_IRI || 'http://localhost:18880/';
const WEBID = 'https://supervision.example/users/1';

const FRAGMENT = {
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

  // migrations de l'ext (000 + 001), rejouables
  for (const f of ['000_model_injection.sql', '001_mi_maintenance.sql']) {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', f), 'utf8');
    await q(sql);
  }
  console.log('PASS migrations 000+001 appliquées');

  // nettoyage initial (tables restantes d'un run précédent + lignes)
  await q("DELETE FROM app.app_packages WHERE slug LIKE 'mi_test_%'");
  await q(`DO $$ DECLARE r record; BEGIN
    FOR r IN SELECT table_name FROM information_schema.tables WHERE table_schema='app' AND table_name LIKE 'store_mi\\_test\\_%'
    LOOP EXECUTE format('DROP TABLE IF EXISTS app.%I CASCADE', r.table_name); END LOOP;
  END $$`);

  await ck('CA-B1 install valide → 201-equivalent (tables/mapping/contrat/ACL/ligne)', async () => {
    const out = await installPackage(pool, {
      slug: 'mi_test_flotte', version: '1.0.0', meta: { title_i18n: { fr: 'Flotte' } },
      model_fragment: FRAGMENT, webid: WEBID, baseIri: BASE
    });
    assert.equal(out.tables[0], 'store_mi_test_flotte_vehicules');
    assert.ok((await q("SELECT to_regclass('app.store_mi_test_flotte_vehicules')")).rows[0].to_regclass);
    const m = await q("SELECT * FROM dsp.asset_mapping WHERE container_uri='/apps/mi_test_flotte/vehicules/'");
    assert.equal(m.rows[0].published, true);
    assert.equal(m.rows[0].table_name, 'store_mi_test_flotte_vehicules');
    const acl = await q("SELECT subject, modes FROM auth.acl WHERE resource_uri=$1 ORDER BY subject", [BASE + 'apps/mi_test_flotte/']);
    assert.deepEqual(acl.rows.map(r => r.subject).sort(), ['role:admin', WEBID].sort());
    const c = await q("SELECT state FROM dsp.contracts WHERE agreement_id=$1", [out.agreement_id]);
    assert.equal(c.rows[0].state, 'active');
    // published → foaf:Agent read sur le conteneur de la table
    const pub = await q("SELECT modes FROM auth.acl WHERE resource_uri=$1 AND subject='foaf:Agent'", [BASE + 'apps/mi_test_flotte/vehicules/']);
    assert.equal(pub.rows[0].modes.join(','), 'read');
  });

  await ck('CA-B8 POST même slug → 409 Conflict', async () => {
    await assert.rejects(
      installPackage(pool, { slug: 'mi_test_flotte', version: '1.0.1', model_fragment: FRAGMENT, webid: WEBID, baseIri: BASE }),
      e => e.status === 409);
  });

  await ck('CA-B2 fragment invalide → 422 schema_violation, rien appliqué', async () => {
    const bad = JSON.parse(JSON.stringify(FRAGMENT));
    bad.tables.vehicules.fields.prix = { type: 'regclass' };
    await assert.rejects(
      installPackage(pool, { slug: 'mi_test_bad', version: '1.0.0', model_fragment: bad, webid: WEBID, baseIri: BASE }),
      e => e instanceof FragmentError && e.code === 'schema_violation');
    assert.equal((await q("SELECT to_regclass('app.store_mi_test_bad_vehicules')")).rows[0].to_regclass, null);
    assert.equal((await q("SELECT count(*)::int AS n FROM app.app_packages WHERE slug='mi_test_bad'")).rows[0].n, 0);
  });

  await ck('CA-B2 collision de noms physiques (slug a + table y_z vs slug a_y + table z) → prefix_collision', async () => {
    // store_mi_test_a_y_z est produite par les DEUX combinaisons → la 2e doit être refusée
    await installPackage(pool, { slug: 'mi_test_a', version: '1.0.0', model_fragment: { tables: { y_z: { pk: 'id', fields: { id: { type: 'bigint', serial: true } } } } }, webid: WEBID, baseIri: BASE });
    await assert.rejects(
      installPackage(pool, { slug: 'mi_test_a_y', version: '1.0.0', model_fragment: { tables: { z: { pk: 'id', fields: { id: { type: 'bigint', serial: true } } } } }, webid: WEBID, baseIri: BASE }),
      e => e instanceof FragmentError && e.code === 'prefix_collision');
  });

  await ck('CA-B3 deuxième package coexiste', async () => {
    await installPackage(pool, { slug: 'mi_test_garages', version: '0.1.0', model_fragment: FRAGMENT2, webid: WEBID, baseIri: BASE });
    assert.ok((await q("SELECT to_regclass('app.store_mi_test_garages_places')")).rows[0].to_regclass);
  });

  await ck('CA-B5 écriture → outbox + versioning (RG-3)', async () => {
    await q("INSERT INTO app.store_mi_test_flotte_vehicules (immatriculation, type, created_by) VALUES ('AA-123-BB','voiture',1)");
    const ob = await q("SELECT event_type FROM app.outbox WHERE event_type LIKE 'store_mi_test_flotte_vehicules.%' ORDER BY id DESC LIMIT 1");
    assert.equal(ob.rows[0].event_type, 'store_mi_test_flotte_vehicules.insert');
    const v = await q("SELECT count(*)::int AS n FROM app.versions WHERE table_name='store_mi_test_flotte_vehicules'");
    assert.ok(v.rows[0].n >= 1);
  });

  await ck('RLS/auth.can : owner lit, autre webid filtré sur table NON publiée (FORCE RLS)', async () => {
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
      assert.equal(mine2.rows[0].n, 1, 'owner écrit/voit (ACL owner héritée du conteneur package)');
      await c.query("SELECT set_config('app.webid', 'https://supervision.example/users/999', true)");
      const other = await c.query('SELECT count(*)::int AS n FROM app.store_mi_test_garages_places');
      assert.equal(other.rows[0].n, 0, 'autre webid : RLS filtre tout (table non publiée)');
    } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
  });

  await ck('RLS/auth.can : table publiée lisible par foaf:Agent (asset publié, contrat DSP au PDP)', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.base_iri', $1, true)", [BASE]);
      await c.query('SET ROLE app');
      await c.query("SELECT set_config('app.webid', 'https://autre.example/users/1', true)");
      const pub = await c.query('SELECT count(*)::int AS n FROM app.store_mi_test_flotte_vehicules');
      assert.ok(pub.rows[0].n >= 1, 'foaf:Agent lit la table publiée');
    } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
  });

  await ck('boot idempotent : réapplication sans erreur, pas de drift (CA-B7 négatif)', async () => {
    const r = await applyFragmentsAtBoot(pool, BASE, () => {});
    assert.ok(r.applied.includes('mi_test_flotte'));
    assert.deepEqual(r.drifted, []);
  });

  await ck('CA-B7 drift : colonne ajoutée à la main → état drift + alarme', async () => {
    await q('ALTER TABLE app.store_mi_test_flotte_vehicules ADD COLUMN hack_col text');
    const alarms = [];
    const r = await applyFragmentsAtBoot(pool, BASE, m => alarms.push(m));
    assert.ok(r.drifted.includes('mi_test_flotte'), 'drift détecté');
    assert.ok(alarms.length >= 1, 'alarme loguée');
    const st = await q("SELECT state FROM app.app_packages WHERE slug='mi_test_flotte'");
    assert.equal(st.rows[0].state, 'drift');
    await q('ALTER TABLE app.store_mi_test_flotte_vehicules DROP COLUMN hack_col');
    const r2 = await applyFragmentsAtBoot(pool, BASE, () => {});
    assert.deepEqual(r2.drifted, [], 'reboot propre après correction → retour installed');
  });

  await ck('CA-B4 révocation → contrat révoqué, asset dépublié, state revoked', async () => {
    await revokePackage(pool, 'mi_test_garages', WEBID);
    const st = await q("SELECT state, revoked_at IS NOT NULL AS has_revoked_at FROM app.app_packages WHERE slug='mi_test_garages'");
    assert.equal(st.rows[0].state, 'revoked');
    assert.equal(st.rows[0].has_revoked_at, true);
    const pub = await q("SELECT published FROM dsp.asset_mapping WHERE container_uri='/apps/mi_test_garages/places/'");
    assert.equal(pub.rows[0].published, false);
    const c = await q("SELECT c.state FROM dsp.contracts c JOIN app.app_packages p ON p.contract_id=c.agreement_id WHERE p.slug='mi_test_garages'");
    assert.equal(c.rows[0].state, 'revoked');
  });

  await ck('purge fragment-aware : drop des tables du package révoqué après rétention', async () => {
    await q("UPDATE app.app_packages SET revoked_at = now() - interval '31 days' WHERE slug='mi_test_garages'");
    await q("SELECT app.mi_drop_revoked_packages(interval '30 days')");
    assert.equal((await q("SELECT to_regclass('app.store_mi_test_garages_places')")).rows[0].to_regclass, null);
  });

  // nettoyage
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

main().catch(e => { console.error('ERREUR FATALE', e); process.exit(1); });
