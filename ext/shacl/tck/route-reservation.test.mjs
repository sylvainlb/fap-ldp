// route-reservation.test.mjs — the A.2 patch in core/nodes/nodes/ldp-container.js must reserve
// EVERY route served by ext/shacl (otherwise the core PEP would answer them as LDP resources).
// Guards the transverse agreement: the core contact of this ext is exactly this reservation.
// Run: node --test tck/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const core = readFileSync(fileURLToPath(new URL('../../../core/nodes/nodes/ldp-container.js', import.meta.url)), 'utf8');
const serve = readFileSync(fileURLToPath(new URL('../nodes/shacl-serve.js', import.meta.url)), 'utf8');

// patterns as written in the reservation block of ldp-container.js
const patterns = [
  '/^\\/shapes(?:\\/[^/]+)?\\/?$/',                                        // /shapes, /shapes/, /shapes/<table>
  '/^\\/fragment$/',
  '/^\\/shacl\\/preview$/',
  '/^\\/apps\\/[^/]+\\/(shapes(?:\\/[^/]+)?|validate|fragment)$/',        // + /apps/<slug>/shapes/<table>
  '/^\\/apps\\/[^/]+\\/[^/]+\\/validate$/',
];
const reserved = patterns.map((p) => new RegExp(p.slice(1, -1)));

const servedPaths = [
  '/shapes', '/shapes/', '/shapes/tickets', '/fragment', '/shacl/preview',
  '/apps/fleet/shapes', '/apps/fleet/shapes/vehicles', '/apps/fleet/fragment',
  '/apps/fleet/validate', '/apps/fleet/vehicles/validate',
];
const ldpPaths = ['/buildings/', '/apps/fleet/vehicles/', '/apps/fleet/vehicles/42', '/tickets/'];

test('A.2 — every ext/shacl route pattern is present in the core LDP node and matches', () => {
  for (const p of patterns) assert.ok(core.includes(p), `core reserves pattern ${p}`);
  for (const path of servedPaths) {
    assert.ok(reserved.some((re) => re.test(path)), `${path} must be reserved`);
  }
  for (const path of ldpPaths) {
    assert.ok(!reserved.some((re) => re.test(path)), `${path} must stay on the LDP path`);
  }
});

test('A.2 — the ext actually serves the reserved routes (guard against drift on the ext side)', () => {
  for (const frag of ['mPkgShapes', 'mPkgShape', 'mCoreShape', 'mPkgFragment', 'mPkgValidate', 'mTblValidate', 'isCoreShapes', 'isCoreFragment', 'isPreview']) {
    assert.ok(serve.includes(frag), `ext serves ${frag}`);
  }
});

test('A.2 — the E11 reservations are untouched (no regression on /admin, /apps meta)', () => {
  assert.ok(core.includes("req.path.startsWith('/admin/')"));
  assert.ok(core.includes('/^\\/apps\\/?$/.test(req.path)'));
  assert.ok(core.includes('/^\\/apps\\/[^/]+\\/meta$/.test(req.path)'));
});
