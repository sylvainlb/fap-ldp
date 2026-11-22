-- 004_app_socle.sql — Generic base of the app.* domain (spec fap-ldp v0.2 §5.2/§5.3)
-- This file contains NO business model: the app.<table> tables are created at boot
-- by the fap-ldp node from the deployment's config/model.json (example: examples/supervision/).
-- Here only the generic tables and functions, valid for any model.

-- Version history (PUT/PATCH = new version)
CREATE TABLE IF NOT EXISTS app.versions (
  id bigserial PRIMARY KEY,
  table_name text NOT NULL,
  row_id bigint NOT NULL,
  version integer NOT NULL,
  data jsonb NOT NULL,
  changed_by text,                               -- webid from app.webid
  changed_at timestamptz DEFAULT now(),
  UNIQUE (table_name, row_id, version)
);
CREATE INDEX IF NOT EXISTS versions_table_row_idx ON app.versions (table_name, row_id);

-- Tombstones (LDP DELETE = soft delete, physical purge in 006_maintenance.sql, 30-day retention)
CREATE TABLE IF NOT EXISTS app.tombstones (
  table_name text NOT NULL,
  row_id bigint NOT NULL,
  deleted_at timestamptz DEFAULT now(),
  deleted_by text,
  PRIMARY KEY (table_name, row_id)
);

-- Outbox: feedback to the FAP via ingestion event (RG-3, §5.3).
-- An ORCE flow consumes pg_notify('fap_ingest') and reads app.outbox → INSERT bronze via the gate.
CREATE TABLE IF NOT EXISTS app.outbox (
  id bigserial PRIMARY KEY,
  event_type text NOT NULL,                      -- e.g. 'tickets.INSERT'
  payload jsonb NOT NULL,
  created_at timestamptz DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON app.outbox (id) WHERE processed_at IS NULL;

-- Generic trigger functions. The fap-ldp node sets the triggers on each app.<table>
-- declared in model.json (set_updated_at / versioning / tombstone / outbox).
-- INSERT: fills updated_at if absent (default); UPDATE: always
CREATE OR REPLACE FUNCTION app.set_updated_at() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.updated_at IS NULL THEN
    NEW.updated_at := now();
  ELSIF TG_OP = 'UPDATE' THEN
    NEW.updated_at := now();
  END IF;
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

-- app role rights (the LDP/PEP node writes app.* with this role — name shared core/extension, spec §7.5)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO app;
GRANT EXECUTE ON FUNCTION app.set_updated_at(), app.version_trigger(), app.tombstone_trigger(), app.outbox_trigger() TO app;
GRANT USAGE ON SCHEMA app TO app;
