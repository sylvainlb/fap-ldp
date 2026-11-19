-- 001_roles_schemas.sql — rôles PG et schémas de l'extension FAP-LDP
-- Spec fap§app v0.2 §2 (principe 6) et §7.5. Idempotent. Exécuter en tant que admin (migrations).
--
-- Le cœur FAP (schémas bronze/silver/gold, rôle gate) est installé par fap-light-serveur ;
-- ce fichier n'en dépend pas et ne le modifie pas.

CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS dsp;

-- Rôles groupe (NOLOGIN). Les logins des pools de connexions sont créés par le déploiement
-- (compose/ via variables d'env) puis rattachés : GRANT app TO <login_app>; etc.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gate')        THEN CREATE ROLE gate        NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app')         THEN CREATE ROLE app         NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'materializer') THEN CREATE ROLE materializer NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reader')      THEN CREATE ROLE reader      NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin')       THEN CREATE ROLE admin       NOLOGIN; END IF;
END $$;

-- Moindre privilège : PUBLIC n'a rien, même en lecture.
REVOKE ALL ON SCHEMA app, auth, dsp FROM PUBLIC;

-- Schémas du cœur : idem si présents (le cœur applique déjà la même règle, garde-fou ici).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname IN ('bronze','silver','gold')) THEN
    REVOKE ALL ON SCHEMA bronze, silver, gold FROM PUBLIC;
  END IF;
END $$;

-- Droits par rôle sur les schémas de l'extension.
GRANT USAGE ON SCHEMA app, auth, dsp TO app;
GRANT USAGE ON SCHEMA auth, dsp TO reader;          -- lecture catalogue/contrats (admin UI)
GRANT USAGE ON SCHEMA app TO materializer;          -- matviews gold jointes app x capteurs

-- Schémas du cœur, si présents : gate écrit bronze uniquement, reader/app lisent gold.
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

-- admin : migrations uniquement, jamais en runtime → aucun GRANT ici (owner des objets créés
-- par les migrations, ce qui suffit pour ALTER/DROP dans les migrations futures).
