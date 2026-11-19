# FAP-LDP — Extension LDP du serveur FAP (étape 2, périmètre E1+E2+E3)

Dépôt du composant **FAP-LDP** : extension indépendante du cœur FAP (FAP-light ou FAP-full) apportant
le domaine applicatif `app.*` transactionnel, un endpoint LDP/JSON-LD unique (conteneurs gold + `app.*`)
 dans le même runtime ORCE (package `node-red-contrib-fap-ldp`), et le contrôle d'accès unifié
(contrat DSP + ACL par ressource, PDP partagé avec le data plane DSP).

- **Spécification** : `../spec/fap-ldp-spec.md` (version 0.2 — décisions A–E intégrées)
- **Cœur FAP** : dépôt `../fap-light-serveur/` (spec `../spec/fap-light-spec-serveur.md` v0.2, décisions D-1..D-6)
- **Coutures cœur** : cible `fap-core-contracts: v1.0` (à créer côté cœur, `contracts/` du dépôt fap-light-serveur)
- **Références** : synthèse d'architecture FAP (`../spec/facis-fap-architecture-synthese.md`, §3, §4.1, §4.5),
  profils (`../spec/fap-domaine-app-et-profils.md`), cas d'usage
  (`../spec/supervision-energetique-spec-fonctionnelle.md`)

Le FAP-LDP **ne modifie pas** le cœur FAP : il dépend des coutures stables versionnées, déclarées dans
`contracts/` (enveloppe de message, contrat de ligne bronze, transformations SQL sur schémas nommés
`bronze`/`silver`/`gold`/`app`, `trino-read-api v1`, `dsp-control-plane-api v1`, protocoles DSP/LDP).

## Contenu du dépôt (layout monorepo léger, spec §4)

```
fap-ldp/
├── README.md                  ← ce fichier
├── core/                      ← E1+E2+E3 — requis, API/hooks stables, rétrocompatibles
│   ├── nodes/                 ← package node-red-contrib-fap-ldp (nœud conteneur LDP/PEP, nœud PDP)
│   ├── sql/                   ← auth.acl, auth.can, dsp.*, asset_mapping, RLS, DDL app.* + versions/tombstones/outbox
│   └── tck/                   ← conformité W3C LDP (ldp-tests) + tests PDP/ACL
├── ext/                       ← extensions optionnelles E4–E10, chacune = package installable seul
│   ├── semantics/  (E4)       ←   chaque ext : propre package/nœuds, propre tck/, propre SPEC.md
│   ├── shacl/      (E5)       ←   branchée sur les hooks stables du core, activée par config
│   ├── index/      (E6)
│   ├── push/       (E7)
│   ├── federation/ (E8)
│   └── store-rdf/  (E10)
├── contracts/                 ← dépendance versionnée : fap-core-contracts v1.0
├── compose/                   ← install FAP-light (1 VM) : ORCE + package fap-ldp + PG + caddy + Keycloak embarqué
├── charts/fap-ldp/            ← install FAP-medium/full (K8s) : même endpoint public (443, routing / → LDP, /dsp/* → cœur)
└── tck/                       ← matrice de compatibilité core × ext + tests d'intégration
```

## Critères d'acceptation couverts (spec §11)

| CA | Énoncé (résumé) |
|----|-----------------|
| CA-L1 | `POST /tickets` → read-after-write immédiat ; PUT/PATCH = nouvelle version ; DELETE = tombstone |
| CA-L2 | Asset gold publié = conteneur LDP (`ldp:contains`), ressources = lignes, contrat DSP sur l'asset |
| CA-L3 | Membre interne (contrat-cadre auto) lit si ACL autorise ; sinon 403 |
| CA-L4 | Externe avec contrat mais sans ACL → 403 ; avec DID dans l'ACL → allow + audit `agreement_id` |
| CA-L5 | Contrainte ODRL `facis:resourceId isAnyOf [...]` → filtrage des ressources servies |
| CA-L6 | `GET/PUT <res>.acl` round-trip WebACL ⇄ `auth.acl`, effectif immédiatement (purge cache) |
| CA-L7 | Conteneur non publié → invisible/403 pour les externes |
| CA-L8 | Sous-ensemble ldp-tests (W3C) listé dans `tck/` passé |
| CA-L9 | Révocation contrat/ACL → accès coupé < 1 s (purge cache active) |
| CA-L10 | PATCH Merge Patch = modification partielle + version ; `If-Match` obsolète → 412 |
