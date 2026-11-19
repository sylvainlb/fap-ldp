# core/nodes — package `node-red-contrib-fap-ldp`

Nœuds ORCE du core FAP-LDP (spec `fap-ldp-spec.md` v0.2 §3/§6.1 : un seul runtime, pas de service séparé) :

| Nœud | Rôle | Fichier |
|---|---|---|
| `fap-ldp-model` | Boot : applique `config/model.json` (tables `app.*`, triggers, RLS, `dsp.asset_mapping`). Connexion rôle **admin** (boot = migration) | `nodes/model.js` |
| `fap-ldp-container` | **PEP** : endpoint LDP/JSON-LD (GET/POST/PUT/DELETE/PATCH, `*.acl`, ETag/304/412). Pool rôle **app** (écritures `app.*`), pool **reader** optionnel (lectures gold) | `nodes/ldp-container.js` |
| `fap-ldp-pdp` | **PDP** : contrat DSP (étape 1, cache PT1H + purge sur `pg_notify('fap_revoked')`) → ACL `auth.can` (étape 2) → obligations ODRL + audit (étape 3) | `nodes/pdp.js` |

Libs internes (`lib/`) : `pgpool.js` (pool + `withSession` : `SET LOCAL app.webid/role/base_iri` dans la
transaction → RLS), `jsonld.js` (sérialisation JSON-LD v1, erreurs `dspace:Error`), `webacl.js`
(WebACL ⇄ `auth.acl`), `mergepatch.js` (RFC 7386).

## Installation dans ORCE

Monter le package dans `~/.node-red/nodes/` (ou `npm install` dans `/data`) : Node-RED le charge
au démarrage (les dépendances `pg` sont résolubles depuis `/data/node_modules` de l'image ORCE).

## Flow minimal

```
[fap-ldp-model]  [fap-ldp-pdp]  [fap-ldp-container (pdp → nœud PDP)]
```

Le nœud conteneur enregistre un middleware sur `RED.httpNode` : les chemins `/dsp/*`, `/red*`,
`/editor*` restent au cœur FAP ; tout le reste est traité en LDP.

## Authentification v1

`Authorization: Bearer|DPoP <token>` → claims via userinfo OIDC (`idpUserinfoUrl`) ou, pour le
TCK/test, `devTokens` (JSON token → claims, à ne pas utiliser en production). 401 +
`WWW-Authenticate` si absent. La vérification cryptographique de la VC (did:web) est déléguée à
l'IdP en v1 — point ouvert, cf. spec §7.6.
