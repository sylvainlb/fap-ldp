-- 003_dsp.sql — schémas dsp.* : contrats, capacités, audit, mapping asset ↔ conteneur
-- (spec fap-ldp v0.2 §7.2, §6). La négociation DSP elle-même reste dans le cœur FAP
-- (dsp-control-plane-api v1) ; FAP-LDP consulte/écrit cet état.

CREATE TABLE IF NOT EXISTS dsp.contracts (
  id bigserial PRIMARY KEY,
  asset_uri text NOT NULL,           -- asset DSP ; contrat-cadre interne : base IRI du pod
  assignee_did text,                 -- DID du partenaire (externe) ou webid (interne)
  policy_jsonld jsonb,               -- ODRL 2.2 core + extension facis:, stocké tel quel
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','revoked')),
  agreement_id text UNIQUE,
  expires_at timestamptz,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contracts_asset_idx ON dsp.contracts (asset_uri, state);

CREATE TABLE IF NOT EXISTS dsp.capacities (
  token_hash text PRIMARY KEY,       -- hash du token (DPoP) : cache de décision, TTL PT1H
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
  container_uri text NOT NULL,       -- conteneur LDP (slash final)
  table_schema text NOT NULL,        -- ex. 'gold' ou 'app'
  table_name text NOT NULL,
  resource_iri_pattern text NOT NULL,-- ex. '<container>/<pk>'
  time_column text,
  published boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS asset_mapping_container_idx ON dsp.asset_mapping (container_uri);

-- Révocation = DELETE (ou state='revoked') + pg_notify('fap_revoked') → le PDP purge son cache
-- de décision immédiatement (spec §7.5, CA-L9). Payload = agreement_id (contrat) ou
-- resource_uri (ACL).
CREATE OR REPLACE FUNCTION dsp.notify_contract_revoked() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('fap_revoked', coalesce(NEW.agreement_id, OLD.agreement_id, ''));
  RETURN coalesce(NEW, OLD);
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS contracts_revoked ON dsp.contracts;
CREATE TRIGGER contracts_revoked AFTER UPDATE OF state OR DELETE ON dsp.contracts
  FOR EACH ROW EXECUTE FUNCTION dsp.notify_contract_revoked();

-- Droits : le PDP (rôle app) consulte et met à jour contrats/capacités, écrit l'audit.
GRANT SELECT, INSERT, UPDATE, DELETE ON dsp.contracts TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON dsp.capacities TO app;
GRANT SELECT, INSERT ON dsp.audit TO app;
GRANT SELECT, INSERT, UPDATE ON dsp.asset_mapping TO app;
GRANT SELECT ON dsp.contracts, dsp.capacities, dsp.asset_mapping TO reader;
GRANT USAGE ON SCHEMA dsp TO app, reader;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA dsp TO app;
