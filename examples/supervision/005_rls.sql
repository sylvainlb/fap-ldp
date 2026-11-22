-- 005_rls.sql — RLS on app.* (spec fap-ldp v0.2 §7.2)
-- The PEP sets, inside the transaction: SET LOCAL app.webid / app.role / app.base_iri
-- from the token claims (never from the query string).
-- FORCE ROW LEVEL SECURITY: even the table owner is filtered.
-- Resource IRI built from app.base_iri (pod base IRI, e.g. 'https://pod/',
-- trailing slash tolerated: rtrim):
--   /tickets/<id>, /tickets/<id>/comments/<id>, /users/<id>, /buildings/<id>
-- missing claim → auth.can = false → silent deny (nothing is served).

ALTER TABLE app.users     ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.buildings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tickets   ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.comments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.users     FORCE ROW LEVEL SECURITY;
ALTER TABLE app.buildings FORCE ROW LEVEL SECURITY;
ALTER TABLE app.tickets   FORCE ROW LEVEL SECURITY;
ALTER TABLE app.comments  FORCE ROW LEVEL SECURITY;

-- tickets: read on the resource, write on the container (INSERT) then the resource (UPDATE/DELETE)
-- RLS = pure authorization (auth.can). Tombstone filtering (deleted_at IS NULL) is done
-- by the PEP in its queries, NOT here: on UPDATE, PostgreSQL requires the new row
-- to also satisfy the USING of the SELECT policies, so a deleted_at filter here would block
-- the soft delete (UPDATE deleted_at = now()).
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

-- comments: nested IRI /tickets/<tid>/comments/<cid>
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
