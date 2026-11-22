CORE_DIR ?= ../fap-light-serveur
# Deployment folder (config/, custom sql/, .env) — OUTSIDE the repo recommended:
#   make deploy DEPLOY_DIR=~/my-server ENV_FILE=~/my-server/.env
DEPLOY_DIR ?= $(CURDIR)/deploy
ENV_FILE ?= $(DEPLOY_DIR)/.env

export CORE_DIR DEPLOY_DIR ENV_FILE

.PHONY: deploy test backup logs down update status

deploy:   ## full idempotent deployment (FAP-light + FAP-LDP)
	./deploy.sh

test:     ## healthcheck + tck (AC-S/AC-L)
	./healthcheck.sh

backup:   ## pg_dump + WAL backup now
	./backup.sh manual

logs:     ## logs of all services
	docker compose logs -f

down:     ## stop (volumes kept)
	docker compose down

update:   ## git pull core + extension, then idempotent redeploy
	git -C .. pull --ff-only
	$(MAKE) deploy

status:   ## service status + PG roles
	docker compose ps
	docker compose exec -T postgres psql -U postgres -tAc \
	  "SELECT rolname FROM pg_roles WHERE rolname IN ('gate','app','reader','materializer','admin') ORDER BY 1"
