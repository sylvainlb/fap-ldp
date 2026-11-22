#!/usr/bin/env bash
# deploy.sh — FAP-light + FAP-LDP deployment (light profile). Idempotent: safe to re-run.
# Single entry point: make deploy  (or ./deploy.sh)
#
# The DEPLOYMENT (config, model, secrets) lives OUTSIDE the repo, in DEPLOY_DIR:
#   ENV_FILE=~/my-server/.env DEPLOY_DIR=~/my-server make deploy
# (default: compose/.env and compose/deploy, gitignored)
#
# Prerequisites: docker + compose; DOMAIN pointing to this machine
#   - prod: A record to the IP (ports 80/443 open, caddy does the TLS)
#   - local: DOMAIN=app.localhost (resolved to 127.0.0.1)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"                        # fap-ldp repo (component, unchanged)
CORE_DIR="${CORE_DIR:-$ROOT/../fap-light-serveur}"    # FAP core, next to the repo
[ -d "$CORE_DIR" ] || CORE_DIR="$ROOT/../facis-fap-iot-ai"
DEPLOY_DIR="${DEPLOY_DIR:-$HERE/deploy}"              # deployment folder (outside the repo recommended)
ENV_FILE="${ENV_FILE:-$HERE/.env}"                    # secrets + DOMAIN

log() { echo "[deploy] $*"; }
die() { echo "[deploy] ERROR: $*" >&2; exit 1; }

# --- 0. Prerequisites ---------------------------------------------------------
command -v docker >/dev/null || die "docker required"
docker compose version >/dev/null 2>&1 || die "docker compose required"
[ -f "$ENV_FILE" ] || die "ENV_FILE=$ENV_FILE missing — copy compose/env.local.example and edit DOMAIN"
set -a; . "$ENV_FILE"; set +a
DOMAIN="${DOMAIN:?DOMAIN missing in $ENV_FILE}"

# compose reads env vars from ENV_FILE
dc() { docker compose --env-file "$ENV_FILE" "$@"; }

# DNS: prod = domain to the IP; local = *.localhost resolved to 127.0.0.1
resolved="$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1)"
if [[ "$DOMAIN" == *.localhost ]]; then
  [ "$resolved" = "127.0.0.1" ] || die "local: $DOMAIN must resolve to 127.0.0.1 (otherwise: '127.0.0.1 $DOMAIN' in /etc/hosts)"
else
  IP="$(hostname -I | awk '{print $1}')"
  [ "$resolved" = "$IP" ] || die "DNS: $DOMAIN resolves to ${resolved:-nothing}, expected $IP"
fi

# default secrets (auto-generated once in ENV_FILE, never committed)
for s in PG_GATE_PASSWORD PG_APP_PASSWORD PG_READER_PASSWORD PG_MATERIALIZER_PASSWORD KEYCLOAK_ADMIN_PASSWORD; do
  if ! grep -q "^$s=" "$ENV_FILE" || grep -q "^$s=CHANGE_ME" "$ENV_FILE"; then
    echo "$s=$(openssl rand -hex 24)" >> "$ENV_FILE"
  fi
done
set -a; . "$ENV_FILE"; set +a

# --- 1. Migrations in order: FAP core → fap-ldp base → custom sql -------
INITDB="$HERE/initdb"
rm -rf "$INITDB"; mkdir -p "$INITDB"; i=0
for f in "$CORE_DIR"/core/sql/0*.sql "$ROOT"/core/sql/0*.sql; do
  [ -e "$f" ] && cp "$f" "$INITDB/$(printf '%02d' $i)_$(basename "$f")" && i=$((i+1))
