# examples/ — Modèles métier livrés à titre d'exemple

Le cœur (`core/`) ne contient **aucun modèle métier** : seules les tables/fonctions génériques
(`app.versions`, `app.tombstones`, `app.outbox`, triggers) sont dans `core/sql/004_app_socle.sql`.

Un déploiement déclare son propre modèle dans `config/model.json` (voir `supervision/model.json`) ;
au boot, le nœud `fap-ldp` :
1. crée les tables `app.<table>` + index + `updated_at`/`deleted_at` + triggers (versioning, tombstone, outbox) ;
2. pose `FORCE ROW LEVEL SECURITY` + policies via `auth.can()` ;
3. enregistre le mapping dans `dsp.asset_mapping` (conteneur `/<table>/`, publié si `published: true`) ;
4. crée l'ACL initiale (owner = `control` sur ses ressources).

## supervision/

Exemple « supervision énergétique » (spec `supervision-energetique-spec-fonctionnelle.md`) :
`model.json` (déclaration) + `004_app.sql` / `005_rls.sql` (DDL/RLS équivalents, validés sur
Postgres 16 — utiles pour review ou pour un déploiement qui préfère du SQL explicite monté
dans `sql/`).
