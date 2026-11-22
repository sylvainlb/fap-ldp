-- 007_seed_asset_mapping.sql — LDP container ↔ gold table mapping (spec fap-ldp v0.2 §6, §2.1)
-- The app.* containers (/users/, /tickets/, ...) are registered AT BOOT by the
-- fap-ldp-model node from the deployment's config/model.json (with their RLS policies).
-- Here only the core's gold tables.
--
-- container_uri / asset_uri are stored as RELATIVE PATHS ('/gold/<table>/'); the PEP prefixes
-- them with the pod base IRI (config baseIri). published=true = publishable in the DSP catalog
-- (otherwise internal: ACL only, 403 external — AC-L7). Effective publication is declared on the
-- core catalog side (datasets.json) + UPDATE published=true here.
-- v1 assumption: primary key named `id` (resource_iri_pattern '<id>').

-- Gold grants (idempotent; the gold schema may be created after 001 — e.g. by the core)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'gold') THEN
    GRANT USAGE ON SCHEMA gold TO app, reader, materializer;
    GRANT SELECT ON ALL TABLES IN SCHEMA gold TO app, reader;
  END IF;
END $$;

INSERT INTO dsp.asset_mapping (asset_uri, container_uri, table_schema, table_name, resource_iri_pattern, published)
SELECT '/gold/' || t.table_name || '/', '/gold/' || t.table_name || '/',
       'gold', t.table_name, '/gold/' || t.table_name || '/<id>', false
FROM information_schema.tables t
WHERE t.table_schema = 'gold' AND t.table_type IN ('BASE TABLE', 'VIEW')
ON CONFLICT (asset_uri) DO NOTHING;
