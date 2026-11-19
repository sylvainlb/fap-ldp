#!/bin/sh
# ldp-w3c-subset.sh — sous-ensemble de la suite W3C ldp-tests (https://w3c.github.io/ldp-tests/)
# retenu par la spec fap-ldp v0.3 §6.6 pour CA-L8 :
#   CRUD ressource · POST + Location (201) · BasicContainer (ldp:contains) ·
#   Link rel="type" (ldp:Resource/ldp:Container) · ETag + 304 (If-None-Match)
# Usage : BASE=https://pod/ TOKEN=... ./ldp-w3c-subset.sh
B=${BASE:-http://localhost:18880}
T=${TOKEN:?TOKEN requis}
H="Authorization: Bearer $T"
pass=0; fail=0
ck() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "PASS $1"; else fail=$((fail+1)); echo "FAIL $1: attendu $2, obtenu $3"; fi; }
code() { curl -s -o /tmp/w3c-body -w '%{http_code}' "$@"; }

# --- CRUD ressource (ldp-tests: create/read/update/delete resource) ---
c=$(curl -s -D /tmp/w3c-h -o /tmp/w3c-body -w '%{http_code}' -H "$H" -H 'Content-Type: application/ld+json' \
  -d '{"app_tickets:title":"W3C","app_tickets:building_id":1,"app_tickets:created_by":1}' "$B/tickets/")
ck "POST container → 201 (ldp-tests create)" 201 "$c"
loc=$(grep -i '^Location:' /tmp/w3c-h | tr -d '\r' | awk '{print $2}')
ck "GET ressource créée → 200 (read)" 200 "$(code -H "$H" "$loc")"
curl -s -D /tmp/w3c-h -o /dev/null -H "$H" "$loc"; etag=$(grep -i '^ETag:' /tmp/w3c-h | head -1 | tr -d '\r' | cut -d' ' -f2)
ck "PUT ressource → 200 (update)" 200 "$(code -X PUT -H "$H" -H 'Content-Type: application/ld+json' -H "If-Match: $etag" -d '{"app_tickets:title":"W3C-v2","app_tickets:building_id":1}' "$loc")"
ck "DELETE ressource → 204 (delete)" 204 "$(code -X DELETE -H "$H" "$loc")"
ck "GET après DELETE → 404" 404 "$(code -H "$H" "$loc")"

# --- BasicContainer : ldp:contains contient la ressource (ldp-tests container) ---
curl -s -o /tmp/w3c-body -H "$H" "$B/tickets/"
grep -q '"ldp:contains"' /tmp/w3c-body && ck "GET container → ldp:contains (BasicContainer)" ok ok || ck "ldp:contains" ok manquant

# --- Link rel="type" (ldp-tests link type) ---
curl -s -D /tmp/w3c-h -o /dev/null -H "$H" "$B/tickets/370"
grep -qi 'rel="type"' /tmp/w3c-h && ck 'Link rel="type" présent' ok ok || ck 'Link rel="type"' ok manquant

# --- ETag + 304 (ldp-tests conditional request) ---
curl -s -D /tmp/w3c-h -o /dev/null -H "$H" "$B/tickets/370"; etag=$(grep -i '^ETag:' /tmp/w3c-h | head -1 | tr -d '\r' | cut -d' ' -f2)
ck "GET If-None-Match courant → 304" 304 "$(code -H "$H" -H "If-None-Match: $etag" "$B/tickets/370")"

echo "== ldp-tests subset: $pass PASS, $fail FAIL =="
