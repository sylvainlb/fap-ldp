// mi-admin.js — fap-ldp-mi-admin node (ext/model-injection, E11): admin endpoints of the
// injection contract (spec model-injection-spec.md v0.3 §3.1).
//   POST   /admin/apps            → install (one transaction, AC-B1/B2/B8)
//   DELETE /admin/apps/<slug>     → revocation (AC-B4), If-Match/ETag on the meta record
//   GET    /apps/                 → containers of installed packages (any authenticated user)
//   GET    /apps/<slug>/meta      → package record (version, contract, state) + ETag
// The LDP containers /apps/<slug>/<table>/ themselves are served by the core PEP via
// dsp.asset_mapping (the core reserves /admin/, /apps/ and /apps/<slug>/meta for this ext).
// v1: writes = admin role only (§3.2); JSON-LD dspace:Error errors (AC-B2).
const { createPool } = require('./lib/pgpool-lite');
const { claimsFromRequest } = require('./lib/auth');
const { installPackage, revokePackage, listPackages, packageMeta, HttpError } = require('./lib/installer');
const { FragmentError } = require('./lib/fragment');

module.exports = function (RED) {
  function MiAdminNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.baseIri = (config.baseIri || 'http://localhost:1880/').replace(/\/?$/, '/');
    node.pool = createPool(config); // admin role (DDL = migration)
    node.devTokens = safeJson(config.devTokens);
    node.idpUserinfoUrl = (config.idpUserinfoUrl && config.idpUserinfoUrl !== 'false') ? config.idpUserinfoUrl : '';
    node.maxPackages = parseInt(config.maxPackages, 10) || 50; // pod quota (§4.5, §9)

    RED.httpNode.disable('etag');

    RED.httpNode.use((req, res, next) => {
      const p = req.path;
      const isAdmin = p === '/admin/apps' || /^\/admin\/apps\/[^/]+$/.test(p);
      const isAppsList = p === '/apps' || p === '/apps/';
      const mMeta = p.match(/^\/apps\/([^/]+)\/meta$/);
      if (!isAdmin && !isAppsList && !mMeta) return next();
      handle(req, res, { isAdmin, isAppsList, slugMeta: mMeta && mMeta[1] }).catch(e => {
        node.error(e.stack || e.message);
        if (!res.headersSent) sendError(res, 500, 'InternalError', e.message);
      });
    });

    node.on('close', async () => { await node.pool.end().catch(() => {}); });

    function safeJson(s) { try { return s ? JSON.parse(s) : {}; } catch { return {}; } }

    async function ensureBody(req) {
      if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return;
      if (Buffer.isBuffer(req.body) || typeof req.body === 'string') {
        req.body = JSON.parse((req.body || '').toString() || '{}');
        return;
      }
      const ct = String(req.headers['content-type'] || '');
      if (!/json/.test(ct)) { req.body = {}; return; }
      await new Promise((ok, ko) => {
        let raw = '';
        req.on('data', c => { raw += c; });
        req.on('end', () => { try { req.body = raw ? JSON.parse(raw) : {}; ok(); } catch (e) { ko(e); } });
        req.on('error', ko);
      });
    }

    function sendError(res, status, code, message) {
      res.status(status).set('Content-Type', 'application/ld+json').json({
        '@context': { dspace: 'https://www.w3.org/ns/dspace#' },
        '@type': 'dspace:Error',
        'dspace:errorCode': code,
        'dspace:message': message
      });
    }

    function sendJsonLd(res, status, doc, headers) {
      res.status(status).set('Content-Type', 'application/ld+json');
      if (headers) for (const [k, v] of Object.entries(headers)) res.set(k, v);
      res.json(doc);
    }

    function etagOf(row) {
      const ts = row && row.installed_at ? new Date(row.installed_at).getTime() : Date.now();
      return 'W/"' + ts.toString(16) + '"';
    }

    async function handle(req, res, route) {
      const method = req.method === 'HEAD' ? 'GET' : req.method;
      await ensureBody(req);
      const { token, claims } = await claimsFromRequest(req, { devTokens: node.devTokens, idpUserinfoUrl: node.idpUserinfoUrl });
      if (!claims) {
        res.set('WWW-Authenticate', 'DPoP realm="fap-ldp", Bearer realm="fap-ldp"');
        return sendError(res, 401, 'Unauthorized', 'authentication required');
      }

      // ---------- GET /apps/ and GET /apps/<slug>/meta: any authenticated pod user (§3.1) ----------
      if (method === 'GET' && route.isAppsList) {
        const pkgs = await listPackages(node.pool);
        const members = pkgs.filter(p => p.state === 'installed')
          .map(p => ({ '@id': node.baseIri + 'apps/' + p.slug + '/' }));
        return sendJsonLd(res, 200, {
          '@context': { ldp: 'http://www.w3.org/ns/ldp#' },
          '@id': node.baseIri + 'apps/',
          '@type': ['ldp:BasicContainer', 'ldp:Container'],
          'ldp:contains': members
        });
      }
      if (method === 'GET' && route.slugMeta) {
        const meta = await packageMeta(node.pool, route.slugMeta);
        if (!meta) return sendError(res, 404, 'NotFound', `unknown package "${route.slugMeta}"`);
        const doc = {
          '@context': { dspace: 'https://www.w3.org/ns/dspace#' },
          '@id': node.baseIri + 'apps/' + meta.slug + '/meta',
          slug: meta.slug, version: meta.version, sri: meta.sri, state: meta.state,
          contract_id: meta.contract_id, installed_by: meta.installed_by,
          installed_at: meta.installed_at, revoked_at: meta.revoked_at,
          tables: meta.tables
        };
        return sendJsonLd(res, 200, doc, { ETag: etagOf(meta) });
      }

      // ---------- write: admin role only in v1 (§3.2) ----------
      if (claims.role !== 'admin') return sendError(res, 403, 'Forbidden', 'admin role required (v1, §3.2)');

      if (method === 'POST' && route.isAdmin && req.path === '/admin/apps') {
        const body = req.body || {};
        try {
          const out = await installPackage(node.pool, {
            slug: body.slug, version: body.version, sri: body.sri || null,
            meta: body.meta || {}, model_fragment: body.model_fragment,
            retention: body.retention || 'drop',
            webid: claims.webid || claims.did, baseIri: node.baseIri,
            maxPackages: node.maxPackages
          });
          res.set('Location', out.location);
          return sendJsonLd(res, 201, {
            '@context': { dspace: 'https://www.w3.org/ns/dspace#' },
            slug: out.slug, agreement_id: out.agreement_id, tables: out.tables, state: 'installed'
          });
        } catch (e) {
          if (e instanceof FragmentError) return sendError(res, 422, e.code, e.message);   // AC-B2
          if (e instanceof HttpError) return sendError(res, e.status, e.code, e.message);  // AC-B8 (409)
          throw e;
        }
      }

      if (method === 'DELETE' && route.isAdmin) {
        const slug = req.path.split('/').pop();
        const meta = await packageMeta(node.pool, slug);
        if (!meta) return sendError(res, 404, 'NotFound', `unknown package "${slug}"`);
        const etag = etagOf(meta);
        if (req.headers['if-match'] && req.headers['if-match'] !== etag && req.headers['if-match'] !== '*')
          return sendError(res, 412, 'PreconditionFailed', 'If-Match: stale ETag');
        try {
          await revokePackage(node.pool, slug, claims.webid || claims.did);
          return res.status(204).end();
        } catch (e) {
          if (e instanceof HttpError) return sendError(res, e.status, e.code, e.message);
          throw e;
        }
      }

      return sendError(res, 405, 'MethodNotAllowed', method);
    }
  }

  RED.nodes.registerType('fap-ldp-mi-admin', MiAdminNode);
};
