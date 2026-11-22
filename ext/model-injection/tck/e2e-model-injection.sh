#!/bin/sh
# e2e-model-injection.sh — TCK of ext/model-injection (E11) against a running FAP-LDP stack.
# Covers AC-B1..B8 of spec model-injection-spec.md v0.3 (except drift AC-B7, covered by
# tck/integration-pg.js which can re-trigger the boot).
# Env: BASE (default http://localhost:18880), PGC (admin psql, e.g. 'docker exec pg psql -U admin -d fap -q'),
#       TOK_ADMIN (devTokens token, admin role), TOK_USER (non-admin role token).
B=${BASE:-http://localhost:18880}
PGC=${PGC:-docker exec energy-supervision-postgres-1 psql -U admin -d fap -q}
A=${TOK_ADMIN:+"Authorization: Bearer $TOK_ADMIN"}
U=${TOK_USER:+"Authorization: Bearer $TOK_USER"}
pass=0; fail=0
ck() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "PASS $1 ($3)"; else fail=$((fail+1)); echo "FAIL $1: expected $2, got $3"; fi; }
code() { curl -s -o /tmp/mibody -w '%{http_code}' "$@"; }

FRAGMENT='{"tables":{"vehicules":{"pk":"id","owner":"created_by","published":true,"tombstone":"deleted_at","outbox":true,"fields":{"id":{"type":"bigint","serial":true},"immatriculation":{"type":"text","not_null":true,"unique":true},"type":{"type":"text","check_in":["voiture","camion","velo"]},"prix":{"type":"numeric"},"created_by":{"type":"bigint","fk":"users"},"created_at":{"type":"timestamptz","default":"now()"},"updated_at":{"type":"timestamptz","default":"now()"},"deleted_at":{"type":"timestamptz"}}}}}}'
FRAGMENT2='{"tables":{"places":{"pk":"id","published":false,"fields":{"id":{"type":"bigint","serial":true},"label":{"type":"text","not_null":true},"created_at":{"type":"timestamptz","default":"now()"},"updated_at":{"type":"timestamptz","default":"now()"}}}}}'
BADFRAG='{"tables":{"evil":{"pk":"id","fields":{"id":{"type":"bigint","serial":true},"x":{"type":"regclass"}}}}}'

# cleanup
$PGC -c "DELETE FROM app.app_packages WHERE slug IN ('flotte','garages')" >/dev/null 2>&1
$PGC -c "DROP TABLE IF EXISTS app.store_flotte_vehicules, app.store_garages_places" >/dev/null 2>&1

# 0. auth: no token → 401; non-admin → 403 (§3.2)
ck "POST /admin/apps without token → 401" 401 "$(code -X POST -H 'Content-Type: application/json' -d '{}' $B/admin/apps)"
[ -n "$U" ] && ck "POST /admin/apps non-admin → 403" 403 "$(code -X POST -H "$U" -H 'Content-Type: application/json' -d '{}' $B/admin/apps)"

# AC-B1: valid install → 201 + Location; tables/mapping/contract created
c=$(curl -s -D /tmp/mih -o /tmp/mibody -w '%{http_code}' -X POST -H "$A" -H 'Content-Type: application/json' \
  -d "{\"slug\":\"flotte\",\"version\":\"1.0.0\",\"meta\":{\"title_i18n\":{\"en\":\"Fleet\",\"fr\":\"Flotte\"},\"component\":\"x-flotte\",\"route\":\"/flotte\"},\"model_fragment\":$FRAGMENT}" \
  $B/admin/apps)
ck "POST /admin/apps valid → 201 (AC-B1)" 201 "$c"
loc=$(grep -i '^Location:' /tmp/mih | tr -d '\r' | awk '{print $2}'); echo "  Location: $loc"
ck "Location = /apps/flotte/meta" "$B/apps/flotte/meta" "$loc"
ck "table app.store_flotte_vehicules created (AC-B1)" 1 "$($PGC -t -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='app' AND table_name='store_flotte_vehicules'")"
ck "asset_mapping published (AC-B1)" t "$($PGC -t -c "SELECT published FROM dsp.asset_mapping WHERE container_uri='/apps/flotte/vehicules/'")"
ck "DSP contract created (contribution agreement)" 1 "$($PGC -t -c "SELECT count(*) FROM app.app_packages WHERE slug='flotte' AND contract_id IS NOT NULL")"
ck "GET /apps/ → 200 and contains flotte" ok "$(code -H "$A" $B/apps/ >/dev/null; curl -s -H "$A" $B/apps/ | grep -q 'apps/flotte/' && echo ok || echo ko)"
ck "GET /apps/flotte/meta → 200" 200 "$(code -H "$A" $B/apps/flotte/meta)"
ck "LDP container served by the PEP (AC-B1)" 200 "$(code -H "$A" $B/apps/flotte/vehicules/)"

