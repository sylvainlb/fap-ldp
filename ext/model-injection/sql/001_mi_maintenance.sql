-- 001_mi_maintenance.sql — ext/model-injection (E11) : purge fragment-aware après révocation.
--
-- L'ext ne modifie PAS le core (règle ext/ : aucun changement au core) : la spec §6 demandait de
-- rendre 006_maintenance.sql « fragment-aware » ; on livre ici l'équivalent côté ext.
-- La purge des tombstones (30 j) fonctionne déjà pour les tables store_* via le core
-- (app.purge_old_tombstones itère app.tombstones, et le trigger tombstone_trigger y enregistre
-- TG_TABLE_NAME = store_<slug>_<table>, pk id imposé par la validation du fragment).
-- Ici : drop des tables store_<slug>_* d'un package révoqué depuis plus que la rétention,
-- ou archive selon la policy du contrat (facis:retention = drop|archive30d, spec §9).

CREATE OR REPLACE FUNCTION app.mi_drop_revoked_packages(retention interval DEFAULT interval '30 days')
RETURNS integer AS $$
DECLARE
  n integer := 0;
  d integer;
  r record;
  t record;
  policy jsonb;
BEGIN
  FOR r IN
    SELECT slug, model_fragment, contract_id
    FROM app.app_packages
    WHERE state = 'revoked' AND revoked_at < now() - retention
  LOOP
    SELECT policy_jsonld INTO policy FROM dsp.contracts WHERE agreement_id = r.contract_id;
    -- archive30d : on garde les tables (l'admin archive manuellement) ; drop : on lâche tout
    IF coalesce(policy->>'facis:retention', 'drop') = 'drop' THEN
      FOR t IN SELECT jsonb_object_keys(r.model_fragment->'tables') AS table_name
      LOOP
        EXECUTE format('DROP TABLE IF EXISTS app.%I CASCADE', 'store_' || r.slug || '_' || t.table_name);
        GET DIAGNOSTICS d = ROW_COUNT;
        n := n + d;
      END LOOP;
    END IF;
    -- dans tous les cas : les mappings restent (published=false posé à la révocation, §6)
  END LOOP;
  RETURN n;
END $$ LANGUAGE plpgsql SECURITY DEFINER;

-- Planification pg_cron si disponible (profil light l'embarque), comme 006_maintenance.sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'fap-ldp-mi-drop-revoked') THEN
      PERFORM cron.schedule(
        'fap-ldp-mi-drop-revoked',
        '0 4 * * 0',                               -- dimanche 04:00 (après la purge 03:00)
        'SELECT app.mi_drop_revoked_packages()');
    END IF;
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION app.mi_drop_revoked_packages(interval) TO admin;
