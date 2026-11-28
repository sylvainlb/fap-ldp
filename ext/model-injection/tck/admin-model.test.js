// admin-model.test.js — integration tests of the POST /admin/model channel (E11 v1, hot additive
// patch of the core model). Two layers, no Node-RED needed:
//   1. handleAdminModel directly (lib/corepatch.js) against a real Postgres 16 — 401/403/428/409/
//      422/200, idempotence, ACL, signed republished contract (dsp.contracts), audit, column in DB,
//      atomic model.json write (.bak + hash).
//   2. the mi-admin node itself with a mock RED — HTTP status mapping (401/403/405 feature-detect,
//      409, 200) + claimsFromRequest + dspace:Error bodies.
//
//   PG_ADMIN_DSN=postgres://admin:***@localhost:5432/fap node tck/admin-model.test.js
//
// The script cleans up its artifacts (app.mi_test_core_*, mapping/ACL/contract/audit rows, tmp dir).
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const test = require('node:test');
const { Pool } = require('pg');
const { handleAdminModel, sha256 } = require(path.join(__dirname, '..', 'nodes', 'lib', 'corepatch'));

const DSN = process.env.PG_ADMIN_DSN; // absent → the test below is skipped (node --test tck/ stays green)
const BASE = 'http://localhost:18899/'; // test-only base IRI (isolates ACL/contract/audit rows)
const WEBID = 'https://supervision.example/users/1';
const ADMIN = { webid: WEBID, role: 'admin', did: 'did:web:supervision.example' };
const ALICE = { webid: 'https://supervision.example/users/2', role: 'technician' };

// base table already applied at "boot" (created directly in PG + declared in the model file)
const BASE_TABLE = {
  pk: 'id', published: true,
  fields: {
    id: 'bigserial', label: 'text not null',
    created_at: 'timestamptz default now()', updated_at: 'timestamptz default now()'
  }
};
const MODEL_V0 = { base_iri: BASE, tables: { mi_test_core_base: BASE_TABLE } };
// annexe-A form of the current file (as the editor normalizes it)
const MODEL_V0_A = {
  tables: {
    mi_test_core_base: {
      pk: 'id', published: true,
      fields: {
        id: { type: 'bigint', serial: true }, label: { type: 'text', not_null: true },
        created_at: { type: 'timestamptz', default: 'now()' }, updated_at: { type: 'timestamptz', default: 'now()' }
      }
    }
  }
};
// v1 = v0 + one NEW table (additive create, published)
const MODEL_V1_A = JSON.parse(JSON.stringify(MODEL_V0_A));
MODEL_V1_A.tables.mi_test_core_t1 = {
  pk: 'id', published: true,
  fields: {
    id: { type: 'bigint', serial: true }, label: { type: 'text', not_null: true },
    created_at: { type: 'timestamptz', default: 'now()' }, updated_at: { type: 'timestamptz', default: 'now()' }
  }
};
// v2 = v1 + one NEW column on the existing base table (additive alter)
const MODEL_V2_A = JSON.parse(JSON.stringify(MODEL_V1_A));
MODEL_V2_A.tables.mi_test_core_base.fields.area = { type: 'numeric' };
// v3 = v2 + one NEW table with a fk towards another core table (additive create)
const MODEL_V3_A = JSON.parse(JSON.stringify(MODEL_V2_A));
MODEL_V3_A.tables.mi_test_core_t2 = {
  pk: 'id', published: true,
  fields: {
    id: { type: 'bigint', serial: true }, label: { type: 'text', not_null: true },
    t1_id: { type: 'bigint', fk: 'mi_test_core_t1' },
    created_at: { type: 'timestamptz', default: 'now()' }, updated_at: { type: 'timestamptz', default: 'now()' }
  }
};

let pass = 0, fail = 0;
function ck(name, fn) {
  return Promise.resolve().then(fn).then(() => { pass++; console.log('  ok -', name); })
    .catch(e => { fail++; console.log('  not ok -', name, '-', e.message); });
}

test('POST /admin/model — intégration PG (401/403/405/428/409/422/200, idempotence, ACL, contrat signé, HTTP mock RED)',
  { skip: !DSN && 'PG_ADMIN_DSN required (postgres://admin:***@localhost:5432/fap)' },
  async () => { await main(); assert.equal(fail, 0, fail + ' sous-tests en échec'); });

