// pdp.js — PDP node (Policy Decision Point), spec fap-ldp v0.2 §7.1
// Uniform pipeline: step 1 DSP contract/capacity (TTL PT1H cache, purge on pg_notify
// 'fap_revoked') → step 2 ACL (auth.can via PG, session context set) → step 3
// ODRL obligations (facis:resourceId isAnyOf...) + dsp.audit audit.
// The node is called by the LDP container node (config.pdp): pdpNode.decide({...}).
const crypto = require('crypto');
const { createPool } = require('../lib/pgpool');

module.exports = function (RED) {
  function PdpNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.name = config.name;
    node.podOrg = config.podOrg || '';
    node.baseIri = (config.baseIri || 'http://localhost:1880/').replace(/\/?$/, '/');
    node.cacheTtlMs = parseInt(config.cacheTtlMs || '3600000', 10); // PT1H
    node.pool = createPool(config);
    node.cache = new Map(); // key: tokenHash|resource|mode → {decision, expiresAt}

    // Revocation (contract or ACL): pg_notify('fap_revoked') → immediate cache purge (AC-L9)
    (async () => {
      try {
        const c = await node.pool.connect();
        await c.query('LISTEN fap_revoked');
        c.on('notification', () => node.cache.clear());
        const keepalive = setInterval(() => c.query('SELECT 1').catch(() => {}), 30000);
        if (keepalive.unref) keepalive.unref();
        node.on('close', () => { clearInterval(keepalive); c.release(); });
      } catch (e) {
        node.error('LISTEN fap_revoked failed: ' + e.message);
      }
    })();
  }

  // claims: {webid, role, org, did}; resourceUri full IRI; containerPath e.g. '/tickets/'
  // mode: read|write|append|control; published: boolean from the mapping
  // → {allow, status, agreementId, obligations, reason}
  PdpNode.prototype.decide = async function ({ token, claims, resourceUri, containerPath, mode, published }) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const cacheKey = [tokenHash, resourceUri, mode].join('|');
    const hit = this.cache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) return hit.decision;

    const decision = await this._decide(tokenHash, claims, resourceUri, containerPath, mode, published);
    this.cache.set(cacheKey, { decision, expiresAt: Date.now() + this.cacheTtlMs });
    return decision;
  };

  PdpNode.prototype._decide = async function (tokenHash, claims, resourceUri, containerPath, mode, published) {
    const deny = (reason) => ({ allow: false, status: 403, reason });
    const isInternal = !!(claims.org && claims.org === this.podOrg);

    // --- step 0: unpublished container → invisible to externals (AC-L7)
    if (!published && !isInternal) return deny('container-not-published');

    // --- step 1: valid DSP contract / capacity for the asset
    let contract = null;
    const cap = await this.pool.query(
      `SELECT c.id, c.asset_uri, c.assignee_did, c.policy_jsonld, c.agreement_id
       FROM dsp.capacities cap JOIN dsp.contracts c ON c.id = cap.contract_id
       WHERE cap.token_hash = $1 AND cap.expires_at > now() AND c.state = 'active'`,
      [tokenHash]);
    if (cap.rows.length > 0) {
      contract = cap.rows[0];
    } else if (isInternal) {
      // internal-org "framework contract" issued on first request (asset = pod base IRI)
      const agreementId = 'cadre:' + claims.webid;
      const ins = await this.pool.query(
        `INSERT INTO dsp.contracts (asset_uri, assignee_did, policy_jsonld, state, agreement_id, expires_at)
         VALUES ($1, $2, '{}'::jsonb, 'active', $3, now() + interval '1 hour')
         ON CONFLICT (agreement_id) DO UPDATE SET state = 'active', expires_at = now() + interval '1 hour'
         RETURNING id, asset_uri, assignee_did, policy_jsonld, agreement_id`,
        [this.baseIri, claims.webid, agreementId]);
      contract = ins.rows[0];
      await this.pool.query(
        `INSERT INTO dsp.capacities (token_hash, contract_id, scopes, expires_at)
         VALUES ($1, $2, '["read","write"]'::jsonb, now() + interval '1 hour')
         ON CONFLICT (token_hash) DO UPDATE SET contract_id = $2, expires_at = now() + interval '1 hour'`,
        [tokenHash, contract.id]);
    } else if (claims.did) {
      // external: contract negotiated via the DSP catalog (core), asset = container
      const ext = await this.pool.query(
        `SELECT id, asset_uri, assignee_did, policy_jsonld, agreement_id FROM dsp.contracts
         WHERE assignee_did = $1 AND state = 'active'
           AND (asset_uri = $2 OR asset_uri = $3)
           AND (expires_at IS NULL OR expires_at > now())`,
        [claims.did, this.baseIri + containerPath.replace(/^\//, ''), this.baseIri]);
      if (ext.rows.length === 0) return deny('no-valid-contract');
      contract = ext.rows[0];
      await this.pool.query(
        `INSERT INTO dsp.capacities (token_hash, contract_id, scopes, expires_at)
         VALUES ($1, $2, '["read"]'::jsonb, now() + interval '1 hour')
         ON CONFLICT (token_hash) DO UPDATE SET contract_id = $2, expires_at = now() + interval '1 hour'`,
        [tokenHash, contract.id]);
    } else {
      return { allow: false, status: 401, reason: 'no-token-claims' };
    }

    // --- step 2: resource ACL (auth.can with session context, silent deny)
    const acl = await withAcl(this.pool, claims, this.baseIri, resourceUri, mode);
    if (!acl) {
      await this._audit(contract.agreement_id, claims.webid, resourceUri, mode, 'deny');
      return deny('acl-deny');
    }

    // --- step 3: contract ODRL obligations (v1: facis:resourceId isAnyOf/isAllOf)
    const obligations = await this._obligations(contract, resourceUri);
    if (!obligations.allow) {
      await this._audit(contract.agreement_id, claims.webid, resourceUri, mode, 'deny');
      return deny(obligations.reason);
    }
    await this._audit(contract.agreement_id, claims.webid, resourceUri, mode, 'allow');
    return { allow: true, status: 200, agreementId: contract.agreement_id, obligations: obligations.constraints };
  };

  // AC-L11: inline `permissions` key for the requester (solid-ac-checker compatibility of sib-core).
  // view=read(resource), add=write(container), change/delete=write(resource), control=control(resource).
  PdpNode.prototype.permissions = async function ({ claims, resourceUri, containerUri }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.base_iri', $1, true)", [this.baseIri]);
      const webid = claims.webid || claims.did;
      if (webid) await client.query("SELECT set_config('app.webid', $1, true)", [webid]);
      if (claims.role) await client.query("SELECT set_config('app.role', $1, true)", [claims.role]);
      const r = await client.query(
        `SELECT auth.can($1, 'read') AS view,
                auth.can($2, 'write') AS add,
                auth.can($1, 'write') AS change,
                auth.can($1, 'write') AS "delete",
                auth.can($1, 'control') AS control`,
        [resourceUri, containerUri]);
      await client.query('COMMIT');
      return r.rows[0];
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  };

  PdpNode.prototype._audit = function (agreementId, webid, resourceUri, mode, decision) {
    return this.pool.query(
      'INSERT INTO dsp.audit (agreement_id, webid, resource_uri, mode, decision) VALUES ($1,$2,$3,$4,$5)',
      [agreementId, webid, resourceUri, mode, decision]).catch(() => {});
  };

  // facis:resourceId isAnyOf [37,44,52] constraint → only those resources served (AC-L5)
  PdpNode.prototype._obligations = async function (contract, resourceUri) {
    let policy = contract.policy_jsonld;
    if (typeof policy === 'string') { try { policy = JSON.parse(policy); } catch { policy = {}; } }
    if (!policy || typeof policy !== 'object') return { allow: true, constraints: {} };
    const constraints = {};
    const perms = policy.permission || (Array.isArray(policy) ? policy : []);
    for (const p of perms) {
      const c = p.constraint || {};
      const left = c.leftOperand; // ex. 'facis:resourceId'
      if (left && String(left).endsWith('resourceId')) {
        const ids = c.isAnyOf || c.isAllOf;
        if (Array.isArray(ids) && ids.length > 0) {
          constraints.resourceId = ids.map(String);
          const id = resourceUri.split('/').filter(Boolean).pop();
          if (!ids.map(String).includes(id)) return { allow: false, reason: 'odrl-resourceId-filter', constraints };
        }
      }
    }
    return { allow: true, constraints };
  };

  async function withAcl(pool, claims, baseIri, resourceUri, mode) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.base_iri', $1, true)", [baseIri]);
      const webid = claims.webid || claims.did; // external: the DID is the ACL subject
      if (webid) await client.query("SELECT set_config('app.webid', $1, true)", [webid]);
      if (claims.role) await client.query("SELECT set_config('app.role', $1, true)", [claims.role]);
      const r = await client.query('SELECT auth.can($1, $2) AS ok', [resourceUri, mode]);
      await client.query('COMMIT');
      return r.rows[0].ok;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  RED.nodes.registerType('fap-ldp-pdp', PdpNode);
};
