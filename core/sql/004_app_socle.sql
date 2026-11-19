-- 004_app_socle.sql — Socle générique du domaine app.* (spec fap§app v0.2 §5.2/§5.3)
-- Ce fichier ne contient AUCUN modèle métier : les tables app.<table> sont créées au boot
-- par le nœud fap§app à partir de config/model.json du déploiement (exemple : examples/supervision/).
-- Ici uniquement les tables et fonctions génériques, valables pour tout modèle.

-- Historique des versions (PUT/PATCH = nouvelle version)
CREATE TABLE IF NOT EXISTS app.versions (
  id bigserial PRIMARY KEY,
  table_name text NOT NULL,
  row_id bigint NOT NULL,
  version integer NOT NULL,
  data jsonb NOT NULL,
  changed_by text,                               -- webid depuis app.webid
  changed_at timestamptz DEFAULT now(),
  UNIQUE (table_name, row_id, version)
);
CREATE INDEX IF NOT EXISTS versions_table_row_idx ON app.versions (table_name, row_id);

-- Tombstones (DELETE LDP = soft delete, purge physique en 006_maintenance.sql, rétention 30 j)
CREATE TABLE IF NOT EXISTS app.tombstones (
  table_name text NOT NULL,
  row_id bigint NOT NULL,
  deleted_at timestamptz DEFAULT now(),
  deleted_by text,
  PRIMARY KEY (table_name, row_id)
);

-- Outbox : retour vers la FAP par événement d'ingestion (RG-3, §5.3).
-- Un flow ORCE consomme pg_notify('fap_ingest') et lit app.outbox → INSERT bronze via la gate.
CREATE TABLE IF NOT EXISTS app.outbox (
  id bigserial PRIMARY KEY,
  event_type text NOT NULL,                      -- ex. 'tickets.INSERT'
  payload jsonb NOT NULL,
  created_at timestamptz DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON app.outbox (id) WHERE processed_at IS NULL;

-- Fonctions trigger génériques. Le nœud fap§app pose les triggers sur chaque table app.<table>
-- déclarée dans model.json (set_updated_at / versioning / tombstone / outbox).
CREATE OR REPLACE FUNCTION app.set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION app.version_trigger() RETURNS trigger AS $$
DECLARE
  v integer;
BEGIN
  SELECT coalesce(max(version), 0) + 1 INTO v
  FROM app.versions WHERE table_name = TG_TABLE_NAME AND row_id = NEW.id;
  INSERT INTO app.versions (table_name, row_id, version, data, changed_by)
  VALUES (TG_TABLE_NAME, NEW.id, v, to_jsonb(NEW), current_setting('app.webid', true));
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION app.tombstone_trigger() RETURNS trigger AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    INSERT INTO app.tombstones (table_name, row_id, deleted_at, deleted_by)
    VALUES (TG_TABLE_NAME, NEW.id, NEW.deleted_at, current_setting('app.webid', true))
    ON CONFLICT (table_name, row_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION app.outbox_trigger() RETURNS trigger AS $$
BEGIN
  INSERT INTO app.outbox (event_type, payload)
  VALUES (TG_TABLE_NAME || '.' || lower(TG_OP), to_jsonb(NEW));
  PERFORM pg_notify('fap_ingest',
    json_build_object('table', TG_TABLE_NAME, 'op', lower(TG_OP), 'id', NEW.id)::text);
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Droits rôle app (le nœud LDP/PEP écrit app.* avec ce rôle — nom commun cœur/extension, spec §7.5)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO app;
GRANT EXECUTE ON FUNCTION app.set_updated_at(), app.version_trigger(), app.tombstone_trigger(), app.outbox_trigger() TO app;
GRANT USAGE ON SCHEMA app TO app;
