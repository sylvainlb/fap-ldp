# examples/ — Business models delivered as examples

The core (`core/`) contains **no business model**: only the generic tables/functions
(`app.versions`, `app.tombstones`, `app.outbox`, triggers) are in `core/sql/004_app_socle.sql`.

A deployment declares its own model in `config/model.json` (see `supervision/model.json`);
at boot, the `fap-ldp` node:
1. creates the `app.<table>` tables + index + `updated_at`/`deleted_at` + triggers (versioning, tombstone, outbox);
2. sets `FORCE ROW LEVEL SECURITY` + policies via `auth.can()`;
3. records the mapping in `dsp.asset_mapping` (container `/<table>/`, published if `published: true`);
4. creates the initial ACL (owner = `control` on its resources).

## supervision/

"Energy supervision" example (spec `supervision-energetique-spec-fonctionnelle.md`):
`model.json` (declaration) + `004_app.sql` / `005_rls.sql` (equivalent DDL/RLS, validated on
Postgres 16 — useful for review or for a deployment that prefers explicit SQL mounted
in `sql/`).
