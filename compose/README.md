# Déployer un serveur FAP-LDP (from scratch)

Ce guide part d'une **machine neuve** et aboutit à un serveur tournant en local (ou en prod),
avec **votre propre modèle de données**. Le dépôt `fap-ldp` est le *composant* (cloné, inchangé) ;
votre *déploiement* (config, modèle, secrets) vit dans un dossier à part, jamais commité.

## Arborescence

```
~/fap-ldp/              ← composant (git clone, on n'y écrit rien)
~/fap-light-serveur/    ← cœur FAP (git clone, à côté ; ou facis-fap-iot-ai en fallback)
~/mon-serveur/          ← VOTRE déploiement (privé, hors dépôt)
├── .env                ←   config + secrets (DOMAIN, mots de passe PG…)
├── config/model.json   ←   VOTRE modèle de données
└── sql/                ←   (optionnel) migrations/vues/seed custom
```

## 1. Prérequis

- Docker + plugin compose : `sudo apt install -y docker.io docker-compose-plugin`
- **Local** : rien d'autre (`*.localhost` résout en 127.0.0.1 automatiquement).
- **Prod** : une VM, ports 80/443 ouverts, un nom de domaine (A record) pointé sur l'IP de la VM.

## 2. Cloner le composant et le cœur

```bash
git clone <url-fap-ldp> ~/fap-ldp
git clone <url-cœur-FAP> ~/fap-light-serveur     # à côté de fap-ldp
```

## 3. Créer votre dossier de déploiement

```bash
mkdir -p ~/mon-serveur/config
cp ~/fap-ldp/compose/env.local.example ~/mon-serveur/.env
# éditer ~/mon-serveur/.env :
#   local : DOMAIN=app.localhost
#   prod  : DOMAIN=serveur.example.fr   (A record → IP de la VM)
# les secrets *_PASSWORD=CHANGE_ME sont auto-générés au premier deploy
```

## 4. Écrire votre modèle de données

`~/mon-serveur/config/model.json` — seul fichier "métier" à écrire (exemple complet :
`../examples/supervision/model.json`) :

```json
{
  "base_iri": "https://app.localhost/",
  "tables": {
    "produits": {
      "pk": "id", "owner": "created_by", "published": true, "tombstone": "deleted_at",
      "fields": {
        "id": "bigserial",
        "nom": "text not null",
        "prix": "numeric",
        "created_by": "bigint fk users(id)",
        "created_at": "timestamptz", "updated_at": "timestamptz", "deleted_at": "timestamptz"
      }
    }
  }
}
```

Par table, au boot le nœud `fap-ldp` génère automatiquement : la table `app.<table>` + index +
triggers (`updated_at`, versioning, tombstone, outbox), `FORCE ROW LEVEL SECURITY` + policies via
`auth.can()`, le mapping `dsp.asset_mapping` (conteneur `/<table>/`, publié si `published: true`),
l'ACL initiale (le `owner` a `control`). SQL custom (vues, seed) → `~/mon-serveur/sql/*.sql`.

## 5. Lancer

```bash
cd ~/fap-ldp/compose
make deploy DEPLOY_DIR=~/mon-serveur ENV_FILE=~/mon-serveur/.env
```

`deploy.sh` (idempotent) : check prérequis/DNS → secrets → migrations ordonnées (cœur → socle
fap-ldp → votre `sql/`) → postgres (healthy) → ORCE (boot applique `model.json`) → keycloak (realm
embarqué, DPoP) → caddy (TLS auto) → vérif HTTPS → backup initial.

## 6. Vérifier et utiliser

```bash
make test    DEPLOY_DIR=~/mon-serveur ENV_FILE=~/mon-serveur/.env   # healthcheck + tck (CA-S/CA-L)
curl -k https://app.localhost/produits/      # conteneur LDP de votre modèle
# LDP applicatif : https://$DOMAIN/     ·   data plane cœur : https://$DOMAIN/dsp/
```

## Commandes usuelles (depuis `fap-ldp/compose`)

| Commande | Effet |
|---|---|
| `make deploy [DEPLOY_DIR=… ENV_FILE=…]` | déploie / met à jour (idempotent) |
| `make test …` | healthcheck + tck |
| `make backup …` | pg_dump + WAL maintenant |
| `make status …` | état des services + rôles PG |
| `make logs` / `make down` | logs / arrêt (volumes conservés) |
| `make update` | git pull du composant + redeploy |

Par défaut (sans variables) : déploiement dans `compose/deploy` + `compose/.env` (gitignorés).

## Dépannage rapide

- `DNS: … ne pointe pas sur …` → vérifier le A record (prod) ou `/etc/hosts` (`127.0.0.1 app.localhost`).
- `https://… ne répond pas` → `make logs` ; vérifier que caddy a obtenu le certificat (ports 80/443).
- `make deploy` relancé = sûr : migrations idempotentes (`CREATE … IF NOT EXISTS`), secrets persistés dans `.env`.
- Changer de modèle : éditer `DEPLOY_DIR/config/model.json` puis `make deploy` (rejoué au boot).
