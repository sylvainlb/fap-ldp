#!/bin/sh
B=${BASE:-http://localhost:18880}
PGC=${PGC:-docker exec pg psql -U postgres -d fap -q}
A='Authorization: Bearer tok-alice'
Bo='Authorization: Bearer tok-bob'
E='Authorization: Bearer tok-ext'
pass=0; fail=0
ck() { # name expected actual
  if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "PASS $1 ($3)"; else fail=$((fail+1)); echo "FAIL $1: attendu $2, obtenu $3"; fi
}
code() { curl -s -o /tmp/body -w '%{http_code}' "$@"; }

# 1. sans token → 401
ck "GET sans token → 401" 401 "$(code $B/tickets/37)"
# 2. bob lit /tickets/37 (ACL ressource) → 200 (CA-L3)
ck "bob GET /tickets/37 → 200" 200 "$(code -H "$Bo" $B/tickets/37)"
grep -q 'T37' /tmp/body && ck "body contient T37" ok ok || ck "body contient T37" ok "manquant"
# 3. bob GET /tickets/370 → 403
ck "bob GET /tickets/370 → 403" 403 "$(code -H "$Bo" $B/tickets/370)"
# 4. alice POST /tickets/ → 201 + Location ; GET → 200 (CA-L1 read-after-write)
c=$(curl -s -D /tmp/h -o /tmp/body -w '%{http_code}' -H "$A" -H 'Content-Type: application/ld+json' -d '{"app_tickets:title":"T1001","app_tickets:building_id":1,"app_tickets:created_by":1}' $B/tickets/)
ck "alice POST /tickets/ → 201" 201 "$c"
loc=$(grep -i '^Location:' /tmp/h | tr -d '\r' | awk '{print $2}')
echo "  Location: $loc"
g=$(code -H "$A" $B/tickets/37); ck "alice GET /tickets/37 → 200" 200 "$g"
curl -s -D /tmp/h -o /dev/null -H "$A" $B/tickets/37; etag=$(grep -i "^ETag:" /tmp/h | tr -d "\r" | cut -d" " -f2); echo "  etag=$etag"; ck "GET Location → 200 (CA-L1)" 200 "$(code -H "$A" "$loc")"
# 5. ETag / If-Match → 412 si obsolète (CA-L10)
ck "PUT If-Match obsolète → 412" 412 "$(code -X PUT -H "$A" -H 'Content-Type: application/ld+json' -H 'If-Match: W/"0000"' -d '{"app_tickets:title":"T37b","app_tickets:building_id":1}' $B/tickets/37)"
ck "PUT If-Match courant → 200" 200 "$(code -X PUT -H "$A" -H 'Content-Type: application/ld+json' -H "If-Match: $etag" -d '{"app_tickets:title":"T37b","app_tickets:building_id":1}' $B/tickets/37)"
# 6. PATCH merge patch → 200
ck "PATCH /tickets/37 → 200" 200 "$(code -X PATCH -H "$A" -H 'Content-Type: application/merge-patch+json' -d '{"app_tickets:status":"IN_PROGRESS"}' $B/tickets/37)"
# 7. DELETE → 204, puis GET → 404
curl -s -D /tmp/h -o /dev/null -H "$A" $B/tickets/37; etag=$(grep -i "^ETag:" /tmp/h | tr -d "\r" | cut -d" " -f2)
ck "DELETE /tickets/37 → 204" 204 "$(code -X DELETE -H "$A" -H "If-Match: $etag" $B/tickets/37)"
ck "GET après DELETE → 404" 404 "$(code -H "$A" $B/tickets/37)"
# 8. .acl round-trip (CA-L6) sur /buildings/2.acl
ck "GET /buildings/2.acl → 200" 200 "$(code -H "$A" $B/buildings/2.acl)"

curl -s -o /tmp/acl.json -H "$A" $B/buildings/2.acl
python3 - <<'PY'
import json
d=json.load(open('/tmp/acl.json'))
d['@graph'].append({"@type":"acl:Authorization","acl:accessTo":"http://localhost:18880/buildings/2","acl:agentClass":"role:technicien","acl:mode":["acl:Read"]})
json.dump(d,open('/tmp/acl2.json','w'))
PY
ck "PUT /buildings/2.acl → 200" 200 "$(code -X PUT -H "$A" -H 'Content-Type: application/ld+json' -d @/tmp/acl2.json $B/buildings/2.acl)"
ck "GET .acl après PUT contient technicien" ok "$(curl -s -H "$A" $B/buildings/2.acl | grep -q technicien && echo ok || echo manquant)"
ck "bob GET /buildings/2 après PUT acl → 200 (CA-L6)" 200 "$(code -H "$Bo" $B/buildings/2)"
# 9. racine : conteneurs publiés uniquement
ck "GET / alice → 200" 200 "$(code -H "$A" $B/)"
grep -q 'buildings' /tmp/body && ck "racine contient /buildings/" ok ok || ck "racine contient /buildings/" ok "manquant"
grep -q 'tickets' /tmp/body && ck "racine ne contient PAS /tickets/ (non publié)" ok "présent" || ck "racine ne contient PAS /tickets/" ok ok
$PGC -c "DELETE FROM auth.acl WHERE subject='did:web:partner.example'" >/dev/null
# 10. externe : contrat mais pas d ACL → 403 (CA-L4a)
ck "ext GET /buildings/1 sans ACL → 403" 403 "$(code -H "$E" $B/buildings/1)"
# ajoute l'ACL pour le DID
$PGC -c "INSERT INTO auth.acl (resource_uri,subject,modes) VALUES ('http://localhost:18880/buildings/','did:web:partner.example','{read}')" >/dev/null
ck "ext GET /buildings/1 avec ACL → 200 (CA-L4)" 200 "$(code -H "$E" $B/buildings/1)"
ck "ext GET /buildings/2 → 403 (CA-L5 ODRL isAnyOf [1])" 403 "$(code -H "$E" $B/buildings/2)"
# 11. conteneur non publié → 403 externe (CA-L7)
ck "ext GET /tickets/37 → 403 (CA-L7)" 403 "$(code -H "$E" $B/tickets/37)"
# 12. gold via LDP (interne)
ck "alice GET /gold/city_dashboard_summary/ → 200" 200 "$(code -H "$A" $B/gold/city_dashboard_summary/)"
grep -q 'ldp:contains' /tmp/body && ck "conteneur gold avec ldp:contains" ok ok || ck "conteneur gold ldp:contains" ok "manquant"
ck "alice GET /gold/city_dashboard_summary/1 → 200" 200 "$(code -H "$A" $B/gold/city_dashboard_summary/1)"
# audit
n=$($PGC -t -c "SELECT count(*) FROM dsp.audit WHERE decision='allow' AND agreement_id='agr-1'")
[ "$n" -ge 1 ] && ck "audit agr-1 présent (CA-L4)" ok ok || ck "audit agr-1" ok "$n"
echo "== $pass PASS, $fail FAIL =="
