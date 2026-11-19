-- 004_app.sql — DDL du domaine app.* (spec fap-ldp v0.2 §5.1) + versioning, tombstones, outbox (§5.2/§5.3)
-- Modèle issu de la spec supervision §4.1 (User, Building, Ticket, Comment).

CREATE TABLE IF NOT EXISTS app.users (
  id bigserial PRIMARY KEY,
  webid text UNIQUE NOT NULL,
  name text NOT NULL,
  email text UNIQUE,
  role text NOT NULL CHECK (role IN ('gestionnaire','technicien','admin')),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.buildings (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  address text,
  meter_id text,
  facis_asset text,                              -- IRI de l'asset catalogue DSP
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app.tickets (
  id bigserial PRIMARY KEY,
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','IN_PROGRESS','RESOLVED','CLOSED')),
  priority text,
  building_id bigint NOT NULL REFERENCES app.buildings(id),
  anomaly_ref text,                              -- IRI ligne gold
  created_by bigint REFERENCES app.users(id),
  assigned_to bigint REFERENCES app.users(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  deleted_at timestamptz                         -- tombstone (soft delete, §5.2)
);
CREATE INDEX IF NOT EXISTS tickets_status_assigned_idx ON app.tickets (status, assigned_to);
CREATE INDEX IF NOT EXISTS tickets_building_idx ON app.tickets (building_id);

CREATE TABLE IF NOT EXISTS app.comments (
  id bigserial PRIMARY KEY,
  ticket_id bigint NOT NULL REFERENCES app.tickets(id),
  author bigint NOT NULL REFERENCES app.users(id),
  text text NOT NULL,
  ts timestamptz DEFAULT now()
);

-- Historique des versions (PUT/PATCH = nouvelle version, §5.2)
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

-- Tombstones (DELETE = soft delete, §5.2 ; purge physique en 006_maintenance.sql)
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

-- Trigger updated_at générique
CREATE OR REPLACE FUNCTION app.set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Trigger de versioning générique (AFTER INSERT OR UPDATE)
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

-- Trigger tombstone : transition deleted_at NULL → non NULL = DELETE LDP (soft delete, §5.2).
-- Le PEP fait donc un unique UPDATE deleted_at = now() ; le tombstone est enregistré ici.
CREATE OR REPLACE FUNCTION app.tombstone_trigger() RETURNS trigger AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    INSERT INTO app.tombstones (table_name, row_id, deleted_at, deleted_by)
    VALUES (TG_TABLE_NAME, NEW.id, NEW.deleted_at, current_setting('app.webid', true))
    ON CONFLICT (table_name, row_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- Trigger outbox + notify (RG-3). DELETE est un soft delete (UPDATE deleted_at) côté PEP,
-- donc INSERT/UPDATE suffisent ; l'événement DELETE part via le tombstone.
CREATE OR REPLACE FUNCTION app.outbox_trigger() RETURNS trigger AS $$
BEGIN
  INSERT INTO app.outbox (event_type, payload)
  VALUES (TG_TABLE_NAME || '.' || lower(TG_OP), to_jsonb(NEW));
  PERFORM pg_notify('fap_ingest',
    json_build_object('table', TG_TABLE_NAME, 'op', lower(TG_OP), 'id', NEW.id)::text);
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users', 'buildings', 'tickets'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS set_updated_at ON app.%I', t);
    EXECUTE format('CREATE TRIGGER set_updated_at BEFORE UPDATE ON app.%I
                    FOR EACH ROW EXECUTE FUNCTION app.set_updated_at()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS versioning ON app.%I', t);
    EXECUTE format('CREATE TRIGGER versioning AFTER INSERT OR UPDATE ON app.%I
                    FOR EACH ROW EXECUTE FUNCTION app.version_trigger()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS tombstone ON app.%I', t);
    EXECUTE format('CREATE TRIGGER tombstone AFTER UPDATE ON app.%I
                    FOR EACH ROW EXECUTE FUNCTION app.tombstone_trigger()', t);
  END LOOP;
  EXECUTE 'DROP TRIGGER IF EXISTS outbox ON app.tickets';
  EXECUTE 'CREATE TRIGGER outbox AFTER INSERT OR UPDATE ON app.tickets
           FOR EACH ROW EXECUTE FUNCTION app.outbox_trigger()';
END $$;

-- Droits rôle ldp (le PEP écrit app.* avec ce rôle)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO ldp;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO ldp;
GRANT EXECUTE ON FUNCTION app.set_updated_at(), app.version_trigger(), app.tombstone_trigger(), app.outbox_trigger() TO ldp;
GRANT USAGE ON SCHEMA app TO ldp;
