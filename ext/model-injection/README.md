# ext/model-injection — E11: governed model injection by package

Extension of the `fap-ldp` repository (standalone installable package): a generic **back** mechanism allowing
each app-store package to inject **its own data model** into the FAP-LDP server,
in a governed way (validation → quotas → contribution agreement → atomic application), without losing
FACIS interoperability (1 DSP asset = 1 LDP container, outbox → bronze RG-3, explicit publication).

- **Spec**: `../../../spec/model-injection-spec.md` v0.3 (injection contract, annex A = JSON Schema of the DSL)
- **Generic ext spec**: `../../../spec/fap-ldp-ext-specs.md` (E11, E12)
- **Version**: 0.1.0 (v1 scope of the spec: idempotent boot + drift; v2 = E12 hot-reload, additive PATCH, signed-contract channel)

## Layout

```
ext/model-injection/
├── package.json                 ← node-red-contrib-fap-ldp-model-injection (2 nodes, dep pg)
├── sql/
│   ├── 000_model_injection.sql  ← app.app_packages + unique prefix index (admin role, BEFORE boot)
│   └── 001_mi_maintenance.sql   ← app.mi_drop_revoked_packages (30-day fragment-aware purge, pg_cron)
├── nodes/
│   ├── lib/
│   │   ├── fragment.js          ← annex A validation + canonicalization (sha256) + DDL compiler
│   │   │                          (quote_ident/quote_literal everywhere: no injection, §4.2/§4.6)
│   │   ├── installer.js         ← installPackage (1 transaction) / revokePackage / applyFragmentsAtBoot (+drift)
│   │   ├── auth.js              ← claims from the request (OIDC userinfo or TCK devTokens)
│   │   └── pgpool-lite.js       ← standalone PG pool (the ext does not depend on the core libs)
│   ├── mi-boot.js/.html         ← node fap-ldp-mi-boot: applies fragments at boot + drift (AC-B7)
│   └── mi-admin.js/.html        ← node fap-ldp-mi-admin: HTTP endpoints (see below)
└── tck/
    ├── fragment.test.js         ← unit tests (node --test, no PG): 16 tests
    ├── integration-pg.js        ← real integration test (PG 16): 12 tests, AC-B1..B8
    └── e2e-model-injection.sh   ← HTTP TCK against a running stack (AC-B1..B6, B8)
```

## Installation

1. Migrations (admin role, **before** ORCE boot):
   ```bash
   for f in ext/model-injection/sql/00*.sql; do psql -v ON_ERROR_STOP=1 -f "$f"; done
   ```
2. Package in ORCE: mount `ext/model-injection/` in `~/.node-red/nodes/` (or `npm install` in `/data`).
3. Flow: add `[fap-ldp-mi-boot]` (pg admin) and `[fap-ldp-mi-admin]` (pg admin, baseIri, idpUserinfoUrl/devTokens)
   next to the core nodes. The core reserves the routes `/admin/*`, `/apps/` and `/apps/<slug>/meta` for this ext
   (minimal patch of `core/nodes/nodes/ldp-container.js`, no API change); the containers
   `/apps/<slug>/<table>/` remain served by the core PEP via `dsp.asset_mapping`.

## Injection contract (spec §3)

| Method | Route | Role | Effect |
|---|---|---|---|
| `POST` | `/admin/apps` | `admin` | body `{slug, version, sri?, meta?, retention?, model_fragment}` → **one transaction**: validation → quotas → `dsp.contracts` contract → DDL `app.store_<slug>_*` → `app.app_packages` + upsert `app.features` + `dsp.asset_mapping` + initial ACLs + audit → `201` + `Location: /apps/<slug>/meta`. Existing slug → `409` (v1: no upgrade) |
| `DELETE` | `/admin/apps/<slug>` | `admin` | revocation: `revoked` contract (trigger → `pg_notify('fap_revoked')` → PDP cache purge), `asset_mapping.published=false`, `state='revoked'` + `revoked_at` → `204`. Table drop after 30-day purge (`001_mi_maintenance.sql`) |
| `GET` | `/apps/` | any authenticated user | containers of installed packages |
| `GET` | `/apps/<slug>/meta` | any authenticated user | record (version, sri, state, contract, tables) + ETag (`If-Match` on DELETE) |

