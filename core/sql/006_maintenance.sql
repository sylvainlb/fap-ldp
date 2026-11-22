-- 006_maintenance.sql — GDPR physical purge (spec fap-ldp v0.2 §5.2, §8)
-- Tombstones + versions kept 30 days, weekly purge by pg_cron.
-- If pg_cron is not installed, run manually (system cron):
--   psql -c "SELECT app.purge_old_tombstones()"

-- SECURITY DEFINER: the purge runs outside the PEP session (without app.webid) and FORCE ROW LEVEL
-- SECURITY applies even to the table owner; migrations must therefore run as
-- superuser (postgres), as in compose/.
CREATE OR REPLACE FUNCTION app.purge_old_tombstones(retention interval DEFAULT interval '30 days')
RETURNS integer AS $$
DECLARE
  n integer := 0;
  r record;
BEGIN
  -- Physically deletes soft-deleted rows beyond the retention,
  -- and the associated versions/tombstones.
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

-- pg_cron scheduling if the extension is available (light profile embeds it).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'fap-ldp-purge-tombstones') THEN
      PERFORM cron.schedule(
        'fap-ldp-purge-tombstones',
        '0 3 * * 0',                               -- Sunday 03:00
        'SELECT app.purge_old_tombstones()');
    END IF;
  END IF;
END $$;

GRANT EXECUTE ON FUNCTION app.purge_old_tombstones(interval) TO admin;
