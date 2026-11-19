-- 005_rls.sql — RLS sur app.* (spec fap§app v0.2 §7.2)
-- Le PEP fait, dans la transaction : SET LOCAL app.webid / app.role / app.base_iri
-- depuis les claims du token (jamais depuis la query string).
-- FORCE ROW LEVEL SECURITY : même le owner des tables est filtré.
-- IRI de ressource construite depuis app.base_iri (base IRI du pod, ex. 'https://pod/',
-- slash final toléré : rtrim) :
--   /tickets/<id>, /tickets/<id>/comments/<id>, /users/<id>, /buildings/<id>
-- claim absent → auth.can = false → deny silencieux (rien n'est servi).

ALTER TABLE app.users     ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.buildings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tickets   ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.comments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.users     FORCE ROW LEVEL SECURITY;
ALTER TABLE app.buildings FORCE ROW LEVEL SECURITY;
ALTER TABLE app.tickets   FORCE ROW LEVEL SECURITY;
ALTER TABLE app.comments  FORCE ROW LEVEL SECURITY;

-- tickets : read sur la ressource, write sur le conteneur (INSERT) puis la ressource (UPDATE/DELETE)
-- RLS = autorisation pure (auth.can). Le filtrage des tombstones (deleted_at IS NULL) est fait
-- par le PEP dans ses requêtes, PAS ici : sur un UPDATE, PostgreSQL exige que la nouvelle ligne
-- satisfasse aussi le USING des policies SELECT, donc un filtre deleted_at ici bloquerait le
-- soft delete (UPDATE deleted_at = now()).
DROP POLICY IF EXISTS tickets_read ON app.tickets;
CREATE POLICY tickets_read ON app.tickets FOR SELECT
  USING (auth.can(rtrim(current_setting('app.base_iri', true), '/') || '/tickets/' || id::text, 'read'));
DROP POLICY IF EXISTS tickets_insert ON app.tickets;
CREATE POLICY tickets_insert ON app.tickets FOR INSERT
  WITH CHECK (auth.can(rtrim(current_setting('app.base_iri', true), '/') || '/tickets/', 'write'));
DROP POLICY IF EXISTS tickets_write ON app.tickets;
CREATE POLICY tickets_write ON app.tickets FOR UPDATE
  USING (auth.can(rtrim(current_setting('app.base_iri', true), '/') || '/tickets/' || id::text, 'write'))
  WITH CHECK (auth.can(rtrim(current_setting('app.base_iri', true), '/') || '/tickets/' || id::text, 'write'));
DROP POLICY IF EXISTS tickets_delete ON app.tickets;
CREATE POLICY tickets_delete ON app.tickets FOR DELETE
  USING (auth.can(rtrim(current_setting('app.base_iri', true), '/') || '/tickets/' || id::text, 'write'));

-- users / buildings
DROP POLICY IF EXISTS users_read ON app.users;
CREATE POLICY users_read ON app.users FOR SELECT
  USING (auth.can(rtrim(current_setting('app.base_iri', true), '/') || '/users/' || id::text, 'read'));
DROP POLICY IF EXISTS users_write ON app.users;
CREATE POLICY users_write ON app.users FOR ALL
  USING (auth.can(rtrim(current_setting('app.base_iri', true), '/') || '/users/' || id::text, 'write'))
  WITH CHECK (auth.can(rtrim(current_setting('app.base_iri', true), '/') || '/users/' || id::text, 'write'));

DROP POLICY IF EXISTS buildings_read ON app.buildings;
CREATE POLICY buildings_read ON app.buildings FOR SELECT
  USING (auth.can(rtrim(current_setting('app.base_iri', true), '/') || '/buildings/' || id::text, 'read'));
DROP POLICY IF EXISTS buildings_write ON app.buildings;
CREATE POLICY buildings_write ON app.buildings FOR ALL
  USING (auth.can(rtrim(current_setting('app.base_iri', true), '/') || '/buildings/' || id::text, 'write'))
  WITH CHECK (auth.can(rtrim(current_setting('app.base_iri', true), '/') || '/buildings/' || id::text, 'write'));

-- comments : IRI imbriquée /tickets/<tid>/comments/<cid>
DROP POLICY IF EXISTS comments_read ON app.comments;
CREATE POLICY comments_read ON app.comments FOR SELECT
  USING (auth.can(rtrim(current_setting('app.base_iri', true), '/') || '/tickets/' || ticket_id::text
                 || '/comments/' || id::text, 'read'));
DROP POLICY IF EXISTS comments_write ON app.comments;
CREATE POLICY comments_write ON app.comments FOR ALL
  USING (auth.can(rtrim(current_setting('app.base_iri', true), '/') || '/tickets/' || ticket_id::text
                 || '/comments/' || id::text, 'write'))
  WITH CHECK (auth.can(rtrim(current_setting('app.base_iri', true), '/') || '/tickets/' || ticket_id::text
                 || '/comments/' || id::text, 'write'));
