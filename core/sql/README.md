# core/sql — FAP-LDP migrations (E1 + E3)

Apply in order, as superuser (`postgres`), on the Postgres of the deployment
(the migrations create the extension's schemas/roles without touching the FAP core):

```bash
for f in core/sql/00*.sql; do psql -v ON_ERROR_STOP=1 -f "$f"; done
```

| File | Contents |
|---|---|
| `001_roles_schemas.sql` | Schemas `app`/`auth`/`dsp`, roles `gate`/`app`/`materializer`/`reader`/`admin`, `REVOKE ALL FROM PUBLIC`, grants per role (least privilege) |
| `002_auth.sql` | `auth.acl`, `auth.can(res, mode)`, trigger `pg_notify('fap_revoked')` on ACL change |
| `003_dsp.sql` | `dsp.contracts`, `dsp.capacities`, `dsp.audit`, `dsp.asset_mapping`, contract revocation trigger |
| `004_app_socle.sql` | Generic base: `app.versions`, `app.tombstones`, `app.outbox` + generic triggers. **No business model** — the `app.<table>` tables are created at boot by the node from the deployment's `config/model.json` (examples: `examples/`) |
| `005_rls.sql` | Generic RLS conventions (the PEP sets `app.base_iri`/`app.webid`/`app.role`); per-table policies are created at boot by the node (example: `examples/supervision/005_rls.sql`) |
| `006_maintenance.sql` | GDPR purge (30-day retention, weekly pg_cron) — `SECURITY DEFINER` |
| `007_seed_asset_mapping.sql` | Mapping of core containers `/gold/<table>/` (published=false by default; publication declared on the core catalog side) |

Business models (tables `app.<table>`, triggers, RLS policies) are NOT in `core/`:
see `examples/` (e.g. `examples/supervision/`: `model.json` + equivalent SQL).

## Conventions set by the PEP (role `app`)

In each transaction, before any query:

```sql
SET LOCAL app.base_iri = 'https://<pod>/';   -- trailing slash tolerated (rtrim in the policies)
SET LOCAL app.webid    = '<webid from the token>';
SET LOCAL app.role     = '<role from the token>';
```

Missing claim → `current_setting(..., true)` = NULL → `auth.can` = false → silent deny.

## Recorded design decisions (validated on Postgres 16)

- **ACL inheritance**: `inherited` applies only to containers (trailing slash), via
  `starts_with` — an ACL on `/tickets/37` does not cover `/tickets/370`.
- **RLS = pure authorization**: the `deleted_at IS NULL` filter is NOT in the policies
  (PostgreSQL requires on UPDATE that the new row also satisfies the USING of the SELECT
  policies — this would block soft delete). Tombstone filtering is done by the PEP
  (`WHERE deleted_at IS NULL`).
- **LDP DELETE = soft delete**: a single `UPDATE ... SET deleted_at = now()`; the
  `tombstone_trigger` trigger records `app.tombstones`. Physical purge in `006` (30 days).
- **Revocation**: DELETE/UPDATE on `dsp.contracts` or `auth.acl` → `pg_notify('fap_revoked')`
  → the PDP purges its decision cache (AC-L9, < 1 s).
- **RG-3**: `app.*` write → outbox trigger + `pg_notify('fap_ingest')` → ORCE flow → bronze.
  No direct writes from the app into bronze/silver/gold.

## Validation

Migrations + smoke test (auth.can, inheritance, RLS, versioning, outbox, tombstone, purge)
executed on `postgres:16-alpine` (throwaway container): 0 errors, all expected behaviors observed.
