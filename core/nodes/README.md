# core/nodes — package `node-red-contrib-fap-ldp`

ORCE nodes of the FAP-LDP core (spec `fap-ldp-spec.md` v0.2 §3/§6.1: a single runtime, no separate service):

| Node | Role | File |
|---|---|---|
| `fap-ldp-model` | Boot: applies `config/model.json` (tables `app.*`, triggers, RLS, `dsp.asset_mapping`). **admin** role connection (boot = migration) | `nodes/model.js` |
| `fap-ldp-container` | **PEP**: LDP/JSON-LD endpoint (GET/POST/PUT/DELETE/PATCH, `*.acl`, ETag/304/412). **app** role pool (writes to `app.*`), optional **reader** pool (gold reads) | `nodes/ldp-container.js` |
| `fap-ldp-pdp` | **PDP**: DSP contract (step 1, PT1H cache + purge on `pg_notify('fap_revoked')`) → ACL `auth.can` (step 2) → ODRL obligations + audit (step 3) | `nodes/pdp.js` |

Internal libs (`lib/`): `pgpool.js` (pool + `withSession`: `SET LOCAL app.webid/role/base_iri` inside the
transaction → RLS), `jsonld.js` (JSON-LD v1 serialization, `dspace:Error` errors), `webacl.js`
(WebACL ⇄ `auth.acl`), `mergepatch.js` (RFC 7386).

## Installation in ORCE

Mount the package in `~/.node-red/nodes/` (or `npm install` in `/data`): Node-RED loads it
at startup (the `pg` dependencies are resolvable from the ORCE image's `/data/node_modules`).

## Minimal flow

```
[fap-ldp-model]  [fap-ldp-pdp]  [fap-ldp-container (pdp → PDP node)]
```

The container node registers a middleware on `RED.httpNode`: the paths `/dsp/*`, `/red*`,
`/editor*` remain with the FAP core; everything else is handled as LDP.

## Auth v1

`Authorization: Bearer|DPoP <token>` → claims via OIDC userinfo (`idpUserinfoUrl`) or, for
TCK/test, `devTokens` (JSON token → claims, not to be used in production). 401 +
`WWW-Authenticate` if missing. Cryptographic verification of the VC (did:web) is delegated to
the IdP in v1 — open point, cf. spec §7.6.
