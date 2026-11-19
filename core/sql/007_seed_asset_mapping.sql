-- 007_seed_asset_mapping.sql — mapping conteneurs LDP ↔ tables gold (spec fap-ldp v0.2 §6, §2.1)
-- Les conteneurs app.* (/users/, /tickets/, ...) sont enregistrés AU BOOT par le nœud
-- fap-ldp-model à partir de config/model.json du déploiement (avec leurs policies RLS).
-- Ici uniquement les tables gold du cœur.
--
-- container_uri / asset_uri sont stockés en CHEMIN relatif ('/gold/<table>/') ; le PEP préfixe
-- par la base IRI du pod (config baseIri). published=true = publiable dans le catalogue DSP
-- (sinon interne : ACL seule, 403 externe — CA-L7). La publication effective se déclare côté
-- catalogue cœur (datasets.json) + UPDATE published=true ici.
-- Hypothèse v1 : clé primaire nommée `id` (resource_iri_pattern '<id>').

-- Grants gold (idempotent ; le schéma gold peut être créé après 001 — par ex. par le cœur)
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
