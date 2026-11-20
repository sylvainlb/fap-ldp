-- 000_model_injection.sql — ext/model-injection (E11, spec atlas/spec/model-injection-spec.md v0.3)
-- Table des packages installés (état du déploiement). Exécutée en rôle admin, AVANT le nœud
-- fap-ldp-model (et avant le nœud fap-ldp-mi-boot) : résout le chicken-and-egg du boot
-- (le nœud lit app.app_packages pour fusionner les fragments au boot).
--
-- Ajout d'implémentation documenté : `revoked_at` (absent de la spec §2) est nécessaire pour
-- borner la purge 30 j après révocation (§6) ; le CHECK de `state` inclut 'drift' (§5 : la détection
-- de drift passe l'état à 'drift' + alarme — la spec §2 ne listait que installed/revoked).

CREATE TABLE IF NOT EXISTS app.app_packages (
  slug text PRIMARY KEY CHECK (slug ~ '^[a-z][a-z0-9_]{1,30}$'),
  version text NOT NULL,                          -- épinglée, sans ^
  sri text,                                       -- SHA-384 ; NULL accepté en v1 (hash du manifeste, §8)
  model_fragment jsonb NOT NULL,                  -- fragment validé (annexe A de la spec)
  fragment_hash text NOT NULL,                    -- sha256 du fragment canonique (détection de drift, §5)
  contract_id text REFERENCES dsp.contracts(agreement_id),
  state text NOT NULL DEFAULT 'installed'
    CHECK (state IN ('installed','revoked','drift')),
  installed_by text NOT NULL,                     -- webid de l'admin installateur
  installed_at timestamptz DEFAULT now(),
  revoked_at timestamptz                          -- renseigné par DELETE /admin/apps/<slug> (§6)
);

-- Unicité du préfixe dérivé (anti-collision, spec §2/§3.3) : deux slugs distincts ne peuvent pas
-- partager un préfixe de table (les identifiants sont toujours créés en minuscules quotées, N4).
CREATE UNIQUE INDEX IF NOT EXISTS app_packages_prefix_uidx
  ON app.app_packages (('store_' || slug || '_'));

CREATE INDEX IF NOT EXISTS app_packages_state_idx ON app.app_packages (state);

-- Moindre privilège : PUBLIC n'a rien. Le boot et l'endpoint admin tournent en rôle admin
-- (migrations/DDL) ; le rôle runtime app peut lire l'état (utile au PEP/TCK).
GRANT SELECT ON app.app_packages TO app;
GRANT USAGE ON SCHEMA app TO admin; -- admin est owner des objets de migration ; grant explicite pour lecture runtime
