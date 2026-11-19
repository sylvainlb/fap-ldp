-- 002_auth.sql — auth.acl + auth.can() (spec fap§app v0.2 §7.2)
-- Correctif v0.2 : l'héritage (inherited) ne s'applique qu'aux conteneurs, c'est-à-dire aux
-- resource_uri se terminant par '/' — sinon une ACL sur /tickets/37 s'appliquerait aussi à
-- /tickets/370. starts_with évite les wildcards LIKE (%/_ dans les IRI).
-- claim absent → current_setting(..., true) = NULL → aucun match → deny silencieux.

CREATE TABLE IF NOT EXISTS auth.acl (
  id bigserial PRIMARY KEY,
  resource_uri text NOT NULL,        -- IRI ressource ou conteneur (conteneur = slash final "/")
  subject text NOT NULL,             -- webid/did, 'role:xxx', ou 'foaf:Agent' (public)
  modes text[] NOT NULL,             -- read / write / append / control
  inherited boolean DEFAULT true,    -- n'a d'effet que si resource_uri se termine par '/'
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

-- Le PEP (rôle app) lit/écrit les ACL via *.acl ; la fonction est exécutée dans les policies RLS.
-- Changement d'ACL = révocation potentielle → pg_notify('fap_revoked') → le PDP purge son
-- cache de décision immédiatement (spec §7.5, CA-L9). Payload = resource_uri.
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
