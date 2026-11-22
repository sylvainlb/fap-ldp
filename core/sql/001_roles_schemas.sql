-- 001_roles_schemas.sql — PG roles and schemas of the FAP-LDP extension
-- Spec fap-ldp v0.2 §2 (principle 6) and §7.5. Idempotent. Run as admin (migrations).
--
-- The FAP core (bronze/silver/gold schemas, gate role) is installed by fap-light-serveur;
-- this file neither depends on it nor modifies it.

CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS dsp;

-- Group roles (NOLOGIN). Connection pool logins are created by the deployment
-- (compose/ via env vars) then attached: GRANT app TO <login_app>; etc.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gate')        THEN CREATE ROLE gate        NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app')         THEN CREATE ROLE app         NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'materializer') THEN CREATE ROLE materializer NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reader')      THEN CREATE ROLE reader      NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin')       THEN CREATE ROLE admin       NOLOGIN; END IF;
END $$;

-- Least privilege: PUBLIC gets nothing, not even read.
REVOKE ALL ON SCHEMA app, auth, dsp FROM PUBLIC;

-- Core schemas: same if present (the core already applies the same rule, guardrail here).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'bronze') THEN REVOKE ALL ON SCHEMA bronze FROM PUBLIC; END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'silver') THEN REVOKE ALL ON SCHEMA silver FROM PUBLIC; END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'gold')   THEN REVOKE ALL ON SCHEMA gold   FROM PUBLIC; END IF;
END $$;

-- Per-role rights on the extension schemas.
GRANT USAGE ON SCHEMA app, auth, dsp TO app;
GRANT USAGE ON SCHEMA auth, dsp TO reader;          -- catalog/contracts read (admin UI)
GRANT USAGE ON SCHEMA app TO materializer;          -- gold matviews joined app x sensors

-- Core schemas, if present: gate writes bronze only, reader/app read gold.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'bronze') THEN
    GRANT USAGE ON SCHEMA bronze TO gate;
    GRANT INSERT ON ALL TABLES IN SCHEMA bronze TO gate;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA bronze TO gate;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'gold') THEN
    GRANT USAGE ON SCHEMA gold TO app, reader, materializer;
    GRANT SELECT ON ALL TABLES IN SCHEMA gold TO app, reader;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'silver') THEN
    GRANT USAGE ON SCHEMA silver TO materializer;
  END IF;
END $$;

-- admin: migrations only, never at runtime → no GRANT here (owner of the objects created
-- by the migrations, which is enough for ALTER/DROP in future migrations).
