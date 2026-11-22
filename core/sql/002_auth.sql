-- 002_auth.sql — auth.acl + auth.can() (spec fap-ldp v0.2 §7.2)
-- v0.2 fix: inheritance (inherited) applies only to containers, i.e. to
-- resource_uri ending with '/' — otherwise an ACL on /tickets/37 would also apply to
-- /tickets/370. starts_with avoids LIKE wildcards (%/_ in IRIs).
-- missing claim → current_setting(..., true) = NULL → no match → silent deny.

CREATE TABLE IF NOT EXISTS auth.acl (
  id bigserial PRIMARY KEY,
  resource_uri text NOT NULL,        -- resource or container IRI (container = trailing "/")
  subject text NOT NULL,             -- webid/did, 'role:xxx', or 'foaf:Agent' (public)
  modes text[] NOT NULL,             -- read / write / append / control
  inherited boolean DEFAULT true,    -- only effective if resource_uri ends with '/'
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS acl_resource_uri_idx ON auth.acl (resource_uri);
CREATE INDEX IF NOT EXISTS acl_subject_idx ON auth.acl (subject);

CREATE OR REPLACE FUNCTION auth.can(res text, mode text) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM auth.acl a
    WHERE (a.resource_uri = res
           OR (a.inherited AND right(a.resource_uri, 1) = '/'
               AND starts_with(res, a.resource_uri)))
      AND (a.subject = current_setting('app.webid', true)
           OR a.subject = 'role:' || current_setting('app.role', true)
           OR a.subject = 'foaf:Agent')
      AND mode = ANY(a.modes));
$$ LANGUAGE sql STABLE;

-- The PEP (app role) reads/writes ACLs via *.acl; the function runs inside the RLS policies.
-- ACL change = potential revocation → pg_notify('fap_revoked') → the PDP purges its
-- decision cache immediately (spec §7.5, AC-L9). Payload = resource_uri.
CREATE OR REPLACE FUNCTION auth.notify_acl_changed() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('fap_revoked', coalesce(NEW.resource_uri, OLD.resource_uri, ''));
  RETURN coalesce(NEW, OLD);
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS acl_changed ON auth.acl;
CREATE TRIGGER acl_changed AFTER INSERT OR UPDATE OR DELETE ON auth.acl
  FOR EACH ROW EXECUTE FUNCTION auth.notify_acl_changed();

GRANT SELECT, INSERT, UPDATE, DELETE ON auth.acl TO app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA auth TO app;
GRANT USAGE ON SCHEMA auth TO app;
GRANT EXECUTE ON FUNCTION auth.can(text, text) TO app, reader;