# AC-B8: same slug → 409
ck "POST same slug → 409 (AC-B8)" 409 "$(code -X POST -H "$A" -H 'Content-Type: application/json' -d "{\"slug\":\"flotte\",\"version\":\"1.0.1\",\"model_fragment\":$FRAGMENT}" $B/admin/apps)"

# AC-B2: invalid fragment → 422 schema_violation, nothing applied
ck "POST invalid fragment → 422 (AC-B2)" 422 "$(code -X POST -H "$A" -H 'Content-Type: application/json' -d "{\"slug\":\"evil\",\"version\":\"1.0.0\",\"model_fragment\":$BADFRAG}" $B/admin/apps)"
grep -q 'schema_violation' /tmp/mibody && ck "dspace:Error code = schema_violation" ok ok || ck "code schema_violation" ok "$(cat /tmp/mibody)"
ck "nothing applied: no store_evil_* table (AC-B2)" 0 "$($PGC -t -c "SELECT count(*) FROM information_schema.tables WHERE table_name LIKE 'store_evil_%'")"

# AC-B3: second package without collision → 201
ck "POST 2nd package (garages) → 201 (AC-B3)" 201 "$(code -X POST -H "$A" -H 'Content-Type: application/json' -d "{\"slug\":\"garages\",\"version\":\"0.1.0\",\"model_fragment\":$FRAGMENT2}" $B/admin/apps)"
ck "table store_garages_places created (AC-B3)" 1 "$($PGC -t -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='app' AND table_name='store_garages_places'")"

# AC-B5: LDP write → outbox (RG-3, bronze via the gate on the core side)
c=$(curl -s -o /tmp/mibody -w '%{http_code}' -X POST -H "$A" -H 'Content-Type: application/ld+json' \
  -d '{"app_store_flotte_vehicules:immatriculation":"AA-123-BB","app_store_flotte_vehicules:type":"voiture","app_store_flotte_vehicules:created_by":1}' \
  $B/apps/flotte/vehicules/)
ck "POST feature resource → 201" 201 "$c"
ck "outbox fed (RG-3, AC-B5)" 1 "$($PGC -t -c "SELECT count(*) FROM app.outbox WHERE event_type LIKE 'store_flotte_vehicules.%'")"

# AC-B4: revocation → 204, contract revoked, asset unpublished
ck "DELETE /admin/apps/garages → 204 (AC-B4)" 204 "$(code -X DELETE -H "$A" $B/admin/apps/garages)"
ck "state=revoked (AC-B4)" revoked "$($PGC -t -c "SELECT state FROM app.app_packages WHERE slug='garages'")"
ck "asset unpublished (AC-B4)" f "$($PGC -t -c "SELECT published FROM dsp.asset_mapping WHERE container_uri='/apps/garages/places/'")"
ck "contract revoked (AC-B4)" revoked "$($PGC -t -c "SELECT c.state FROM dsp.contracts c JOIN app.app_packages p ON p.contract_id=c.agreement_id WHERE p.slug='garages'")"
ck "audit install+revoke (AC-B4)" 1 "$($PGC -t -c "SELECT count(*) FROM dsp.audit WHERE resource_uri LIKE '/apps/%'" | awk '{print ($1>=2)?1:0}')"

# 30-day fragment-aware purge (001_mi_maintenance.sql): retention 0 for the test
$PGC -c "UPDATE app.app_packages SET revoked_at = now() - interval '31 days' WHERE slug='garages'" >/dev/null
$PGC -c "SELECT app.mi_drop_revoked_packages(interval '30 days')" >/dev/null
ck "store_garages_* tables dropped after retention" 0 "$($PGC -t -c "SELECT count(*) FROM information_schema.tables WHERE table_name LIKE 'store_garages_%'")"

# flotte cleanup
code -X DELETE -H "$A" $B/admin/apps/flotte >/dev/null
$PGC -c "UPDATE app.app_packages SET revoked_at = now() - interval '31 days' WHERE slug='flotte'" >/dev/null
$PGC -c "SELECT app.mi_drop_revoked_packages(interval '30 days')" >/dev/null
$PGC -c "DELETE FROM app.app_packages WHERE slug IN ('flotte','garages')" >/dev/null

echo "== $pass PASS, $fail FAIL =="
