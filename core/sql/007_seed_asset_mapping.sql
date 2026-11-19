-- 007_seed_asset_mapping.sql — mapping conteneurs LDP ↔ tables (spec fap-ldp v0.2 §6, §2.1)
-- container_uri / asset_uri sont stockés en CHEMIN relatif ('/tickets/') ; le PEP préfixe par
-- la base IRI du pod (config baseIri). published=true = conteneur publiable dans le catalogue
-- DSP (sinon interne : ACL seule, 403 externe — CA-L7). La publication effective d'un asset gold
-- se déclare côté catalogue cœur (datasets.json) + UPDATE published=true ici.

INSERT INTO dsp.asset_mapping (asset_uri, container_uri, table_schema, table_name, resource_iri_pattern, published) VALUES
  ('/users/',                 '/users/',                   'app', 'users',    '/users/<id>',                          false),
  ('/buildings/',             '/buildings/',               'app', 'buildings','/buildings/<id>',                      true),
  ('/tickets/',               '/tickets/',                 'app', 'tickets',  '/tickets/<id>',                        false),
  ('/tickets/*/comments/',    '/tickets/*/comments/',      'app', 'comments', '/tickets/<ticket_id>/comments/<id>',   false)
ON CONFLICT (asset_uri) DO NOTHING;

-- Toutes les tables gold mappées en conteneurs /gold/<table>/ (non publiées par défaut).
-- Hypothèse v1 : clé primaire nommée `id` (resource_iri_pattern '<id>').
INSERT INTO dsp.asset_mapping (asset_uri, container_uri, table_schema, table_name, resource_iri_pattern, published)
SELECT '/gold/' || t.table_name || '/', '/gold/' || t.table_name || '/',
       'gold', t.table_name, '/gold/' || t.table_name || '/<id>', false
FROM information_schema.tables t
WHERE t.table_schema = 'gold' AND t.table_type = 'BASE TABLE'
ON CONFLICT (asset_uri) DO NOTHING;
