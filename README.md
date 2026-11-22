# FAP-LDP — LDP extension of the FAP server (step 2, scope E1+E2+E3)

Repository of the **FAP-LDP** component: an extension independent of the FAP core (FAP-light or FAP-full) providing
the transactional `app.*` application domain, a single LDP/JSON-LD endpoint (gold containers + `app.*`)
 in the same ORCE runtime (package `node-red-contrib-fap-ldp`), and unified access control
(DSP contract + per-resource ACL, PDP shared with the DSP data plane).

- **Specification**: `../spec/fap-ldp-spec.md` (version 0.2 — decisions A–E integrated)
- **FAP core**: repository `../fap-light-serveur/` (spec `../spec/fap-light-spec-serveur.md` v0.2, decisions D-1..D-6)
- **Core seams**: target `fap-core-contracts: v1.0` (to be created on the core side, `contracts/` of the fap-light-serveur repo)
- **References**: FAP architecture synthesis (`../spec/facis-fap-architecture-synthese.md`, §3, §4.1, §4.5),
  profiles (`../spec/fap-domaine-app-et-profils.md`), use cases
  (`../spec/supervision-energetique-spec-fonctionnelle.md`)

FAP-LDP **does not modify** the FAP core: it depends on stable versioned seams, declared in
`contracts/` (message envelope, bronze row contract, SQL transformations on named schemas
`bronze`/`silver`/`gold`/`app`, `trino-read-api v1`, `dsp-control-plane-api v1`, DSP/LDP protocols).

## Repository contents (light monorepo layout, spec §4)

```
fap-ldp/
├── README.md                  ← this file
├── core/                      ← E1+E2+E3 — required, stable API/hooks, backwards compatible
│   ├── nodes/                 ← package node-red-contrib-fap-ldp (LDP container/PEP node, PDP node)
│   ├── sql/                   ← generic base ONLY: roles, auth.acl/auth.can, dsp.*, app.versions/tombstones/outbox, maintenance (no business model)
│   └── tck/                   ← W3C LDP conformance (app-tests) + PDP/ACL tests
├── examples/                  ← example business models (e.g. supervision/: model.json + SQL), applied at boot by the node
├── ext/                       ← optional extensions, each = standalone installable package
│   ├── semantics/  (E4)       ←   each ext: own package/nodes, own tck/, own README
│   ├── shacl/      (E5)       ←   plugged onto the core's stable hooks, enabled by config
│   ├── index/      (E6)
│   ├── push/       (E7)
│   ├── federation/ (E8)
│   ├── store-rdf/  (E10)
│   ├── model-injection/ (E11) ←   governed model injection by package (app store backend), v0.1
│   └── hot-reload/ (E12)      ←   hot application of models (v2 of E11)
├── contracts/                 ← versioned dependency: fap-core-contracts v1.0
├── compose/                   ← install FAP-light (1 VM): ORCE + fap-ldp package + PG + caddy + embedded Keycloak
│                              │   → step-by-step guide (from scratch, local/prod): compose/README.md
├── charts/fap-ldp/            ← install FAP-medium/full (K8s): same public endpoint (443, routing / → LDP, /dsp/* → core)
└── tck/                       ← core × ext compatibility matrix + integration tests
```

## Covered acceptance criteria (spec §11)

| AC | Statement (summary) |
|----|---------------------|
| AC-L1 | `POST /tickets` → immediate read-after-write; PUT/PATCH = new version; DELETE = tombstone |
| AC-L2 | Published gold asset = LDP container (`app:contains`), resources = rows, DSP contract on the asset |
| AC-L3 | Internal member (auto framework contract) reads if ACL allows; otherwise 403 |
| AC-L4 | External with contract but without ACL → 403; with DID in the ACL → allow + audit `agreement_id` |
| AC-L5 | ODRL constraint `facis:resourceId isAnyOf [...]` → filtering of served resources |
| AC-L6 | `GET/PUT <res>.acl` WebACL round-trip ⇄ `auth.acl`, effective immediately (cache purge) |
| AC-L7 | Unpublished container → invisible/403 for externals |
| AC-L8 | app-tests (W3C) subset listed in `tck/` passing |
| AC-L9 | Contract/ACL revocation → access cut < 1 s (active cache purge) |
| AC-L10 | PATCH Merge Patch = partial modification + version; stale `If-Match` → 412 |
