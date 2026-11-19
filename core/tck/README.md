# core/tck — Tests de conformité du core FAP-LDP

## e2e-smoke.sh — test de bout en bout (27 assertions, CA-L1..L7, L10)

Lance un vrai déploiement jetable : Postgres 16 (migrations `core/sql/00*.sql` + boot du modèle
`examples/supervision/model.json` par le nœud `fap-ldp-model`) + ORCE (image `fap-light-orce`)
chargeant le package `core/nodes` (3 nœuds : model, PDP, conteneur LDP), puis joue des requêtes
HTTP contre l'endpoint LDP :

```bash
# prérequis : docker, images postgres:16-alpine et fap-light-orce:latest
# 1. réseau + Postgres
docker network create fapnet
docker run -d --name pg --network fapnet -e POSTGRES_PASSWORD=postgres \
  -v "$PWD/core/sql:/sql:ro" postgres:16-alpine
docker exec pg psql -U postgres -c "CREATE DATABASE fap"
for f in core/sql/00*.sql; do docker exec -i pg psql -U postgres -d fap -v ON_ERROR_STOP=1 -f "/sql/$(basename $f)"; done
# schéma gold d'exemple (normalement créé par le cœur FAP)
docker exec pg psql -U postgres -d fap -c "CREATE SCHEMA gold; CREATE TABLE gold.city_dashboard_summary (id bigint PRIMARY KEY, building text, kwh double precision, day date); INSERT INTO gold.city_dashboard_summary VALUES (1,'Bat A',12.5,current_date),(2,'Bat B',8.1,current_date);"
docker exec -i pg psql -U postgres -d fap -f /sql/007_seed_asset_mapping.sql
docker exec pg psql -U postgres -d fap -c "CREATE USER app_rw LOGIN PASSWORD 'app'; GRANT app TO app_rw;"
# 2. ORCE avec le package + un flow minimal (model + pdp + container) + settings (éditeur sur /editor)
#    (flow de test : voir tck/fixtures/flows.json ; model.json = examples/supervision avec base_iri localhost)
docker run -d --name orce --network fapnet -p 18880:1880 \
  -v "$PWD/core/nodes:/data/nodes/node-red-contrib-fap-ldp:ro" \
  -v "$PWD/core/tck/fixtures/flows.json:/data/flows.json:ro" \
  -v "$PWD/core/tck/fixtures/model.json:/data/model.json:ro" \
  -v "$PWD/core/tck/fixtures/settings.js:/data/settings.js:ro" \
  fap-light-orce:latest
# 3. seed (utilisateurs, ACL, contrat externe) puis tests
BASE=http://localhost:18880 ./core/tck/e2e-smoke.sh
```

Couverture : 401 sans token · CA-L1 (POST→201+Location, read-after-write) · CA-L3 (ACL ressource vs
conteneur, 403) · CA-L10 (If-Match → 412, PUT/PATCH → version, Merge Patch RFC 7386 **et**
JSON Patch RFC 6902) · DELETE → tombstone → 404 · CA-L6 (GET/PUT `.acl` WebACL ⇄ `auth.acl`,
effet immédiat) · racine = conteneurs publiés seuls · CA-L4 (externe : contrat sans ACL → 403,
avec DID dans l'ACL → 200 + audit `agreement_id`) · CA-L5 (ODRL `facis:resourceId isAnyOf`) ·
CA-L7 (conteneur non publié → 403 externe) · CA-L11 (`permissions` inline) · CA-L12 (slash final)
· CA-L13 (`/users/<pk>` déréférençable) · garde volumétrie gold §6.7 (403 `GoldContainerTooLarge`) ·
ressources gold en LDP.

Dernier run : **e2e 39 PASS / 0 FAIL** + **ldp-tests subset 8 PASS / 0 FAIL** (2026-11-19, postgres:16-alpine + fap-light-orce, Node-RED 4.0.9).
Couvert : CA-L1..L7, L9 (révocation mesurée ~25 ms < 1 s), L10 (Merge Patch + JSON Patch RFC 6902),
L11 (`permissions` inline), L12 (slash final), L13 (webid déréférençable), CA-L8 (sous-ensemble
ldp-tests W3C, `ldp-w3c-subset.sh`), vérification crypto VC (ES256, did:web, trust anchors —
VC valide 200, signature altérée 401, émetteur non confiance 401), garde volumétrie gold §6.7.
Latence mesurée : ~10 ms par lecture LDP app.* (ENF §10 < 200 ms).

## À venir

- Suite W3C ldp-tests complète (au-delà du sous-ensemble §6.6) en CI.
- Tests de charge (ENF §10, plusieurs clients concurrents).
