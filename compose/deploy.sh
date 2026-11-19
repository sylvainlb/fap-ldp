#!/usr/bin/env bash
# deploy.sh — Déploiement FAP-light + FAP-LDP (profil light, 1 VM ou local). Idempotent : safe à relancer.
# Point d'entrée unique : make deploy  (ou ./deploy.sh directement)
# Prérequis : docker + compose ; DOMAIN dans compose/.env pointé sur cette machine
#   - prod : A record vers l'IP publique (ports 80/443 ouverts, caddy fait le TLS)
#   - local : DOMAIN=app.localhost (résolu en 127.0.0.1 automatiquement)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"                 # dépôt fap-ldp
CORE_DIR="${CORE_DIR:-$ROOT/../fap-light-serveur}"   # dépôt cœur FAP (fallback: facis-fap-iot-ai)
[ -d "$CORE_DIR" ] || CORE_DIR="$ROOT/../facis-fap-iot-ai"
DEPLOY_DIR="${DEPLOY_DIR:-$HERE/deploy}"       # dossier de déploiement (config/, sql/ custom)
ENV_FILE="$HERE/.env"

log() { echo "[deploy] $*"; }
die() { echo "[deploy] ERREUR: $*" >&2; exit 1; }

# --- 0. Prérequis ------------------------------------------------------------
command -v docker >/dev/null || die "docker requis"
docker compose version >/dev/null 2>&1 || die "docker compose requis"
[ -f "$ENV_FILE" ] || cp "$HERE/env.example" "$ENV_FILE" 2>/dev/null || cp "$HERE/.env.example" "$ENV_FILE" 2>/dev/null || true
[ -f "$ENV_FILE" ] || die "copiez compose/env.local.example (local) ou compose/.env.example (prod) en compose/.env"
set -a; . "$ENV_FILE"; set +a
DOMAIN="${DOMAIN:?DOMAIN manquant dans .env}"

# DNS : prod = domaine vers l'IP de la machine ; local = *.localhost résolu en 127.0.0.1
resolved="$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1)"
if [[ "$DOMAIN" == *.localhost ]]; then
  [ "$resolved" = "127.0.0.1" ] || die "local: $DOMAIN doit résoudre en 127.0.0.1 (résolution *.localhost automatique, sinon ajoutez '127.0.0.1 $DOMAIN' à /etc/hosts)"
else
  IP="$(hostname -I | awk '{print $1}')"
  [ "$resolved" = "$IP" ] || die "DNS: $DOMAIN résout en ${resolved:-rien}, attendu $IP"
fi

# secrets par défaut (auto-générés une fois, persistés dans .env, jamais commités)
for s in PG_GATE_PASSWORD PG_APP_PASSWORD PG_READER_PASSWORD PG_MATERIALIZER_PASSWORD KEYCLOAK_ADMIN_PASSWORD; do
  if ! grep -q "^$s=" "$ENV_FILE" || grep -q "^$s=CHANGE_ME" "$ENV_FILE"; then
    echo "$s=$(openssl rand -hex 24)" >> "$ENV_FILE"
  fi
done
set -a; . "$ENV_FILE"; set +a

# --- 1. Migrations dans l'ordre : cœur FAP → socle fap-ldp → sql custom -------
INITDB="$HERE/initdb"
rm -rf "$INITDB"; mkdir -p "$INITDB"; i=0
for f in "$CORE_DIR"/core/sql/0*.sql "$ROOT"/core/sql/0*.sql; do
  [ -e "$f" ] && cp "$f" "$INITDB/$(printf '%02d' $i)_$(basename "$f")" && i=$((i+1))
done
if [ -d "$DEPLOY_DIR/sql" ]; then
  for f in "$DEPLOY_DIR"/sql/*.sql; do [ -e "$f" ] && cp "$f" "$INITDB/$(printf '%02d' $i)_custom_$(basename "$f")" && i=$((i+1)); done
fi
log "migrations préparées: $(ls "$INITDB" | wc -l) fichiers (cœur → fap-ldp → custom)"

# --- 2. Postgres (healthy), migrations idempotentes si volume pré-existant ----
cd "$HERE"
docker compose up -d postgres
until docker compose exec -T postgres pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
docker compose exec -T postgres psql -U postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='app'" | grep -q 1 \
  || for f in "$INITDB"/*.sql; do docker compose exec -T postgres psql -U postgres -v ON_ERROR_STOP=1 -f "/docker-entrypoint-initdb.d/$(basename "$f")" >/dev/null; done
log "rôles PG: $(docker compose exec -T postgres psql -U postgres -tAc "SELECT string_agg(rolname, ', ' ORDER BY rolname) FROM pg_roles WHERE rolname IN ('gate','app','reader','materializer','admin')")"

# --- 3. ORCE : au boot le nœud fap-ldp applique config/model.json -------------
mkdir -p "$DEPLOY_DIR/config"
[ -f "$DEPLOY_DIR/config/model.json" ] || cp "$ROOT/examples/supervision/model.json" "$DEPLOY_DIR/config/model.json"
docker compose up -d orce keycloak caddy
for i in $(seq 1 30); do
  docker compose logs orce 2>/dev/null | grep -q "fap-ldp: model applied" && break
  sleep 2
done
log "modèle appliqué: $DEPLOY_DIR/config/model.json"

# --- 4. Vérifications + backup initial ---------------------------------------
scheme=https; [[ "$DOMAIN" == *.localhost ]] && scheme=https   # caddy TLS local aussi
curl -skf "$scheme://$DOMAIN/" -o /dev/null || die "https://$DOMAIN/ ne répond pas"
[ -x "$HERE/healthcheck.sh" ] && bash "$HERE/healthcheck.sh" || log "WARN: healthcheck.sh absent ou échoué"
[ -x "$HERE/backup.sh" ] && bash "$HERE/backup.sh" initial || true

log "OK — déployé: https://$DOMAIN/ (LDP) · https://$DOMAIN/dsp/ (data plane cœur)"
log "suite: éditer $DEPLOY_DIR/config/model.json (votre modèle) · make test (tck) · make backup"