JSON-LD errors `dspace:Error` (AC-B2): `schema_violation`, `invalid_identifier`, `blacklisted_effect`,
`quota_exceeded`, `prefix_collision` → `422`; `409 Conflict`; nothing is applied on error
(transaction rolled back).

## Implemented security rules (spec §4)

- Declarative DSL only (annex A): `additionalProperties: false` at every level → no arbitrary SQL.
- Identifiers: `slug ~ ^[a-z][a-z0-9_]{1,30}$`, names `^[a-z][a-z0-9_]{0,62}$`, always emitted via `quote_ident`.
- Literals: `default` whitelisted (`now()/true/false`/number) or emitted via `quote_literal`; `check_in` always in escaped literals (§4.6).
- Effect whitelist: tables `app.store_<slug>_*`, index, **generic base** triggers, default RLS policies, one `asset_mapping` row under `/apps/<slug>/`, initial ACLs. Blacklist: `app.versions/tombstones/outbox`, `auth.*`, `dsp.*` (except mapping), custom schemas/triggers/policies.
- FK only towards `app.users`; forbidden between packages. v1: pk must be `id bigint serial` (base triggers).
- Quotas: ≤10 tables, ≤40 fields/table, ≤200 fields/package, payload ≤256 KB + pod quota (config `maxPackages`, default 50).
- Concurrency: `pg_advisory_xact_lock` + unique prefix index + full physical name check (collision `slug x + y_z` vs `slug x_y + z`).

## Implementation decisions (documented deviations from the spec)

- **`state` includes `'drift'`** in the CHECK (spec §2 listed only installed/revoked, but §5 requires the drift state) + `revoked_at` column (needed for the 30-day purge after revocation, §6).
- **Maintenance on the ext side** (`sql/001_mi_maintenance.sql`): the ext does not modify the core (ext/ rule), so the "006 fragment-aware" of spec §6 is delivered here. The 30-day tombstone purge already works via the core (`app.purge_old_tombstones` iterates `app.tombstones`, pk `id` enforced).
- **pk `id` bigint serial enforced in v1**: the generic base triggers (`app.version_trigger` etc.) use `NEW.id`.
- **Minimal core patch**: reservation of the routes `/admin/*`, `/apps/`, `/apps/<slug>/meta` in `ldp-container.js` (same mechanism as the existing reservations `/dsp/`, `/app/`) — no API modified.
- **Canonical drift**: structural comparison (tables/columns/type/serial/not_null) via `information_schema`, `serial` normalized `not_null`; sha256 hash of the canonical fragment (`fragment_hash`) compared at boot (AC-B7).
- **v1: the ingested "package" = metadata + manifest + fragment** (no binary); `sri` = hash of the manifest. Binary + SHA-384 verification in v2 (app-store-spec Part 2).
- **Admin channel v1**: `admin` role only (OIDC userinfo/devTokens); signed-contract path with `dsp.capacities` in v2 (spec §3.2).

## TCK

```bash
node --test ext/model-injection/tck/fragment.test.js          # 16 unit tests, no PG
PG_ADMIN_DSN=postgres://admin:***@localhost:5432/fap \
  node ext/model-injection/tck/integration-pg.js              # 12 PG 16 integration tests (AC-B1..B8)
BASE=http://localhost:18880 TOK_ADMIN=tok-admin \
  sh ext/model-injection/tck/e2e-model-injection.sh           # HTTP TCK against a running stack
```

Validated on `postgres:16` (dev stack): 16/16 unit, 12/12 integration (install, 409, 422+rollback,
prefix collision, coexistence, outbox/versioning, RLS owner vs other webid vs published foaf:Agent,
idempotent boot, drift → `drift` state + alarm + recovery, revocation, fragment-aware purge).
