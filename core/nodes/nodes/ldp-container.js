// ldp-container.js — LDP container node (PEP), spec fap-ldp v0.2 §6
// Registers a middleware on RED.httpNode (ORCE's HTTP server, behind caddy on 443).
// Routes: GET/POST/PUT/DELETE/PATCH on resources & containers, GET/PUT <res>.acl,
// ETag (W/"...") + If-Match/If-None-Match (412/304), PATCH = JSON Merge Patch (RFC 7386),
// JSON-LD dspace:Error errors, 401 + WWW-Authenticate if unauthenticated, 403 if unauthorized.
// Container ↔ table mapping via dsp.asset_mapping; session context set per transaction
// (SET LOCAL app.webid/role/base_iri) → RLS filters rows.
const crypto = require('crypto');
const { createPool, withSession } = require('../lib/pgpool');
const jsonld = require('../lib/jsonld');
const webacl = require('../lib/webacl');
const mergePatch = require('../lib/mergepatch');
const jsonPatch = require('../lib/jsonpatch');
const vc = require('../lib/vc');

module.exports = function (RED) {
  function LdpContainerNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.baseIri = (config.baseIri || 'http://localhost:1880/').replace(/\/?$/, '/');
    // decision K (v0.4, AC-L15): business rules (transitions) declared in the deployment's model
    try {
      const modelPath = config.modelPath || process.env.FAP_LDP_CONFIG || '/config/model.json';
      node.businessRules = (JSON.parse(require('fs').readFileSync(modelPath, 'utf8')).business_rules) || [];
    } catch (e) { node.businessRules = []; }
    node.podOrg = config.podOrg || '';
    node.catalogPath = config.catalogPath || '/dsp/catalogue';
    node.pool = createPool(config);
    // Gold reads via the reader role if configured (least privilege, spec §7.5), otherwise same pool
    node.poolRead = config.pgReaderUser
      ? createPool({ ...config, pgUser: config.pgReaderUser, pgPassword: config.pgReaderPassword || config.pgPassword })
      : node.pool;
    node.pdp = RED.nodes.getNode(config.pdp);
    node.devTokens = safeJson(config.devTokens); // test/TCK only: token → claims
    // "false"/empty (IDP_EXTERNAL=false in compose) = no external IdP configured
    node.idpUserinfoUrl = (config.idpUserinfoUrl && config.idpUserinfoUrl !== 'false') ? config.idpUserinfoUrl : '';
    node.vcTrustAnchors = safeJson(config.vcTrustAnchors || '[]');   // trusted did:web prefixes (spec §7.6)
    node.vcDidDocs = safeJson(config.vcDidDocs || '{}');             // test override: did → DID document (public JWK key)
    node.goldMaxRows = parseInt(config.goldMaxRows, 10) || 10000; // decision G: gold volume guard
    node.mappings = null;      // cache dsp.asset_mapping
    node.mappingsAt = 0;
    node.columns = {};         // column cache per schema.table

    if (!node.pdp) { node.error('PDP node not configured'); return; }

    RED.httpNode.disable('etag'); // our LDP ETags (W/"...") are set explicitly, not the express hash

    RED.httpNode.use((req, res, next) => {
      if (req.path.startsWith('/dsp/') || req.path.startsWith('/app/') || req.path.startsWith('/red') || req.path.startsWith('/editor')) return next(); // /app/ = signed POST /app/query proxy (C1.9/D-8) + static front served by caddy
      // Reserved for ext/model-injection (E11): admin endpoints + package listing/meta.
      // The LDP containers /apps/<slug>/<table>/ remain served here via dsp.asset_mapping.
      if (req.path.startsWith('/admin/')
          || /^\/apps\/?$/.test(req.path)
          || /^\/apps\/[^/]+\/meta$/.test(req.path)) return next();
      // Reserved for ext/shacl (E5, spec app-shape-editor rev 4, A.2): published SHACL contracts,
      // fragment read (source of truth), source index (+ tables[] registry and per-object
      // shapes /shapes/<table>, /apps/<slug>/shapes/<table>, chantier 3 rev 8), external validation.
      // Same nature and scope as the E11 reservation above (C5): pure route reservation,
      // no behavior of the LDP path changes. Table names colliding with these segments
      // (meta, shapes, validate, fragment) are rejected at injection time (annexe A v0.4).
      if (/^\/shapes(?:\/[^/]+)?\/?$/.test(req.path)
          || /^\/fragment$/.test(req.path)
          || /^\/shacl\/preview$/.test(req.path)
          || /^\/apps\/[^/]+\/(shapes(?:\/[^/]+)?|validate|fragment)$/.test(req.path)
          || /^\/apps\/[^/]+\/[^/]+\/validate$/.test(req.path)) return next();
      handle(req, res).catch(e => {
        node.error(e.stack || e.message);
        if (!res.headersSent) sendError(res, 500, 'InternalError', e.message);
      });
    });

    node.on('close', async () => {
      await node.pool.end().catch(() => {});
      if (node.poolRead !== node.pool) await node.poolRead.end().catch(() => {});
    });

    function poolFor(mapping) {
      return mapping.table_schema === 'gold' ? node.poolRead : node.pool;
    }

    // ---------- helpers ----------

    function safeJson(s) { try { return s ? JSON.parse(s) : {}; } catch { return {}; } }

    // JSON body: Node-RED sets req.body to a Buffer/string for application/*+json depending on
    // config; we normalize here (do not depend on the global body-parser).
    function ensureBody(req) {
      if (Buffer.isBuffer(req.body)) {
        try { req.body = JSON.parse(req.body.toString('utf8')); } catch (e) { return Promise.reject(e); }
        return Promise.resolve();
      }
      if (typeof req.body === 'string') {
        try { req.body = req.body ? JSON.parse(req.body) : {}; } catch (e) { return Promise.reject(e); }
        return Promise.resolve();
      }
      if (req.body && typeof req.body === 'object') return Promise.resolve();
      const ct = String(req.headers['content-type'] || '');
      if (!/json/.test(ct)) return Promise.resolve();
      return new Promise((resolveBody, reject) => {
        let raw = '';
        req.on('data', c => { raw += c; });
        req.on('end', () => {
          try { req.body = raw ? JSON.parse(raw) : {}; } catch (e) { return reject(e); }
          resolveBody();
        });
        req.on('error', reject);
      });
    }

    function asJson(req) {
      if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
      try { return JSON.parse(String(req.body || '{}')); } catch { return {}; }
    }

    function sendError(res, status, code, message) {
      res.status(status)
        .set('Content-Type', 'application/ld+json')
        .json(jsonld.errorDoc(code, message));
    }

    function sendJsonLd(res, status, doc, headers) {
      res.status(status).set('Content-Type', 'application/ld+json');
      if (headers) for (const [k, v] of Object.entries(headers)) res.set(k, v);
      res.json(doc);
    }

    async function getMappings() {
      if (node.mappings && Date.now() - node.mappingsAt < 60000) return node.mappings;
      const r = await node.pool.query(
        'SELECT asset_uri, container_uri, table_schema, table_name, resource_iri_pattern, time_column, published FROM dsp.asset_mapping');
      node.mappings = r.rows.map(m => ({
        ...m,
        containerRe: new RegExp('^' + m.container_uri.replace(/\*/g, '[^/]+') + '$'),
        resourceRe: m.resource_iri_pattern
          ? new RegExp('^' + m.resource_iri_pattern.replace(/<[^>]+>/g, '([^/]+)') + '$')
          : null,
        resourceParams: m.resource_iri_pattern
          ? (m.resource_iri_pattern.match(/<[^>]+>/g) || []).map(s => s.slice(1, -1))
          : []
      }));
      node.mappingsAt = Date.now();
      return node.mappings;
    }

    async function tableColumns(schema, table) {
      const key = schema + '.' + table;
      if (node.columns[key]) return node.columns[key];
      const r = await node.pool.query(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`, [schema, table]);
      node.columns[key] = r.rows;
      return r.rows;
    }

    // path → {kind: 'root'|'container'|'resource'|'acl', mapping?, params?, resourcePath, containerPath, pkValues}
    async function resolve(p) {
      if (p === '/' || p === '') return { kind: 'root', resourcePath: '/', containerPath: '/' };
      let path = p;
      let isAcl = false;
      if (path.endsWith('.acl')) { isAcl = true; path = path.slice(0, -4); }
      const mappings = await getMappings();
      if (path.endsWith('/')) {
        for (const m of mappings) {
          if (m.containerRe.test(path)) {
            const params = {};
            const segs = path.slice(1, -1).split('/');
            // e.g. /tickets/*/comments/ → parent_fk param (1st pattern placeholder) = segs[starIdx]
            const starIdx = m.container_uri.slice(1, -1).split('/').indexOf('*');
            if (starIdx >= 0 && segs[starIdx] !== undefined && m.resourceParams[0]) {
              params[m.resourceParams[0]] = segs[starIdx];
            }
            return { kind: 'container', mapping: m, params, resourcePath: path, containerPath: path, isAcl };
          }
        }
        // trailing-slash tolerance (AC-L12, decision J): /tickets/482/ ≡ /tickets/482
        path = path.slice(0, -1);
      }
      // resource: longest matching container prefix
      for (const m of [...mappings].sort((a, b) => b.container_uri.length - a.container_uri.length)) {
        if (m.resourceRe && m.resourceRe.test(path)) {
          const values = path.match(m.resourceRe).slice(1);
          const params = {};
          m.resourceParams.forEach((name, i) => { params[name] = values[i]; });
          const containerPath = path.slice(0, path.lastIndexOf('/') + 1);
          return { kind: 'resource', mapping: m, params, resourcePath: path, containerPath, isAcl };
        }
      }
      return { kind: 'notfound', resourcePath: path, isAcl };
    }

    async function claimsFromRequest(req) {
      const h = req.headers['authorization'] || '';
      const m = h.match(/^(?:Bearer|DPoP)\s+(.+)$/i);
      if (!m) return { token: null, claims: null };
      const token = m[1].trim();
      // VC in JWT form (spec §7.6): cryptographically verified if it is one, 401 if invalid
      try {
        const vcClaims = await vc.verifyVc(token, { trustAnchors: node.vcTrustAnchors, didDocOverrides: node.vcDidDocs });
        if (vcClaims) return { token, claims: vcClaims };
      } catch (e) {
        return { token, claims: null, vcError: e.message };
      }
      if (node.devTokens[token]) return { token, claims: node.devTokens[token] }; // test/TCK
      if (node.idpUserinfoUrl) {
        const r = await fetch(node.idpUserinfoUrl, { headers: { Authorization: 'Bearer ' + token } });
        if (!r.ok) return { token, claims: null };
        const info = await r.json();
        return { token, claims: { webid: info.webid, role: info.role, org: info.org, did: info.did } };
      }
      return { token, claims: null };
    }

    function etagOf(row) {
      const ts = row && row.updated_at ? new Date(row.updated_at).getTime() : Date.now();
      return 'W/"' + ts.toString(16) + '"';
    }

    // ---------- dispatch ----------

    async function handle(req, res) {
      const method = req.method === 'HEAD' ? 'GET' : req.method;
      await ensureBody(req);
      const parsed = await resolve(req.path);

      // root: root container, members = published containers only (spec §6.5)
      if (parsed.kind === 'root') {
        if (method !== 'GET') return sendError(res, 405, 'MethodNotAllowed', method);
        const { token, claims } = await claimsFromRequest(req);
        if (!claims) return sendError(res, 401, 'Unauthorized', 'token required');
        const mappings = await getMappings();
        const published = mappings.filter(m => m.published).map(m => node.baseIri + m.container_uri.replace(/^\//, ''));
        const doc = jsonld.containerDoc(node.baseIri, '/', published);
        doc.permissions = await node.pdp.permissions({ claims, resourceUri: node.baseIri, containerUri: node.baseIri }).catch(() => null);
        res.set('Link', '<' + node.catalogPath + '>; rel="catalog"');
        return sendJsonLd(res, 200, doc);
      }

      if (parsed.kind === 'notfound') return sendError(res, 404, 'NotFound', req.path);
      if (!parsed.mapping) return sendError(res, 404, 'NotFound', req.path);

      const { token, claims, vcError } = await claimsFromRequest(req);
      if (!claims) {
        res.set('WWW-Authenticate', 'DPoP realm="fap-ldp", Bearer realm="fap-ldp"');
        return sendError(res, 401, 'Unauthorized', vcError || 'authentication required');
      }

      const m = parsed.mapping;
      const resourceUri = parsed.isAcl
        ? node.baseIri + parsed.resourcePath.replace(/^\//, '')
        : node.baseIri + parsed.resourcePath.replace(/^\//, '');
      const aclUri = resourceUri + '.acl';

      // ACL mode: GET/HEAD → read; POST → write (container); PUT/PATCH/DELETE → write (resource)
      // .acl GET/PUT → control on the target resource
      let mode;
      if (parsed.isAcl) mode = 'control';
      else if (method === 'GET') mode = 'read';
      else mode = 'write';
      const decisionTarget = parsed.isAcl ? resourceUri : resourceUri;

      const decision = await node.pdp.decide({
        token, claims,
        resourceUri: decisionTarget,
        containerPath: parsed.containerPath,
        mode,
        published: m.published
      });
      if (!decision.allow) return sendError(res, decision.status || 403, 'Forbidden', decision.reason);

      // AC-L11 (decision J): inline `permissions` key computed for the requester
      const perms = await node.pdp.permissions({
        claims,
        resourceUri: decisionTarget,
        containerUri: node.baseIri + parsed.containerPath.replace(/^\//, '')
      }).catch(() => null);
      parsed.perms = perms;

      const headers = {
        Link: '<' + aclUri + '>; rel="acl", <http://www.w3.org/ns/ldp#Resource>; rel="type"'
      };

      if (parsed.isAcl) return handleAcl(req, res, method, parsed, claims, headers);
      if (parsed.kind === 'container') return handleContainer(req, res, method, parsed, claims, headers);
      return handleResource(req, res, method, parsed, claims, headers);
    }

    // ---------- containers ----------

    async function handleContainer(req, res, method, parsed, claims, headers) {
      const m = parsed.mapping;
      if (method === 'GET') {
        // decision G (spec §6.7): a large gold container is NOT served as raw LDP
        if (m.table_schema === 'gold' && node.goldMaxRows) {
          const cnt = await withSession(poolFor(m), claims, node.baseIri, async client =>
            (await client.query(`SELECT count(*)::int AS n FROM ${m.table_schema}.${m.table_name}`)).rows[0].n);
          if (cnt > node.goldMaxRows) {
            return sendError(res, 403, 'GoldContainerTooLarge',
              `large gold container (${cnt} rows): read via the DSP data plane (/dsp/data, from/to, LIMIT 5000) — spec §6.7`);
          }
        }
        const rows = await withSession(poolFor(m), claims, node.baseIri, async client => {
          let q = `SELECT to_jsonb(t) AS doc FROM ${m.table_schema}.${m.table_name} t`;
          const cond = [];
          if (await hasColumn(m.table_schema, m.table_name, 'deleted_at')) cond.push('t.deleted_at IS NULL');
          if (m.container_uri.includes('*')) {
            // nested container e.g. /tickets/37/comments/ → filter on the param
            cond.push(`t.${Object.keys(parsed.params)[0]} = $1`);
            q += ' WHERE ' + cond.join(' AND ');
            return (await client.query(q, [Object.values(parsed.params)[0]])).rows;
          }
          if (cond.length) q += ' WHERE ' + cond.join(' AND ');
          const pk = pkColumn(m);   // last placeholder of resource_iri_pattern (gold matviews without an id column)
          q += ` ORDER BY t.${pk} LIMIT 5000`;
          return (await client.query(q)).rows;
        });
        const members = rows.map(r => node.baseIri + (m.resource_iri_pattern || m.container_uri + '<id>')
          .replace(/^\//, '')
          .replace(/<[^>]+>/g, (ph) => {
            const name = ph.slice(1, -1);
            if (parsed.params[name] !== undefined) return parsed.params[name];
            return r.doc[name] !== undefined ? r.doc[name] : r.doc[pk];
          }));
        const doc = jsonld.containerDoc(node.baseIri, parsed.containerPath, members);
        if (parsed.perms) doc.permissions = parsed.perms;
        res.set('Link', headers.Link);
        return sendJsonLd(res, 200, doc);
      }
      if (method === 'POST') {
        const body = asJson(req);
        const row = jsonld.docToRow(body, m.table_schema, m.table_name);
        const cols = await tableColumns(m.table_schema, m.table_name);
        const names = Object.keys(row).filter(k => cols.some(c => c.column_name === k));
        if (names.length === 0) return sendError(res, 400, 'BadRequest', 'no known column');
        // decision K (AC-L15): on_create rule (e.g. status OPEN reserved for the manager role)
        const brErr = validateTransition(node.businessRules, m.table_name, {}, row, claims);
        if (brErr) return sendError(res, 409, 'invalid_transition', brErr);
        const pk = pkColumn(m);
        const result = await withSession(poolFor(m), claims, node.baseIri, async client => {
          const q = `INSERT INTO ${m.table_schema}.${m.table_name} (${names.join(',')})
                     VALUES (${names.map((_, i) => '$' + (i + 1)).join(',')})
                     RETURNING to_jsonb(${m.table_name}.*) AS doc`;
          const r = (await client.query(q, names.map(n => row[n]))).rows[0];
          // Initial ACL: the creator gets control (and read/write) on its resource (spec §7.3)
          const iri = node.baseIri + m.container_uri.replace(/^\//, '') + r.doc[pk];
          if (claims.webid) {
            await client.query(
              `INSERT INTO auth.acl (resource_uri, subject, modes, inherited)
               VALUES ($1, $2, '{read,write,control}', false)`, [iri, claims.webid]);
          }
          return r;
        });
        const iri = node.baseIri + m.container_uri.replace(/^\//, '') + result.doc[pk];
        res.set('Location', iri);
        res.set('Link', headers.Link);
        return sendJsonLd(res, 201, jsonld.resourceDoc(node.baseIri, parsed.containerPath, m.table_schema, m.table_name, result.doc, pk), { ETag: etagOf(result.doc) });
      }
      return sendError(res, 405, 'MethodNotAllowed', method);
    }

    // ---------- resources ----------

    async function handleResource(req, res, method, parsed, claims, headers) {
      const m = parsed.mapping;
      const pk = pkColumn(m);
      const pkWhere = m.resourceParams.map((name, i) => `${name === 'id' ? 'id' : name} = $${i + 1}`).join(' AND ');
      const pkValues = m.resourceParams.map(n => parsed.params[n]);
      const sel = `SELECT to_jsonb(t.*) AS doc FROM ${m.table_schema}.${m.table_name} t WHERE ${pkWhere}`;
      const hasDeleted = await hasColumn(m.table_schema, m.table_name, 'deleted_at');

      if (method === 'GET') {
        const row = await withSession(poolFor(m), claims, node.baseIri, async client => {
          const q = hasDeleted ? sel + ' AND t.deleted_at IS NULL' : sel;
          const r = await client.query(q, pkValues);
          return r.rows[0];
        });
        if (!row) return sendError(res, 404, 'NotFound', parsed.resourcePath);
        const etag = etagOf(row.doc);
        if (req.headers['if-none-match'] === etag) {
          res.status(304).set('ETag', etag).end();
          return;
        }
        res.set('ETag', etag);
        res.set('Link', headers.Link);
        const doc = jsonld.resourceDoc(node.baseIri, parsed.containerPath, m.table_schema, m.table_name, row.doc, pk);
        if (parsed.perms) doc.permissions = parsed.perms;
        return sendJsonLd(res, 200, doc);
      }

      // PUT / PATCH / DELETE: If-Match → 412 if ETag is stale (AC-L10)
      const current = await withSession(poolFor(m), claims, node.baseIri, async client => {
        const q = hasDeleted ? sel + ' AND t.deleted_at IS NULL' : sel;
        return (await client.query(q, pkValues)).rows[0];
      });
      if (!current) return sendError(res, 404, 'NotFound', parsed.resourcePath);
      const etag = etagOf(current.doc);
      if (req.headers['if-match'] && req.headers['if-match'] !== etag && req.headers['if-match'] !== '*') {
        return sendError(res, 412, 'PreconditionFailed', 'If-Match: stale ETag');
      }

      if (method === 'DELETE') {
        if (!hasDeleted) return sendError(res, 405, 'MethodNotAllowed', 'DELETE (table without tombstone)');
        await withSession(poolFor(m), claims, node.baseIri, async client => {
          await client.query(`UPDATE ${m.table_schema}.${m.table_name} SET deleted_at = now() WHERE ${pkWhere} AND deleted_at IS NULL`, pkValues);
        });
        res.status(204).set('Link', headers.Link).end();
        return;
      }

      if (method === 'PUT' || method === 'PATCH') {
        let nextDoc = current.doc;
        if (method === 'PUT') {
          const body = asJson(req);
          const row = jsonld.docToRow(body, m.table_schema, m.table_name);
          nextDoc = { ...current.doc, ...row };
        } else {
          // PATCH v1 accepts JSON Merge Patch (RFC 7386) AND JSON Patch (RFC 6902) — decision F (AC-L10)
          res.set('Accept-Patch', 'application/merge-patch+json, application/json-patch+json');
          const ct = String(req.headers['content-type'] || '');
          const body = asJson(req);
          const ld = jsonld.resourceDoc(node.baseIri, parsed.containerPath, m.table_schema, m.table_name, current.doc, pk);
          const patched = /json-patch/.test(ct) ? jsonPatch.apply(ld, body) : mergePatch(ld, body);
          const row = jsonld.docToRow(patched, m.table_schema, m.table_name);
          nextDoc = { ...current.doc, ...row };
        }
        delete nextDoc.deleted_at;
        // decision K (AC-L15): invalid status transition → 409 invalid_transition
        const brErr = validateTransition(node.businessRules, m.table_name, current.doc, nextDoc, claims);
        if (brErr) return sendError(res, 409, 'invalid_transition', brErr);
        const cols = await tableColumns(m.table_schema, m.table_name);
        const names = Object.keys(nextDoc).filter(k => k !== pk && cols.some(c => c.column_name === k));
        // WHERE placeholders shifted after the SET ones
        const off = names.length;
        const where = m.resourceParams.map((n, i) => `${n} = $${off + i + 1}`).join(' AND ');
        await withSession(poolFor(m), claims, node.baseIri, async client => {
          const q = `UPDATE ${m.table_schema}.${m.table_name} SET ${names.map((n, i) => `${n} = $${i + 1}`).join(',')}
                     WHERE ${where} RETURNING to_jsonb(${m.table_name}.*) AS doc`;
          return client.query(q, [...names.map(n => nextDoc[n]), ...pkValues]);
        });
        const updated = await withSession(poolFor(m), claims, node.baseIri, async client => {
          return (await client.query(sel, pkValues)).rows[0];
        });
        res.set('ETag', etagOf(updated.doc));
        res.set('Link', headers.Link);
        const doc = jsonld.resourceDoc(node.baseIri, parsed.containerPath, m.table_schema, m.table_name, updated.doc, pk);
        if (parsed.perms) doc.permissions = parsed.perms;
        return sendJsonLd(res, 200, doc);
      }
      return sendError(res, 405, 'MethodNotAllowed', method);
    }

    // ---------- .acl ----------

    async function handleAcl(req, res, method, parsed, claims, headers) {
      const resourceUri = node.baseIri + parsed.resourcePath.replace(/^\//, '');
      if (method === 'GET') {
        const rows = await withSession(node.pool, claims, node.baseIri, async client => {
          return (await client.query('SELECT resource_uri, subject, modes, inherited FROM auth.acl WHERE resource_uri = $1', [resourceUri])).rows;
        });
        return sendJsonLd(res, 200, webacl.serialize(resourceUri, rows));
      }
      if (method === 'PUT') {
        const body = asJson(req);
        const rows = webacl.parse(body, resourceUri);
        await withSession(node.pool, claims, node.baseIri, async client => {
          await client.query('DELETE FROM auth.acl WHERE resource_uri = $1', [resourceUri]);
          for (const r of rows) {
            await client.query(
              'INSERT INTO auth.acl (resource_uri, subject, modes, inherited) VALUES ($1,$2,$3,$4)',
              [r.resource_uri, r.subject, r.modes, r.inherited]);
          }
        });
        // purge PDP cache (the ACL changed) — the PG trigger already notifies, double safety
        node.pdp.cache.clear();
        return sendJsonLd(res, 200, webacl.serialize(resourceUri, rows));
      }
      return sendError(res, 405, 'MethodNotAllowed', method);
    }

    // ---------- utils ----------

    function pkColumn(m) {
      const ph = (m.resource_iri_pattern.match(/<[^>]+>/g) || ['<id>']);
      return ph[ph.length - 1].slice(1, -1);
    }
    async function hasColumn(schema, table, col) {
      const cols = await tableColumns(schema, table);
      return cols.some(c => c.column_name === col);
    }
    function stripContext(doc, m) {
      const out = {};
      for (const [k, v] of Object.entries(doc)) if (!k.startsWith('@')) out[k] = v;
      return out;
    }
  }

  // decision K: transition matrix declared in config/model.json (business_rules)
  function validateTransition(rules, table, oldDoc, newDoc, claims) {
    for (const r of (rules || [])) {
      if (r.table !== table || !r.field) continue;
      const f = r.field, oldV = oldDoc[f], newV = newDoc[f];
      if (newV === undefined || newV === oldV) continue;
      const role = claims.role || '';
      const userPk = parseInt(String(claims.webid || '').split('/').filter(Boolean).pop(), 10);
      const isAssigned = oldDoc.assigned_to === userPk || newDoc.assigned_to === userPk;
      const okRole = (arr) => Array.isArray(arr) && arr.some(x => x === role || (x === 'assigned_to' && isAssigned));
      if (oldV === undefined || oldV === null) {
        const oc = r.on_create && r.on_create[newV];
        if (!oc || !okRole(oc)) return 'creation: status ' + newV + ' not allowed for role ' + (role || '?');
      } else {
        const t = r.transitions && r.transitions[oldV] && r.transitions[oldV][newV];
        if (!t || !okRole(t)) return 'forbidden transition: ' + oldV + ' → ' + newV;
      }
    }
    return null;
  }

  RED.nodes.registerType('fap-ldp-container', LdpContainerNode);
};
