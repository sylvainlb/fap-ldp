-- 006_maintenance.sql — purge physique RGPD (spec fap-ldp v0.2 §5.2, §8)
-- Tombstones + versions conservés 30 jours, purge hebdomadaire par pg_cron.
-- Si pg_cron n'est pas installé, exécuter manuellement (cron système) :
--   psql -c "SELECT app.purge_old_tombstones()"

-- SECURITY DEFINER : la purge s'exécute hors session PEP (sans app.webid) et FORCE ROW LEVEL
-- SECURITY s'applique même au owner des tables ; les migrations doivent donc tourner en
-- superuser (postgres), comme dans compose/.
CREATE OR REPLACE FUNCTION app.purge_old_tombstones(retention interval DEFAULT interval '30 days')
RETURNS integer AS $$
DECLARE
  n integer := 0;
  r record;
BEGIN
  -- Supprime physiquement les lignes soft-deletées au-delà de la rétention,
  -- et les versions/tombstones associées.
  FOR r IN
    SELECT table_name, row_id FROM app.tombstones WHERE deleted_at < now() - retention
  LOOP
    EXECUTE format('DELETE FROM app.%I WHERE id = %s AND deleted_at < now() - $1',
                   r.table_name, r.row_id) USING retention;
    GET DIAGNOSTICS n = ROW_COUNT;
    DELETE FROM app.versions WHERE table_name = r.table_name AND row_id = r.row_id;
    DELETE FROM app.tombstones WHERE table_name = r.table_name AND row_id = r.row_id;
  END LOOP;
  RETURN n;
END $$ LANGUAGE plpgsql SECURITY DEFINER;

-- Planification pg_cron si l'extension est disponible (profil light l'embarque).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'fap-ldp-purge-tombstones') THEN
      PERFORM cron.schedule(
        'fap-ldp-purge-tombstones',
        '0 3 * * 0',                               -- dimanche 03:00
        'SELECT app.purge_old_tombstones()');
    END IF;
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION app.purge_old_tombstones(interval) TO admin;