done
if [ -d "$DEPLOY_DIR/sql" ]; then
  for f in "$DEPLOY_DIR"/sql/*.sql; do [ -e "$f" ] && cp "$f" "$INITDB/$(printf '%02d' $i)_custom_$(basename "$f")" && i=$((i+1)); done
fi
log "migrations: $(ls "$INITDB" | wc -l) files (core → fap-ldp → custom) · deployment: $DEPLOY_DIR"

# --- 2. Postgres (healthy), idempotent migrations if volume pre-exists ----
cd "$HERE"
dc up -d postgres
until dc exec -T postgres pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
dc exec -T postgres psql -U postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='app'" | grep -q 1 \
  || for f in "$INITDB"/*.sql; do dc exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 -f "/docker-entrypoint-initdb.d/$(basename "$f")" >/dev/null; done
log "PG roles: $(dc exec -T postgres psql -U postgres -tAc "SELECT string_agg(rolname, ', ' ORDER BY rolname) FROM pg_roles WHERE rolname IN ('gate','app','reader','materializer','admin')")"

# --- 2b. Keycloak realm rendered (${DOMAIN}, ${FAP_ORG}) + flows.json assembled -------
FAP_ORG="${FAP_ORG:-fap-pod}"
export FAP_ORG
REALM_SRC="$HERE/keycloak/realm.json"
REALM_OUT="${KEYCLOAK_REALM_FILE:-$DEPLOY_DIR/keycloak/realm.json}"
if grep -qE '\$\{(DOMAIN|FAP_ORG)' "$REALM_SRC" || [ "$REALM_OUT" != "$REALM_SRC" ]; then
  mkdir -p "$(dirname "$REALM_OUT")"
  DOMAIN="$DOMAIN" FAP_ORG="$FAP_ORG" envsubst '${DOMAIN} ${FAP_ORG}' < "$REALM_SRC" > "$REALM_OUT"
  export KEYCLOAK_REALM_FILE="$REALM_OUT"
  log "Keycloak realm rendered: $REALM_OUT (DOMAIN=$DOMAIN, FAP_ORG=$FAP_ORG)"
fi
FLOWS_DIR="${FLOWS_DIR:-$DEPLOY_DIR/flows}"
if [ ! -f "$FLOWS_DIR/flows.json" ]; then
  mkdir -p "$FLOWS_DIR"
  CORE_FLOWS="$CORE_DIR/deploy/orce/data/flows.json"
  python3 - "$CORE_FLOWS" "$HERE/flows/fap-ldp.json" "$FLOWS_DIR/flows.json" <<'PYEOF'
import json, sys
core = json.load(open(sys.argv[1])) if sys.argv[1] != '-' and __import__('os').path.exists(sys.argv[1]) else []
frag = json.load(open(sys.argv[2]))
json.dump(core + frag, open(sys.argv[3], 'w'), indent=1, ensure_ascii=False)
PYEOF
  log "flows.json assembled: $FLOWS_DIR/flows.json (core + fap-ldp)"
fi
export FLOWS_DIR

# --- 3. ORCE: at boot the fap-ldp node applies DEPLOY_DIR/config/model.json ----
mkdir -p "$DEPLOY_DIR/config"
[ -f "$DEPLOY_DIR/config/model.json" ] || { log "no model.json in $DEPLOY_DIR/config — copying the supervision example"; cp "$ROOT/examples/supervision/model.json" "$DEPLOY_DIR/config/model.json"; }
dc up -d orce keycloak caddy
for i in $(seq 1 30); do
  dc logs orce 2>/dev/null | grep -q "fap-ldp: model applied" && break
  sleep 2
done
log "model applied: $DEPLOY_DIR/config/model.json"

# --- 4. Checks + initial backup ---------------------------------------
curl -skf "https://$DOMAIN/" -o /dev/null || die "https://$DOMAIN/ does not respond"
[ -x "$HERE/healthcheck.sh" ] && bash "$HERE/healthcheck.sh" || log "WARN: healthcheck.sh missing/failed"
[ -x "$HERE/backup.sh" ] && bash "$HERE/backup.sh" initial || true

log "OK — https://$DOMAIN/ (LDP) · https://$DOMAIN/dsp/ (core data plane) · model: $DEPLOY_DIR/config/model.json"
log "next: edit the model in $DEPLOY_DIR/config/model.json, then make deploy (idempotent) · make test (tck)"
