# ext/model-injection — E11 : injection gouvernée de modèles par package

Extension du dépôt `fap-ldp` (package installable seul) : mécanisme **back** générique permettant à
chaque package de l'app store d'injecter **son propre modèle de données** dans le serveur FAP-LDP,
de façon gouvernée (validation → quotas → accord de contribution → application atomique), sans perdre
l'interopérabilité FACIS (1 asset DSP = 1 conteneur LDP, outbox → bronze RG-3, publication explicite).

- **Spec** : `../../../spec/model-injection-spec.md` v0.3 (contrat d'injection, annexe A = JSON Schema du DSL)
- **Spec ext générique** : `../../../spec/fap-ldp-ext-specs.md` (E11, E12)
- **Version** : 0.1.0 (périmètre v1 de la spec : boot idempotent + drift ; v2 = E12 hot-reload, PATCH additif, canal contrat-signé)

## Layout

```
ext/model-injection/
├── package.json                 ← node-red-contrib-fap-ldp-model-injection (2 nœuds, dep pg)
├── sql/
│   ├── 000_model_injection.sql  ← app.app_packages + index unique de préfixe (rôle admin, AVANT le boot)
│   └── 001_mi_maintenance.sql   ← app.mi_drop_revoked_packages (purge 30 j fragment-aware, pg_cron)
├── nodes/
│   ├── lib/
│   │   ├── fragment.js          ← validation annexe A + canonicalisation (sha256) + compilateur DDL
│   │   │                          (quote_ident/quote_literal partout : aucune injection, §4.2/§4.6)
│   │   ├── installer.js         ← installPackage (1 transaction) / revokePackage / applyFragmentsAtBoot (+drift)
│   │   ├── auth.js              ← claims depuis la requête (userinfo OIDC ou devTokens TCK)
│   │   └── pgpool-lite.js       ← pool PG autonome (l'ext ne dépend pas des libs du core)
│   ├── mi-boot.js/.html         ← nœud fap-ldp-mi-boot : applique les fragments au boot + drift (CA-B7)
│   └── mi-admin.js/.html        ← nœud fap-ldp-mi-admin : endpoints HTTP (voir ci-dessous)
└── tck/
    ├── fragment.test.js         ← tests unitaires (node --test, sans PG) : 16 tests
    ├── integration-pg.js        ← test d'intégration réel (PG 16) : 12 tests, CA-B1..B8
    └── e2e-model-injection.sh   ← TCK HTTP contre stack up (CA-B1..B6, B8)
```

## Installation

1. Migrations (rôle admin, **avant** le boot ORCE) :
   ```bash
   for f in ext/model-injection/sql/00*.sql; do psql -v ON_ERROR_STOP=1 -f "$f"; done
   ```
2. Package dans ORCE : monter `ext/model-injection/` dans `~/.node-red/nodes/` (ou `npm install` dans `/data`).
3. Flow : ajouter `[fap-ldp-mi-boot]` (pg admin) et `[fap-ldp-mi-admin]` (pg admin, baseIri, idpUserinfoUrl/devTokens)
   à côté des nœuds core. Le core réserve les routes `/admin/*`, `/apps/` et `/apps/<slug>/meta` à cette ext
   (patch minime de `core/nodes/nodes/ldp-container.js`, sans changement d'API) ; les conteneurs
   `/apps/<slug>/<table>/` restent servis par le PEP core via `dsp.asset_mapping`.

## Contrat d'injection (spec §3)

| Méthode | Route | Rôle | Effet |
|---|---|---|---|
| `POST` | `/admin/apps` | `admin` | body `{slug, version, sri?, meta?, retention?, model_fragment}` → **une transaction** : validation → quotas → contrat `dsp.contracts` → DDL `app.store_<slug>_*` → `app.app_packages` + upsert `app.features` + `dsp.asset_mapping` + ACL initiales + audit → `201` + `Location: /apps/<slug>/meta`. Slug existant → `409` (v1 : pas d'upgrade) |
| `DELETE` | `/admin/apps/<slug>` | `admin` | révocation : contrat `revoked` (trigger → `pg_notify('fap_revoked')` → purge cache PDP), `asset_mapping.published=false`, `state='revoked'` + `revoked_at` → `204`. Drop des tables après purge 30 j (`001_mi_maintenance.sql`) |
| `GET` | `/apps/` | tout user authentifié | conteneurs des packages installés |
| `GET` | `/apps/<slug>/meta` | tout user authentifié | fiche (version, sri, state, contrat, tables) + ETag (`If-Match` sur DELETE) |

Erreurs JSON-LD `dspace:Error` (CA-B2) : `schema_violation`, `invalid_identifier`, `blacklisted_effect`,
`quota_exceeded`, `prefix_collision` → `422` ; `409 Conflict` ; rien n'est appliqué en cas d'erreur (transaction annulée).

## Règles de sécurité implémentées (spec §4)

- DSL déclaratif seul (annexe A) : `additionalProperties: false` à chaque niveau → aucun SQL arbitraire.
- Identifiants : `slug ~ ^[a-z][a-z0-9_]{1,30}$`, noms `^[a-z][a-z0-9_]{0,62}$`, toujours émis via `quote_ident`.
- Littéraux : `default` whitelisté (`now()/true/false`/nombre) ou émis via `quote_literal` ; `check_in` toujours en littéraux échappés (§4.6).
- Whitelist des effets : tables `app.store_<slug>_*`, index, triggers **génériques du socle**, policies RLS par défaut, une ligne `asset_mapping` sous `/apps/<slug>/`, ACL initiales. Blacklist : `app.versions/tombstones/outbox`, `auth.*`, `dsp.*` (hors mapping), schémas/triggers/policies custom.
- FK uniquement vers `app.users` ; interdites entre packages. v1 : pk doit être `id bigint serial` (triggers du socle).
- Quotas : ≤10 tables, ≤40 champs/table, ≤200 champs/package, payload ≤256 Ko + quota pod (config `maxPackages`, défaut 50).
- Concurrence : `pg_advisory_xact_lock` + index unique de préfixe + vérification des noms physiques complets (collision `slug x + y_z` vs `slug x_y + z`).

## Décisions d'implémentation (écarts documentés vs spec)

- **`state` inclut `'drift'`** dans le CHECK (spec §2 ne listait que installed/revoked, mais §5 exige l'état drift) + colonne `revoked_at` (nécessaire à la purge 30 j après révocation, §6).
- **Maintenance côté ext** (`sql/001_mi_maintenance.sql`) : l'ext ne modifie pas le core (règle ext/), donc le « 006 fragment-aware » de la spec §6 est livré ici. La purge des tombstones 30 j fonctionne déjà via le core (`app.purge_old_tombstones` itère `app.tombstones`, pk `id` imposé).
- **pk `id` bigint serial imposé en v1** : les triggers génériques du socle (`app.version_trigger` etc.) utilisent `NEW.id`.
- **Patch core minime** : réservation des routes `/admin/*`, `/apps/`, `/apps/<slug>/meta` dans `ldp-container.js` (même mécanisme que les réservations existantes `/dsp/`, `/app/`) — aucune API modifiée.
- **Canonical drift** : comparaison structurelle (tables/colonnes/type/serial/not_null) via `information_schema`, `serial` normalisé `not_null` ; hash sha256 du fragment canonique (`fragment_hash`) comparé au boot (CA-B7).
- **v1 : le « package » ingéré = métadonnées + manifeste + fragment** (pas de binaire) ; `sri` = hash du manifeste. Binaire + vérification SHA-384 en v2 (app-store-spec Partie 2).
- **Canal admin v1** : rôle `admin` seul (userinfo OIDC/devTokens) ; chemin contrat-signé avec `dsp.capacities` en v2 (spec §3.2).

## TCK

```bash
node --test ext/model-injection/tck/fragment.test.js          # 16 tests unitaires, sans PG
PG_ADMIN_DSN=postgres://admin:***@localhost:5432/fap \
  node ext/model-injection/tck/integration-pg.js              # 12 tests d'intégration PG 16 (CA-B1..B8)
BASE=http://localhost:18880 TOK_ADMIN=tok-admin \
  sh ext/model-injection/tck/e2e-model-injection.sh           # TCK HTTP contre stack up
```

Validé sur `postgres:16` (stack de dev) : 16/16 unitaires, 12/12 intégration (install, 409, 422+rollback,
collision de préfixe, coexistence, outbox/versioning, RLS owner vs autre webid vs foaf:Agent publié,
boot idempotent, drift → état `drift` + alarme + retour, révocation, purge fragment-aware).
