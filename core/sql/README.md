# core/sql — Migrations FAP-LDP (E1 + E3)

Appliquer dans l'ordre, en superuser (`postgres`), sur le Postgres du déploiement
(les migrations créent les schémas/rôles de l'extension sans toucher au cœur FAP) :

```bash
for f in core/sql/00*.sql; do psql -v ON_ERROR_STOP=1 -f "$f"; done
```

| Fichier | Contenu |
|---|---|
| `001_roles_schemas.sql` | Schémas `app`/`auth`/`dsp`, rôles `gate`/`app`/`materializer`/`reader`/`admin`, `REVOKE ALL FROM PUBLIC`, grants par rôle (moindre privilège) |
| `002_auth.sql` | `auth.acl`, `auth.can(res, mode)`, trigger `pg_notify('fap_revoked')` sur changement d'ACL |
| `003_dsp.sql` | `dsp.contracts`, `dsp.capacities`, `dsp.audit`, `dsp.asset_mapping`, trigger révocation contrat |
| `004_app_socle.sql` | Socle générique : `app.versions`, `app.tombstones`, `app.outbox` + triggers génériques. **Aucun modèle métier** — les tables `app.<table>` sont créées au boot par le nœud depuis `config/model.json` du déploiement (exemples : `examples/`) |
| `005_rls.sql` | Conventions RLS génériques (le PEP pose `app.base_iri`/`app.webid`/`app.role`) ; les policies par table sont créées au boot par le nœud (exemple : `examples/supervision/005_rls.sql`) |
| `006_maintenance.sql` | Purge RGPD (rétention 30 j, pg_cron hebdo) — `SECURITY DEFINER` |
| `007_seed_asset_mapping.sql` | Mapping conteneurs `/gold/<table>/` du cœur (publié=false par défaut ; publication déclarée côté catalogue cœur) |

Les modèles métier (tables `app.<table>`, triggers, policies RLS) ne sont PAS dans `core/` :
voir `examples/` (ex. `examples/supervision/` : `model.json` + SQL équivalents).

## Conventions posées par le PEP (rôle `app`)

Dans chaque transaction, avant toute requête :

```sql
SET LOCAL app.base_iri = 'https://<pod>/';   -- slash final toléré (rtrim dans les policies)
SET LOCAL app.webid    = '<webid du token>';
SET LOCAL app.role     = '<role du token>';
```

Claim absent → `current_setting(..., true)` = NULL → `auth.can` = false → deny silencieux.

## Points de conception actés (validés sur Postgres 16)

- **Héritage ACL** : `inherited` ne s'applique qu'aux conteneurs (slash final), via
  `starts_with` — une ACL sur `/tickets/37` ne couvre pas `/tickets/370`.
- **RLS = autorisation pure** : le filtre `deleted_at IS NULL` n'est PAS dans les policies
  (PostgreSQL exige sur UPDATE que la nouvelle ligne satisfasse aussi le USING des policies
  SELECT — cela bloquerait le soft delete). Le filtrage des tombstones est fait par le PEP
  (`WHERE deleted_at IS NULL`).
- **DELETE LDP = soft delete** : un unique `UPDATE ... SET deleted_at = now()` ; le trigger
  `tombstone_trigger` enregistre `app.tombstones`. Purge physique en `006` (30 j).
- **Révocation** : DELETE/UPDATE sur `dsp.contracts` ou `auth.acl` → `pg_notify('fap_revoked')`
  → le PDP purge son cache de décision (CA-L9, < 1 s).
- **RG-3** : écriture `app.*` → trigger outbox + `pg_notify('fap_ingest')` → flow ORCE → bronze.
  Aucune écriture directe de l'app dans bronze/silver/gold.

## Validation

Migrations + smoke test (auth.can, héritage, RLS, versioning, outbox, tombstone, purge)
exécutés sur `postgres:16-alpine` (conteneur jetable) : 0 erreur, tous les comportements
attendus constatés.
