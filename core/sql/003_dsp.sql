-- 003_dsp.sql — dsp.* schemas: contracts, capacities, audit, asset ↔ container mapping
-- (spec fap-ldp v0.2 §7.2, §6). The DSP negotiation itself stays in the FAP core
-- (dsp-control-plane-api v1); FAP-LDP reads/writes this state.

CREATE TABLE IF NOT EXISTS dsp.contracts (
  id bigserial PRIMARY KEY,
  asset_uri text NOT NULL,           -- DSP asset; internal framework contract: pod base IRI
  assignee_did text,                 -- partner DID (external) or webid (internal)
  policy_jsonld jsonb,               -- ODRL 2.2 core + facis: extension, stored as-is
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','revoked')),
  agreement_id text UNIQUE,
  expires_at timestamptz,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contracts_asset_idx ON dsp.contracts (asset_uri, state);

CREATE TABLE IF NOT EXISTS dsp.capacities (
  token_hash text PRIMARY KEY,       -- token (DPoP) hash: decision cache, TTL PT1H
  contract_id bigint REFERENCES dsp.contracts(id),
  scopes jsonb,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS dsp.audit (
  ts timestamptz DEFAULT now(),
  agreement_id text,
  webid text,
  resource_uri text,
  mode text,
  decision text NOT NULL CHECK (decision IN ('allow','deny'))
);
CREATE INDEX IF NOT EXISTS audit_ts_idx ON dsp.audit (ts);

CREATE TABLE IF NOT EXISTS dsp.asset_mapping (
  asset_uri text PRIMARY KEY,
  container_uri text NOT NULL,       -- LDP container (trailing slash)
  table_schema text NOT NULL,        -- e.g. 'gold' or 'app'
  table_name text NOT NULL,
  resource_iri_pattern text NOT NULL,-- e.g. '<container>/<pk>'
  time_column text,
  published boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS asset_mapping_container_idx ON dsp.asset_mapping (container_uri);

-- Revocation = DELETE (or state='revoked') + pg_notify('fap_revoked') → the PDP purges its
-- decision cache immediately (spec §7.5, AC-L9). Payload = agreement_id (contract) or
-- resource_uri (ACL).
CREATE OR REPLACE FUNCTION dsp.notify_contract_revoked() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('fap_revoked', coalesce(NEW.agreement_id, OLD.agreement_id, ''));
  RETURN coalesce(NEW, OLD);
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS contracts_revoked ON dsp.contracts;
CREATE TRIGGER contracts_revoked AFTER UPDATE OF state OR DELETE ON dsp.contracts
  FOR EACH ROW EXECUTE FUNCTION dsp.notify_contract_revoked();

-- Rights: the PDP (app role) reads and updates contracts/capacities, writes the audit.
GRANT SELECT, INSERT, UPDATE, DELETE ON dsp.contracts TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON dsp.capacities TO app;
GRANT SELECT, INSERT ON dsp.audit TO app;
GRANT SELECT, INSERT, UPDATE ON dsp.asset_mapping TO app;
GRANT SELECT ON dsp.contracts, dsp.capacities, dsp.asset_mapping TO reader;
GRANT USAGE ON SCHEMA dsp TO app, reader;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA dsp TO app;
