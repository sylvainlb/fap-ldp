# core/tck — FAP-LDP core conformance tests

## e2e-smoke.sh — end-to-end test (27 assertions, AC-L1..L7, L10)

Launches a real throwaway deployment: Postgres 16 (migrations `core/sql/00*.sql` + boot of the model
`examples/supervision/model.json` by the `fap-ldp-model` node) + ORCE (image `fap-light-orce`)
loading the `core/nodes` package (3 nodes: model, PDP, LDP container), then plays HTTP requests
against the LDP endpoint:

```bash
# prerequisites: docker, images postgres:16-alpine and fap-light-orce:latest
# 1. network + Postgres
docker network create fapnet
docker run -d --name pg --network fapnet -e POSTGRES_PASSWORD=postgres \
  -v "$PWD/core/sql:/sql:ro" postgres:16-alpine
docker exec pg psql -U postgres -c "CREATE DATABASE fap"
for f in core/sql/00*.sql; do docker exec -i pg psql -U postgres -d fap -v ON_ERROR_STOP=1 -f "/sql/$(basename $f)"; done
# example gold schema (normally created by the FAP core)
docker exec pg psql -U postgres -d fap -c "CREATE SCHEMA gold; CREATE TABLE gold.city_dashboard_summary (id bigint PRIMARY KEY, building text, kwh double precision, day date); INSERT INTO gold.city_dashboard_summary VALUES (1,'Bat A',12.5,current_date),(2,'Bat B',8.1,current_date);"
docker exec -i pg psql -U postgres -d fap -f /sql/007_seed_asset_mapping.sql
docker exec pg psql -U postgres -d fap -c "CREATE USER app_rw LOGIN PASSWORD 'app'; GRANT app TO app_rw;"
# 2. ORCE with the package + a minimal flow (model + pdp + container) + settings (editor on /editor)
#    (test flow: see tck/fixtures/flows.json ; model.json = examples/supervision with base_iri localhost)
docker run -d --name orce --network fapnet -p 18880:1880 \
  -v "$PWD/core/nodes:/data/nodes/node-red-contrib-fap-ldp:ro" \
  -v "$PWD/core/tck/fixtures/flows.json:/data/flows.json:ro" \
  -v "$PWD/core/tck/fixtures/model.json:/data/model.json:ro" \
  -v "$PWD/core/tck/fixtures/settings.js:/data/settings.js:ro" \
  fap-light-orce:latest
# 3. seed (users, ACL, external contract) then tests
BASE=http://localhost:18880 ./core/tck/e2e-smoke.sh
```

Coverage: 401 without token · AC-L1 (POST→201+Location, read-after-write) · AC-L3 (resource ACL vs
container, 403) · AC-L10 (If-Match → 412, PUT/PATCH → version, Merge Patch RFC 7386 **and**
JSON Patch RFC 6902) · DELETE → tombstone → 404 · AC-L6 (GET/PUT `.acl` WebACL ⇄ `auth.acl`,
immediate effect) · root = published containers only · AC-L4 (external: contract without ACL → 403,
with DID in the ACL → 200 + audit `agreement_id`) · AC-L5 (ODRL `facis:resourceId isAnyOf`) ·
AC-L7 (unpublished container → 403 external) · AC-L11 (`permissions` inline) · AC-L12 (trailing slash)
· AC-L13 (`/users/<pk>` dereferenceable) · gold volume guard §6.7 (403 `GoldContainerTooLarge`) ·
gold resources in LDP.

Last run: **e2e 39 PASS / 0 FAIL** + **ldp-tests subset 8 PASS / 0 FAIL** (2026-11-19, postgres:16-alpine + fap-light-orce, Node-RED 4.0.9).
Covered: AC-L1..L7, L9 (revocation measured ~25 ms < 1 s), L10 (Merge Patch + JSON Patch RFC 6902),
L11 (`permissions` inline), L12 (trailing slash), L13 (dereferenceable webid), AC-L8 (W3C
ldp-tests subset, `ldp-w3c-subset.sh`), VC crypto verification (ES256, did:web, trust anchors —
valid VC 200, tampered signature 401, untrusted issuer 401), gold volume guard §6.7.
Measured latency: ~10 ms per LDP read on app.* (NFR §10 < 200 ms).

## Coming next

- Full W3C ldp-tests suite (beyond the §6.6 subset) in CI.
- Load tests (NFR §10, several concurrent clients).