async function main() {
  const pool = new Pool({ connectionString: DSN, max: 3 });
  const q = (s, p) => pool.query(s, p);

  // ext migrations (replayable) so app.app_packages etc. exist if needed
  for (const f of ['000_model_injection.sql', '001_mi_maintenance.sql']) {
    await q(fs.readFileSync(path.join(__dirname, '..', 'sql', f), 'utf8'));
  }

  // cleanup from a previous run
  await q(`DO $$ DECLARE r record; BEGIN
    FOR r IN SELECT table_name FROM information_schema.tables WHERE table_schema='app' AND table_name LIKE 'mi\\_test\\_core\\_%'
    LOOP EXECUTE format('DROP TABLE IF EXISTS app.%I CASCADE', r.table_name); END LOOP;
  END $$`);
  await q("DELETE FROM dsp.asset_mapping WHERE container_uri LIKE '/mi_test_core_%'");
  await q("DELETE FROM auth.acl WHERE resource_uri LIKE $1", [BASE + 'mi_test_core_%']);
  await q("DELETE FROM dsp.contracts WHERE agreement_id LIKE 'agr-core-model-%'");
  await q("DELETE FROM dsp.audit WHERE resource_uri = $1", [BASE + 'shapes']);

  // isolated core model.json in a tmp dir + the base table applied "at boot"
  await q(`CREATE TABLE IF NOT EXISTS app.mi_test_core_base (id bigserial PRIMARY KEY, label text NOT NULL, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now())`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mi-admin-model-'));
  const modelPath = path.join(dir, 'model.json');
  fs.writeFileSync(modelPath, JSON.stringify(MODEL_V0, null, 1) + '\n', 'utf8');
  const hash0 = sha256(fs.readFileSync(modelPath, 'utf8'));

  const call = (over) => handleAdminModel({
    pool, modelPath, baseIri: BASE, claims: ADMIN, method: 'POST',
    ifMatch: `"${hash0}"`, body: { model: MODEL_V1_A }, ...over
  });

  await ck('401 — no claims', async () => {
    const r = await call({ claims: null });
    assert.equal(r.status, 401); assert.equal(r.code, 'Unauthorized');
  });

  await ck('403 — non-admin role (alice)', async () => {
    const r = await call({ claims: ALICE });
    assert.equal(r.status, 403); assert.equal(r.code, 'Forbidden');
  });

  await ck('405 — GET /admin/model as admin (feature-detect: channel present)', async () => {
    const r = await call({ method: 'GET' });
    assert.equal(r.status, 405);
  });

  await ck('428 — If-Match obligatoire', async () => {
    const r = await call({ ifMatch: undefined });
    assert.equal(r.status, 428); assert.equal(r.code, 'PreconditionRequired');
  });

  await ck('409 — If-Match périmé', async () => {
    const r = await call({ ifMatch: '"deadbeef"' });
    assert.equal(r.status, 409); assert.equal(r.code, 'Conflict');
  });

  await ck('422 — validation échouée (type non whitelisté)', async () => {
    const bad = JSON.parse(JSON.stringify(MODEL_V1_A));
    bad.tables.mi_test_core_t1.fields.area = { type: 'regclass' };
    const r = await call({ body: { model: bad } });
    assert.equal(r.status, 422); assert.equal(r.code, 'schema_violation');
  });

  await ck('422 — diff non additif (colonne supprimée), rien n applied', async () => {
    const drop = JSON.parse(JSON.stringify(MODEL_V1_A));
    delete drop.tables.mi_test_core_base.fields.label;
    const r = await call({ body: { model: drop } });
    assert.equal(r.status, 422); assert.equal(r.code, 'non_additive');
    const col = await q("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='app' AND table_name='mi_test_core_base' AND column_name='label'");
    assert.equal(col.rows[0].n, 1, 'no partial DDL: colonne toujours là');
  });

  let hash1, agreement1;
  // sequence: create t1 (v1) → alter base.area (v2) → create t2 with fk (v3) → idempotent replay
  await ck('200 — create table cœur (v1) : table + triggers + RLS + mapping + ACL façon 102 + contrat signé + audit + fichier atomique', async () => {
    const r = await call({ body: { model: MODEL_V1_A } });
    assert.equal(r.status, 200, JSON.stringify(r));
    assert.deepEqual(r.body.contract.creates, ['mi_test_core_t1']);
    assert.deepEqual(r.body.contract.alters, []);
    hash1 = r.body.hash; agreement1 = r.body.contract.agreement_id;
    assert.ok((await q("SELECT to_regclass('app.mi_test_core_t1')")).rows[0].to_regclass, 'table créée');
    const trg = await q("SELECT tgname FROM pg_trigger WHERE tgrelid='app.mi_test_core_t1'::regclass AND NOT tgisinternal ORDER BY 1");
    assert.deepEqual(trg.rows.map(r => r.tgname), ['outbox', 'set_updated_at', 'versioning']);
    const pol = await q("SELECT policyname FROM pg_policies WHERE schemaname='app' AND tablename='mi_test_core_t1' ORDER BY 1");
    assert.deepEqual(pol.rows.map(r => r.policyname),
      ['mi_test_core_t1_delete', 'mi_test_core_t1_insert', 'mi_test_core_t1_read', 'mi_test_core_t1_write']);
    const map = await q("SELECT table_name, published FROM dsp.asset_mapping WHERE container_uri='/mi_test_core_t1/'");
    assert.equal(map.rows[0].table_name, 'mi_test_core_t1'); assert.equal(map.rows[0].published, true);
    const acl = await q("SELECT subject, modes, inherited FROM auth.acl WHERE resource_uri=$1 ORDER BY subject", [BASE + 'mi_test_core_t1/']);
    assert.deepEqual(acl.rows.map(r => r.subject).sort(), ['foaf:Agent', 'role:admin'].sort());
    assert.ok(acl.rows.find(r => r.subject === 'role:admin').modes.includes('control'));
    assert.ok(acl.rows.every(r => r.inherited === true), 'ACL façon 102: inherited sur le conteneur');
    // contrat republié signé dans dsp.contracts
    const c = await q("SELECT asset_uri, assignee_did, state, policy_jsonld FROM dsp.contracts WHERE agreement_id=$1", [agreement1]);
    assert.equal(c.rows[0].state, 'active');
    assert.equal(c.rows[0].asset_uri, BASE);
    assert.equal(c.rows[0].assignee_did, WEBID);
    const mc = c.rows[0].policy_jsonld['facis:modelContract'];
    assert.equal(mc.model_hash, hash1);
    assert.equal(mc.previous_model_hash, hash0);
    assert.equal(mc.algorithm, 'sha256');
    assert.ok(/^[0-9a-f]{64}$/.test(mc.signature), 'signature sha256 présente');
    assert.ok(mc.contract_hash, 'contrat SHACL recompilé (hash)');
    assert.equal(r.body.contract.signature, mc.signature);
    // audit
    const au = await q("SELECT webid, mode, decision FROM dsp.audit WHERE agreement_id=$1", [agreement1]);
    assert.equal(au.rows.length, 1); assert.equal(au.rows[0].webid, WEBID); assert.equal(au.rows[0].mode, 'control');
    // écriture atomique : .bak + hash du fichier == hash réponse
    assert.ok(fs.existsSync(modelPath + '.bak'), 'backup .bak avant écriture');
    const rawNow = fs.readFileSync(modelPath, 'utf8');
    assert.equal(sha256(rawNow), hash1, 'hash réponse = sha256 du model.json écrit');
    assert.equal(JSON.parse(rawNow).tables.mi_test_core_t1.fields.id, 'bigserial', 'dialecte core conservé');
  });

  await ck('200 — alter additif (colonne area sur la table base existante)', async () => {
    const r = await call({ ifMatch: `"${hash1}"`, body: { model: MODEL_V2_A } });
    assert.equal(r.status, 200, JSON.stringify(r));
    assert.deepEqual(r.body.contract.creates, []);
    assert.deepEqual(r.body.contract.alters, ['mi_test_core_base.area']);
    hash1 = r.body.hash;
    const col = await q("SELECT data_type FROM information_schema.columns WHERE table_schema='app' AND table_name='mi_test_core_base' AND column_name='area'");
    assert.equal(col.rows[0].data_type, 'numeric');
    assert.equal(sha256(fs.readFileSync(modelPath, 'utf8')), r.body.hash);
  });

  await ck('200 — create de la 2e table (v3, fk vers table cœur)', async () => {
    const r = await call({ ifMatch: `"${hash1}"`, body: { model: MODEL_V3_A } });
    assert.equal(r.status, 200, JSON.stringify(r));
    assert.deepEqual(r.body.contract.creates, ['mi_test_core_t2']);
    hash1 = r.body.hash;
    assert.ok((await q("SELECT to_regclass('app.mi_test_core_t2')")).rows[0].to_regclass);
    const fk = await q(`SELECT confrelid::regclass::text AS target FROM pg_constraint WHERE conrelid='app.mi_test_core_t2'::regclass AND contype='f'`);
    assert.equal(fk.rows[0].target, 'app.mi_test_core_t1');
  });

  await ck('idempotence — re-POST du même modèle avec le hash courant → 200, hash identique, aucun DDL', async () => {
    const before = sha256(fs.readFileSync(modelPath, 'utf8'));
    const nContracts = (await q("SELECT count(*)::int AS n FROM dsp.contracts WHERE agreement_id LIKE 'agr-core-model-%'")).rows[0].n;
    const r = await call({ ifMatch: `"${hash1}"`, body: { model: MODEL_V3_A } });
    assert.equal(r.status, 200, JSON.stringify(r));
    assert.equal(r.body.hash, before, 'model inchangé → hash identique');
    assert.deepEqual(r.body.contract.creates, []); assert.deepEqual(r.body.contract.alters, []);
    assert.equal(sha256(fs.readFileSync(modelPath, 'utf8')), before);
    assert.equal((await q("SELECT count(*)::int AS n FROM dsp.contracts WHERE agreement_id LIKE 'agr-core-model-%'")).rows[0].n, nContracts + 1, 'contrat republié à chaque POST (hash chain)');
  });

  await ck('409 après modification concurrente — If-Match de la génération précédente', async () => {
    const stale = sha256(JSON.stringify(MODEL_V0, null, 1) + '\n');
    const r = await call({ ifMatch: `"${stale}"`, body: { model: MODEL_V3_A } });
    assert.equal(r.status, 409);
  });

  await ck('transaction unique — create vers une table qui existe déjà hors modèle → 422, rollback complet', async () => {
    const collide = { tables: { ...MODEL_V3_A.tables, buildings: { pk: 'id', fields: { id: { type: 'bigint', serial: true }, name: { type: 'text' } } } } };
    const r = await call({ ifMatch: `"${hash1}"`, body: { model: collide } });
    assert.equal(r.status, 422); assert.equal(r.code, 'prefix_collision');
    const map = await q("SELECT count(*)::int AS n FROM dsp.asset_mapping WHERE container_uri='/buildings/'");
    assert.equal(map.rows[0].n, 1, 'mapping buildings non touché (rollback)');
  });

  // ---------- couche HTTP : mi-admin avec mock RED ----------
  await ck('HTTP — mi-admin node (mock RED): 401 sans token, 403 alice, 405 GET admin, 409 If-Match faux, 200 admin', async () => {
    let mw = null; const types = {};
    const RED = {
      nodes: {
        createNode(n) { n.on = () => {}; n.log = () => {}; n.warn = () => {}; n.error = () => {}; },
        registerType(t, ctor) { types[t] = ctor; }
      },
      httpNode: { disable() {}, use(fn) { mw = fn; } }
    };
    require(path.join(__dirname, '..', 'nodes', 'mi-admin.js'))(RED);
    const Ctor = types['fap-ldp-mi-admin'];
    assert.ok(Ctor, 'node enregistré');
    const node = new Ctor({
      baseIri: BASE, pgDsn: DSN, modelPath,
      devTokens: JSON.stringify({ 'tok-admin': ADMIN, 'tok-alice': ALICE })
    });
    assert.ok(typeof mw === 'function', 'middleware http capturé à l instanciation');

    function fakeReq({ method = 'GET', path: p = '/admin/model', headers = {}, body = {} }) {
      return { method, path: p, headers, body, on() {} };
    }
    function fakeRes(done) {
      return {
        statusCode: 200, headers: {}, body: null, headersSent: false,
        set(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
        status(c) { this.statusCode = c; return this; },
        json(o) { this.body = o; this.headersSent = true; done(this); return this; },
        end() { done(this); return this; }
      };
    }
    const run = (req) => new Promise((ok, ko) => {
      let settled = false;
      const done = (res) => { if (!settled) { settled = true; ok({ req, res }); } };
      const res = fakeRes(done);
      mw(req, res, (err) => { if (err) return ko(err); done(res); });
      setTimeout(() => { if (!settled) { settled = true; ko(new Error('timeout: no response')); } }, 15000);
    });

    let r = await run(fakeReq({ headers: {} }));
    assert.equal(r.res.statusCode, 401);
    assert.equal(r.res.body['@type'], 'dspace:Error');
    assert.equal(r.res.body['dspace:errorCode'], 'Unauthorized');
    assert.ok(r.res.headers['www-authenticate']);

    r = await run(fakeReq({ headers: { authorization: 'Bearer tok-alice' } })); // GET → 403 (canal présent)
    assert.equal(r.res.statusCode, 403);
    assert.equal(r.res.body['dspace:errorCode'], 'Forbidden');

    r = await run(fakeReq({ headers: { authorization: 'Bearer tok-admin' } })); // GET admin → 405 (feature-detect)
    assert.equal(r.res.statusCode, 405);

    r = await run(fakeReq({
      method: 'POST', headers: { authorization: 'Bearer tok-admin', 'if-match': '"faux"', 'content-type': 'application/json' },
      body: { model: MODEL_V3_A }
    }));
    assert.equal(r.res.statusCode, 409);
    assert.equal(r.res.body['dspace:errorCode'], 'Conflict');

    // 200 via HTTP (hash courant lu dans le fichier)
    const cur = sha256(fs.readFileSync(modelPath, 'utf8'));
    r = await run(fakeReq({
      method: 'POST', headers: { authorization: 'Bearer tok-admin', 'if-match': `"${cur}"`, 'content-type': 'application/json' },
      body: { model: MODEL_V3_A }
    }));
    assert.equal(r.res.statusCode, 200, JSON.stringify(r.res.body));
    assert.ok(r.res.body.hash && r.res.body.contract && r.res.body.contract.agreement_id);
    assert.equal(r.res.headers['etag'], `"${r.res.body.hash}"`);
    // pas de secret en log : le body contient hash/contrat uniquement
    assert.ok(!JSON.stringify(r.res.body).includes('tok-admin'));

    await node.pool.end().catch(() => {});
  });

  // cleanup
  await q(`DO $$ DECLARE r record; BEGIN
    FOR r IN SELECT table_name FROM information_schema.tables WHERE table_schema='app' AND table_name LIKE 'mi\\_test\\_core\\_%'
    LOOP EXECUTE format('DROP TABLE IF EXISTS app.%I CASCADE', r.table_name); END LOOP;
  END $$`);
  await q("DELETE FROM dsp.asset_mapping WHERE container_uri LIKE '/mi_test_core_%'");
  await q("DELETE FROM auth.acl WHERE resource_uri LIKE $1", [BASE + 'mi_test_core_%']);
  await q("DELETE FROM dsp.contracts WHERE agreement_id LIKE 'agr-core-model-%'");
  await q("DELETE FROM dsp.audit WHERE resource_uri = $1", [BASE + 'shapes']);
  fs.rmSync(dir, { recursive: true, force: true });
  await pool.end();
  console.log(`== ${pass} PASS, ${fail} FAIL ==`);
}

test('coreDialect: core model.json root metadata keys ($comment, base_iri, business_rules) accepted in core dialect, rejected for packages', () => {
  const { validateFragment } = require('../nodes/lib/fragment');
  const core = { $comment: 'x', base_iri: 'http://x/', business_rules: [], tables: { t: { pk: 'id', fields: { id: { type: 'bigint', serial: true } } } } };
  assert.doesNotThrow(() => validateFragment(core, undefined, { coreDialect: true }));
  assert.throws(() => validateFragment(core), /unauthorized root key: \$comment/);
});

test('coreDialect: SQL-ish string field defs ("text not null", "bigint fk x(id)") accepted in core dialect only', () => {
  const { validateFragment } = require('../nodes/lib/fragment');
  const core = { tables: { buildings: { pk: 'id', fields: { id: 'bigserial', name: 'text not null', owner_id: 'bigint fk users(id)' } } } };
  assert.doesNotThrow(() => validateFragment(core, undefined, { coreDialect: true }));
  assert.throws(() => validateFragment(core), /object expected/);
});

test('v1.1 ordering: DB transaction failure → model.json restored from .bak (no file/DB drift)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mi-rollback-'));
  const modelPath = path.join(dir, 'model.json');
  const MODEL = { base_iri: 'http://x/', tables: { t: { pk: 'id', fields: { id: 'bigserial', label: 'text not null' } } } };
  fs.writeFileSync(modelPath, JSON.stringify(MODEL, null, 1) + '\n', 'utf8');
  const h0 = sha256(fs.readFileSync(modelPath, 'utf8'));
  const failingPool = {
    connect: async () => ({
      query: async (s) => { if (s === 'ROLLBACK') return; throw new Error('boom'); },
      release: () => {}
    }),
    query: async () => {}
  };
  const NEW = JSON.parse(JSON.stringify(MODEL));
  NEW.tables.t.fields.area = 'numeric'; // additive alter → passes validation, reaches the DB tx
  await assert.rejects(
    () => handleAdminModel({ pool: failingPool, modelPath, baseIri: 'http://x/', claims: { webid: 'w', role: 'admin' }, method: 'POST', ifMatch: `"${h0}"`, body: { model: NEW } }),
    /boom/);
  assert.equal(sha256(fs.readFileSync(modelPath, 'utf8')), h0, 'model.json restored to pre-request state');
  assert.ok(fs.existsSync(modelPath + '.bak'), '.bak backup kept');
});
