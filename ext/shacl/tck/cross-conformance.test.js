// cross-conformance.test.js — F5.1/F5.2 at unit level (no PG): a row served by the core's
// JSON-LD serializer (core/nodes/lib/jsonld.js resourceDoc, SELECT to_jsonb → raw values)
// must validate against the contract compiled from the deployment's model.json.
// Run: node --test tck/
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { compile } = require('../nodes/lib/compiler');
const { validate } = require('../nodes/lib/validate');
const jsonld = require('../../../core/nodes/lib/jsonld');

const BASE = 'https://pod.example/';
const MODEL = path.join(__dirname, '..', '..', '..', '..', 'app-supervision-backend', 'config', 'model.json');
const model = JSON.parse(fs.readFileSync(MODEL, 'utf8'));
const compiled = compile({ fragment: model, baseIri: BASE, slug: null, published: null }); // core: all tables

const row = {
  id: 482, title: 'Fuite chaufferie', description: '…', status: 'OPEN', priority: 'HIGH',
  building_id: 7, anomaly_ref: 'AN-2026-001', created_by: 1, assigned_to: null,
  created_at: '2026-11-20T10:00:00Z', updated_at: '2026-11-20T10:00:00Z', deleted_at: null
};

function servedDoc(table, r) {
  return jsonld.resourceDoc(BASE, `/${table}/`, 'app', table, r, 'id');
}

test('F5.1: served JSON-LD row of every published core table conforms to the compiled contract', () => {
  for (const t of ['tickets', 'buildings', 'comments']) {
    const r = t === 'tickets' ? row : {
      id: 1, created_at: '2026-11-20T10:00:00Z', updated_at: '2026-11-20T10:00:00Z', deleted_at: null,
      ...(t === 'buildings' ? { name: 'Bât A', address: '1 rue x', meter_id: 'M-1', facis_asset: 'A-1', lat: 48.85, lon: 2.35, area_m2: 120.5 } : { ticket_id: 482, author: 1, text: 'ok', ts: '2026-11-20T10:00:00Z' })
    };
    const doc = servedDoc(t, r);
    const rep = validate(doc, compiled.shapes);
    assert.strictEqual(rep['sh:conforms'], true, `${t}: ${JSON.stringify(rep['sh:result'])}`);
  }
});

test('F5.1 detects divergence: bad check_in value → sh:in violation', () => {
  const doc = servedDoc('tickets', { ...row, status: 'BOGUS' });
  const rep = validate(doc, compiled.shapes);
  assert.strictEqual(rep['sh:conforms'], false);
  assert.ok(rep['sh:result'].some(x => x['sh:sourceConstraintComponent']['@id'].endsWith('InConstraintComponent')));
});

test('F5.1 detects divergence: missing not-null title → sh:minCount violation', () => {
  const r = { ...row }; delete r.title;
  const rep = validate(servedDoc('tickets', r), compiled.shapes);
  assert.ok(rep['sh:result'].some(x => x['sh:sourceConstraintComponent']['@id'].endsWith('MinCountConstraintComponent')));
});

test('F5.2 (documented expectation): conformant but governed — status CLOSED validates against the contract while SQL would 409 on create', () => {
  const doc = servedDoc('tickets', { ...row, status: 'CLOSED' });
  const rep = validate(doc, compiled.shapes);
  assert.strictEqual(rep['sh:conforms'], true); // CLOSED ∈ check_in → contract-conformant
  // the write path rejects it (business rule, hors contrat R1.5) → classed "gouverned", not "incoherent"
});

test('F5.1: FK served as raw integer conforms (fk compiles to xsd:integer unless node_kind: iri)', () => {
  const doc = servedDoc('tickets', row); // building_id: 7 (raw), created_by: 1 (raw)
  const rep = validate(doc, compiled.shapes);
  assert.strictEqual(rep['sh:conforms'], true, JSON.stringify(rep['sh:result'], null, 1));
});

test('core dialect parsing: "text default ... check in (...)" / "bigint fk users(id)" / "bigserial"', () => {
  const t = compiled.turtle;
  assert.match(t, /sh:path <https:\/\/pod\.example\/ns\/app\/tickets#status>[\s\S]*?sh:in \( "CLOSED" "IN_PROGRESS" "OPEN" "RESOLVED" \)/);
  assert.match(t, /#titleProperty[\s\S]*?sh:minCount 1/);       // "text not null"
  assert.match(t, /#building_idProperty[\s\S]*?sh:datatype xsd:integer/); // fk served as integer
  assert.match(t, /sh:targetClass <https:\/\/pod\.example\/ns\/app\/tickets#Tickets>/);
});
