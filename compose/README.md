# Deploying a FAP-LDP server (from scratch)

This guide starts from a **fresh machine** and ends with a running server locally (or in prod),
with **your own data model**. The `fap-ldp` repository is the *component* (cloned, unchanged);
your *deployment* (config, model, secrets) lives in a separate folder, never committed.

## Directory layout

```
~/fap-ldp/              ← component (git clone, nothing written here)
~/fap-light-serveur/    ← FAP core (git clone, next to it; or facis-fap-iot-ai as fallback)
~/my-server/            ← YOUR deployment (private, outside the repo)
├── .env                ←   config + secrets (DOMAIN, PG passwords…)
├── config/model.json   ←   YOUR data model
└── sql/                ←   (optional) custom migrations/views/seed
```

## 1. Prerequisites

- Docker + compose plugin: `sudo apt install -y docker.io docker-compose-plugin`
- **Local**: nothing else (`*.localhost` resolves to 127.0.0.1 automatically).
- **Prod**: a VM, ports 80/443 open, a domain name (A record) pointing to the VM's IP.

## 2. Clone the component and the core

```bash
git clone <fap-ldp-url> ~/fap-ldp
git clone <FAP-core-url> ~/fap-light-serveur     # next to fap-ldp
```

## 3. Create your deployment folder

```bash
mkdir -p ~/my-server/config
cp ~/fap-ldp/compose/env.local.example ~/my-server/.env
# edit ~/my-server/.env :
#   local : DOMAIN=app.localhost
#   prod  : DOMAIN=server.example.com   (A record → VM IP)
# *_PASSWORD=CHANGE_ME secrets are auto-generated on first deploy
```

## 4. Write your data model

`~/my-server/config/model.json` — the only "business" file to write (full example:
`../examples/supervision/model.json`):

```json
{
  "base_iri": "https://app.localhost/",
  "tables": {
    "products": {
      "pk": "id", "owner": "created_by", "published": true, "tombstone": "deleted_at",
      "fields": {
        "id": "bigserial",
        "name": "text not null",
        "price": "numeric",
        "created_by": "bigint fk users(id)",
        "created_at": "timestamptz", "updated_at": "timestamptz", "deleted_at": "timestamptz"
      }
    }
  }
}
```

Per table, at boot the `fap-ldp` node automatically generates: the `app.<table>` table + index +
triggers (`updated_at`, versioning, tombstone, outbox), `FORCE ROW LEVEL SECURITY` + policies via
`auth.can()`, the `dsp.asset_mapping` mapping (container `/<table>/`, published if `published: true`),
the initial ACL (the `owner` gets `control`). Custom SQL (views, seed) → `~/my-server/sql/*.sql`.

## 5. Launch

```bash
cd ~/fap-ldp/compose
make deploy DEPLOY_DIR=~/my-server ENV_FILE=~/my-server/.env
```

`deploy.sh` (idempotent): prerequisite/DNS check → secrets → ordered migrations (core → fap-ldp
base → your `sql/`) → postgres (healthy) → ORCE (boot applies `model.json`) → keycloak (embedded
realm, DPoP) → caddy (auto TLS) → HTTPS check → initial backup.

## 6. Verify and use

```bash
make test    DEPLOY_DIR=~/my-server ENV_FILE=~/my-server/.env   # healthcheck + tck (AC-S/AC-L)
curl -k https://app.localhost/products/      # LDP container of your model
# application LDP: https://$DOMAIN/     ·   core data plane: https://$DOMAIN/dsp/
```

## Common commands (from `fap-ldp/compose`)

| Command | Effect |
|---|---|
| `make deploy [DEPLOY_DIR=… ENV_FILE=…]` | deploys / updates (idempotent) |
| `make test …` | healthcheck + tck |
| `make backup …` | pg_dump + WAL now |
| `make status …` | service status + PG roles |
| `make logs` / `make down` | logs / stop (volumes kept) |
| `make update` | git pull of the component + redeploy |

By default (no variables): deployment in `compose/deploy` + `compose/.env` (gitignored).

## Quick troubleshooting

- `DNS: … does not point to …` → check the A record (prod) or `/etc/hosts` (`127.0.0.1 app.localhost`).
- `https://… does not respond` → `make logs`; check that caddy obtained the certificate (ports 80/443).
- `make deploy` re-run = safe: idempotent migrations (`CREATE … IF NOT EXISTS`), secrets persisted in `.env`.
- Changing model: edit `DEPLOY_DIR/config/model.json` then `make deploy` (replayed at boot).
