CORE_DIR ?= ../fap-light-serveur
# Dossier de déploiement (config/, sql/ custom, .env) — HORS du dépôt recommandé :
#   make deploy DEPLOY_DIR=~/mon-serveur ENV_FILE=~/mon-serveur/.env
DEPLOY_DIR ?= $(CURDIR)/deploy
ENV_FILE ?= $(DEPLOY_DIR)/.env

export CORE_DIR DEPLOY_DIR ENV_FILE

.PHONY: deploy test backup logs down update status

deploy:   ## déploiement idempotent complet (FAP-light + FAP-LDP)
	./deploy.sh

test:     ## healthcheck + tck (CA-S/CA-L)
	./healthcheck.sh

backup:   ## backup pg_dump + WAL maintenant
	./backup.sh manual

logs:     ## logs de tous les services
	docker compose logs -f

down:     ## arrêt (volumes conservés)
	docker compose down

update:   ## git pull cœur + extension, puis redeploy idempotent
	git -C .. pull --ff-only
	$(MAKE) deploy

status:   ## état des services + rôles PG
	docker compose ps
	docker compose exec -T postgres psql -U postgres -tAc \
	  "SELECT rolname FROM pg_roles WHERE rolname IN ('gate','app','reader','materializer','admin') ORDER BY 1"
