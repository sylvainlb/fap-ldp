# FAP-LDP — Extension LDP du serveur FAP (étape 2, périmètre E1+E2+E3)

Dépôt du composant **FAP-LDP** : extension indépendante du cœur FAP (FAP-light ou FAP-full) apportant
le domaine applicatif `app.*` transactionnel, un endpoint LDP/JSON-LD unique (conteneurs gold + `app.*`)
et le contrôle d'accès unifié (contrat DSP + ACL par ressource, PDP partagé avec le data plane DSP).

- **Spécification** : `../spec/fap-ldp-spec.md` (version 0.1 — brouillon de travail)
- **Cœur FAP** : dépôt `../fap-light-serveur/` (spec `../spec/fap-light-spec-serveur.md` v0.2, décisions D-1..D-6)
- **Références** : synthèse d'architecture FAP (`../spec/facis-fap-architecture-synthese.md`, §3, §4.1, §4.5),
  profils (`../spec/fap-domaine-app-et-profils.md`), cas d'usage
  (`../spec/supervision-energetique-spec-fonctionnelle.md`)

Le FAP-LDP **ne modifie pas** le cœur FAP : il dépend des 4 coutures stables versionnées, déclarées dans
`contracts/` (enveloppe de message, contrat de ligne bronze, transformations SQL sur schémas nommés
`bronze`/`silver`/`gold`/`app`, protocoles d'exposition DSP/LDP + VC/accords).

## Contenu du dépôt (layout de la spec §8)

```
fap-ldp/
├── README.md                  ← ce fichier
├── compose/                   ← install FAP-light (1 VM) : SQL sur le PG existant + flows ORCE importés
├── charts/fap-ldp/            ← install FAP-medium/full (K8s) : conteneur LDP/PDP sidecar, app.* reste en PG
├── contracts/                 ← dépendance versionnée aux coutures du cœur FAP (ex. fap-core-contracts: v1.2)
└── tck/                       ← conformité LDP (suite W3C, niveau de base) + tests PDP/ACL (CA-L1..CA-L8)
```

## Critères d'acceptation couverts (spec §10)

| CA | Énoncé (résumé) |
|----|-----------------|
| CA-L1 | `POST /tickets` → read-after-write immédiat ; PUT = version, DELETE = tombstone |
| CA-L2 | Asset gold publié = conteneur LDP (`ldp:contains`), ressources = lignes, contrat DSP sur l'asset |
| CA-L3 | Membre interne (contrat-cadre auto) lit si ACL autorise ; sinon 403 |
| CA-L4 | Externe avec contrat mais sans ACL → 403 ; avec DID dans l'ACL → allow + audit `agreement_id` |
| CA-L5 | Contrainte ODRL `resourceId isAnyOf [...]` → filtrage des ressources servies |
| CA-L6 | `GET/PUT <res>.acl` round-trip WebACL ⇄ `auth.acl`, effectif immédiatement |
| CA-L7 | Conteneur non publié → invisible/403 pour les externes |
| CA-L8 | Suite de tests W3C LDP (niveau de base) passée |
