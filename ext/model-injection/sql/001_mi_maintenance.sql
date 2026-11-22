-- 001_mi_maintenance.sql — ext/model-injection (E11): fragment-aware purge after revocation.
--
-- The ext does NOT modify the core (ext/ rule: no change to the core): spec §6 asked to make
-- 006_maintenance.sql "fragment-aware"; the equivalent is delivered here on the ext side.
-- The tombstone purge (30 days) already works for the store_* tables via the core
-- (app.purge_old_tombstones iterates app.tombstones, and the tombstone_trigger records
-- TG_TABLE_NAME = store_<slug>_<table> there, pk id enforced by fragment validation).
-- Here: drop of the store_<slug>_* tables of a package revoked for longer than the retention,
-- or archive depending on the contract policy (facis:retention = drop|archive30d, spec §9).

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
    -- archive30d: keep the tables (the admin archives manually); drop: drop everything
    IF coalesce(policy->>'facis:retention', 'drop') = 'drop' THEN
      FOR t IN SELECT jsonb_object_keys(r.model_fragment->'tables') AS table_name
      LOOP
        EXECUTE format('DROP TABLE IF EXISTS app.%I CASCADE', 'store_' || r.slug || '_' || t.table_name);
        GET DIAGNOSTICS d = ROW_COUNT;
        n := n + d;
      END LOOP;
    END IF;
    -- in all cases: the mappings stay (published=false set at revocation, §6)
  END LOOP;
  RETURN n;
END $$ LANGUAGE plpgsql SECURITY DEFINER;

-- pg_cron scheduling if available (light profile embeds it), like 006_maintenance.sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'fap-ldp-mi-drop-revoked') THEN
      PERFORM cron.schedule(
        'fap-ldp-mi-drop-revoked',
        '0 4 * * 0',                               -- Sunday 04:00 (after the 03:00 purge)
        'SELECT app.mi_drop_revoked_packages()');
    END IF;
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION app.mi_drop_revoked_packages(interval) TO admin;
