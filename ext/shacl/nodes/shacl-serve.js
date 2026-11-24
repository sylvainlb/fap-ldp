// shacl-serve.js — fap-ldp-shacl-serve node (ext/shacl, E5, spec app-shape-editor rev 4 §3.3).
// Serves the published SHACL contracts and the read-only fragment views. The routes are
// reserved for this ext by the core route patch (A.2):
//   GET /shapes                     → core model contract (Turtle, JSON-LD admitted) + ETag  (F3.2/F3.4)
//   GET /shapes/                    → index of all sources (core + packages, all states)     (F3.6)
//   GET /fragment                   → core model.json + hash                                 (F3.5)
//   GET /apps/<slug>/shapes         → package contract (published tables only) + ETag        (F3.2/F3.3)
//   GET /apps/<slug>/fragment       → raw fragment + fragment_hash + state + supersedes     (F3.5)
// Read = any authenticated pod user (same as GET /apps/ in E11). No write path here:
// the write path stays SQL-only (spec §1); validation endpoints land in J3 (POST .../validate).
const { createPool } = require('./lib/pgpool-lite');
const { claimsFromRequest } = require('./lib/auth');
const { createStore } = require('./lib/store');

module.exports = function (RED) {
  function ShaclServeNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.baseIri = (config.baseIri || 'http://localhost:1880/').replace(/\/?$/, '/');
    node.pool = createPool(config); // read-only usage (SELECT app.app_packages / dsp.asset_mapping)
    node.devTokens = safeJson(config.devTokens);
    node.idpUserinfoUrl = (config.idpUserinfoUrl && config.idpUserinfoUrl !== 'false') ? config.idpUserinfoUrl : '';
    node.modelPath = config.modelPath || process.env.FAP_LDP_CONFIG || '/config/model.json';
    const store = createStore({ pool: node.pool, modelPath: node.modelPath });
    node.store = store; // shared with shacl-boot via context if co-located
    global.__fapShaclStore = global.__fapShaclStore || store;

    RED.httpNode.disable('etag'); // our ETags (W/"<hash>") are set explicitly

    RED.httpNode.use((req, res, next) => {
      const p = req.path;
      const mPkgShapes = p.match(/^\/apps\/([^/]+)\/shapes$/);
      const mPkgFragment = p.match(/^\/apps\/([^/]+)\/fragment$/);
      const isCoreShapes = p === '/shapes' || p === '/shapes/'; // '/shapes' contract, '/shapes/' index
      const isCoreFragment = p === '/fragment';
      if (req.method !== 'GET' && req.method !== 'HEAD') return next(); // POST validate = J3
      if (!mPkgShapes && !mPkgFragment && !isCoreShapes && !isCoreFragment) return next();
      handle(req, res, { mPkgShapes, mPkgFragment, isCoreShapes, isCoreFragment })
        .catch(e => {
          node.error(e.stack || e.message);
          if (!res.headersSent) sendError(res, 500, 'InternalError', e.message);
        });
    });

    node.on('close', async () => { await node.pool.end().catch(() => {}); });

    function safeJson(s) { try { return s ? JSON.parse(s) : {}; } catch { return {}; } }

    function sendError(res, status, code, message) {
      res.status(status).set('Content-Type', 'application/ld+json').json({
        '@context': { dspace: 'https://www.w3.org/ns/dspace#' },
        '@type': 'dspace:Error', code, message
      });
    }

    function wantsJsonLd(req) {
      const a = String(req.headers.accept || '');
      return /ld\+json|application\/json/.test(a) && !/text\/turtle/.test(a);
    }

    function sendContract(req, res, compiled, uri) {
      const etag = 'W/"' + compiled.hash + '"';
      if (String(req.headers['if-none-match'] || '') === etag) {
        return res.status(304).set('ETag', etag).end();
      }
      res.set('ETag', etag).set('Cache-Control', 'no-cache');
      if (wantsJsonLd(req)) {
        return res.status(200).set('Content-Type', 'application/ld+json').json(compiled.jsonld);
      }
      res.status(200)
        .set('Content-Type', 'text/turtle; charset=utf-8')
        .set('Link', `<${uri}>; rel="self"`)
        .send(compiled.turtle);
    }

    async function handle(req, res, route) {
      const { claims } = await claimsFromRequest(req, {
        devTokens: node.devTokens, idpUserinfoUrl: node.idpUserinfoUrl
      });
      if (!claims) {
        res.set('WWW-Authenticate', 'DPoP, Bearer');
        return sendError(res, 401, 'Unauthorized', 'authentication required');
      }

      // GET /shapes/ → source index (F3.6); GET /shapes → core contract (F3.4)
      if (route.isCoreShapes) {
        if (req.path === '/shapes/') {
          const idx = await store.index(node.baseIri);
          return res.status(200).set('Content-Type', 'application/ld+json').json({
            '@context': { ldp: 'http://www.w3.org/ns/ldp#' },
            '@id': node.baseIri + 'shapes/',
            '@type': ['ldp:Container'],
            sources: idx.sources
          });
        }
        const compiled = await store.contract('core', node.baseIri);
        if (!compiled) return sendError(res, 404, 'NotFound', 'no published table in the core model');
        return sendContract(req, res, compiled, node.baseIri + 'shapes');
      }

      if (route.isCoreFragment) { // F3.5
        const f = await store.fragmentOf('core');
        return res.status(200).set('Content-Type', 'application/json').json({
          kind: 'core', fragmentHash: f.fragmentHash, model: f.model
        });
      }

      const slug = (route.mPkgShapes || route.mPkgFragment)[1];
      if (route.mPkgFragment) { // F3.5
        const f = await store.fragmentOf(slug);
        if (!f) return sendError(res, 404, 'NotFound', `unknown package "${slug}"`);
        if (f.state === 'revoked') return sendError(res, 410, 'Gone', `package "${slug}" is revoked`);
        return res.status(200).set('Content-Type', 'application/json').json({
          kind: 'package', slug: f.slug, version: f.version, state: f.state,
          fragmentHash: f.fragmentHash, supersedes: f.supersedes, model: f.model
        });
      }

      // GET /apps/<slug>/shapes → package contract (published tables only, F3.3/F3.4)
      const compiled = await store.contract(slug, node.baseIri);
      if (!compiled) {
        const pkg = await store.loadPackage(slug);
        if (!pkg) return sendError(res, 404, 'NotFound', `unknown package "${slug}"`);
        if (pkg.state === 'revoked') return sendError(res, 410, 'Gone', `package "${slug}" is revoked`);
        return sendError(res, 404, 'NotFound', `package "${slug}" exposes no contract (no published table)`);
      }
      return sendContract(req, res, compiled, `${node.baseIri}apps/${slug}/shapes`);
    }
  }

  RED.nodes.registerType('fap-ldp-shacl-serve', ShaclServeNode);
};
