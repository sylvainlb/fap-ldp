-- 000_model_injection.sql — ext/model-injection (E11, spec atlas/spec/model-injection-spec.md v0.3)
-- Table of installed packages (deployment state). Run as the admin role, BEFORE the
-- fap-ldp-model node (and before the fap-ldp-mi-boot node): solves the boot chicken-and-egg
-- (the node reads app.app_packages to merge the fragments at boot).
--
-- Documented implementation addition: `revoked_at` (absent from spec §2) is required to
-- bound the 30-day purge after revocation (§6); the `state` CHECK includes 'drift' (§5: drift
-- detection sets the state to 'drift' + alarm — spec §2 listed only installed/revoked).

CREATE TABLE IF NOT EXISTS app.app_packages (
  slug text PRIMARY KEY CHECK (slug ~ '^[a-z][a-z0-9_]{1,30}$'),
  version text NOT NULL,                          -- pinned, no ^
  sri text,                                       -- SHA-384; NULL accepted in v1 (manifest hash, §8)
  model_fragment jsonb NOT NULL,                  -- validated fragment (annex A of the spec)
  fragment_hash text NOT NULL,                    -- sha256 of the canonical fragment (drift detection, §5)
  contract_id text REFERENCES dsp.contracts(agreement_id),
  state text NOT NULL DEFAULT 'installed'
    CHECK (state IN ('installed','revoked','drift')),
  installed_by text NOT NULL,                     -- webid of the installing admin
  installed_at timestamptz DEFAULT now(),
  revoked_at timestamptz                          -- set by DELETE /admin/apps/<slug> (§6)
);

-- Derived-prefix uniqueness (anti-collision, spec §2/§3.3): two distinct slugs cannot
-- share a table prefix (identifiers are always created as quoted lowercase, N4).
CREATE UNIQUE INDEX IF NOT EXISTS app_packages_prefix_uidx
  ON app.app_packages (('store_' || slug || '_'));

CREATE INDEX IF NOT EXISTS app_packages_state_idx ON app.app_packages (state);

-- Least privilege: PUBLIC gets nothing. Boot and the admin endpoint run as the admin role
-- (migrations/DDL); the runtime app role can read the state (useful to the PEP/TCK).
GRANT SELECT ON app.app_packages TO app;
GRANT USAGE ON SCHEMA app TO admin; -- admin owns the migration objects; explicit grant for runtime read
