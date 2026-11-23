# ext/shacl — compiled SHACL contracts (E5, chantiers 1–2 of `spec/app-shape-editor.md` rev 4)

The model fragment (DSL annexe A, injected by E11) and the core `model.json` remain the **only
sources of truth**. This extension **compiles** them into SHACL and publishes the result as an
external contract, read-only. The SQL write path (CHECK, business rules, RLS) stays the only
write authority — this ext adds **no** constraint to it and modifies **no** core/E11 behavior
(the only core contact is the route reservation patch, A.2).

## Nodes

| Node | Role |
|---|---|
| `fap-ldp-shacl-boot` | Prewarm published contracts at boot (C7) + `LISTEN fap_revoked` → cache drop (C2) |
| `fap-ldp-shacl-serve` | HTTP endpoints below (routes reserved in core by the A.2 patch) |

## Endpoints (contract `contracts/ldp-shacl-api-v1.yaml`)

| Route | Content |
|---|---|
| `GET /shapes` | Core model contract — Turtle (JSON-LD on Accept), `ETag W/"<sha256>"`, 304 on If-None-Match (F3.2/F3.4) |
| `GET /shapes/` | Index of all sources: core + packages, all states, contract/fragment URIs, hashes, `supersedes` (F3.6) |
| `GET /fragment` | Core `model.json` + hash (F3.5) |
| `GET /apps/<slug>/shapes` | Package contract, **published tables only** (`dsp.asset_mapping`) — 404 no published table, 410 revoked (F3.3) |
| `GET /apps/<slug>/fragment` | Raw `model_fragment` + `fragment_hash` + state + `supersedes` (F3.5) |
| `POST /apps/<slug>/validate`, `POST /apps/<slug>/<table>/validate` | J3 (separate branch): W3C validation report, read-only |

Read = any authenticated pod user (same as E11 `GET /apps/`). Compilation is **lazy** (first read
compiles, cache keyed by `fragment_hash`); E11 emits no install event and none is added (F3.1).

## Compilation rules (rev 4)

- IRIs on the **physical** PG table name: `app.store_<slug>_<table>` → `${base}/ns/app/store_<slug>_<table>#<field>`;
  core `app.<table>` → `${base}/ns/app/<table>#<field>` — identical to the served JSON-LD context (R1.2/R1.3).
- Mappings (F2.1): `text→xsd:string`, `bigint→xsd:integer`, `numeric→xsd:decimal`,
  `boolean→xsd:boolean`, `timestamptz→xsd:dateTime`, `not_null→sh:minCount 1`, `check_in→sh:in`,
  `fk→sh:nodeKind sh:IRI + sh:class <core users shape>` (annexe A fk enum is `users` only),
  `node_kind: iri→sh:nodeKind sh:IRI`, `lang: true→rdf:langString`.
- `align` / `align_class` accept full IRIs or prefixed forms (`geo:lat`, `dcterms:description`…)
  expanded via a fixed prefix map. `label_i18n` → `sh:name` (pivot `en`) + `rdfs:label` per locale (R1.1).
- Service fields (`id`, `created_at`, `updated_at`, `deleted_at`) + `contract_exclude` are excluded
  from the contract (R1.4); the served JSON-LD keeps them, so **`sh:closed` is never emitted** (F2.5).
- Deterministic, idempotent output (F2.3): sorted shapes/properties/locales, fixed prefixes →
  same fragment = same bytes = same sha256 (F5.3).

## Non-mappings (R1.5) — deliberately NOT in the contract

Status transitions & roles (`business_rules`), RLS policies, quotas, owner, tombstone, `published`,
default values, uniqueness (A.1: out of contract in v1), `jsonb` content shape (omitted in v1).
The contract describes the **shape of exchange data**, never deployment governance. Consequently a
SHACL-conformant datum can still be rejected by the SQL write path (e.g. `409 invalid_transition`) —
documented expectation F5.2 ("governed", not "incoherent").

## TCK

- `tck/compiler.test.js` — `node --test tck/` : F2.1, R1.2–R1.4, F2.5, F5.3, F5.4, C3, published scope (11 tests).
- Cross-conformance F5.1 (served JSON-LD validates against the compiled contract) and F5.2 live in
  the J3 branch (`tck/cross-conformance.test.js`, needs a running PG).

## Dependencies before full activation

- **J1**: annexe A v0.4 (semantic keys, `contract_exclude`, `supersedes`, reserved table names
  `meta|shapes|validate|fragment`) — transverse agreement with the DSL spec owner. Until then,
  fragments carrying those keys are rejected `422 schema_violation` by E11; the compiler already
  handles them defensively.
- **A.2**: core route reservation patch (`feat/a2-core-reserve-shacl-routes`).
