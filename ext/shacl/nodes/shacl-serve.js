// shacl-serve.js — fap-ldp-shacl-serve node (ext/shacl, E5, spec app-shape-editor rev 4 §3.3).
// Serves the published SHACL contracts and the read-only fragment views. The routes are
// reserved for this ext by the core route patch (A.2):
//   GET /shapes                     → core model contract (Turtle, JSON-LD admitted) + ETag  (F3.2/F3.4)
//   GET /shapes/                    → index of all sources (core + packages, all states), each
//                                     with tables[] = registry of objects (all tables + flag) (F3.6, ws 3 rev 8)
//   GET /shapes/<table>             → single object shape, JSON-LD, reg:published embedded, 404 unknown
//   GET /fragment                   → core model.json + hash                                 (F3.5)
//   GET /apps/<slug>/shapes         → package contract (published tables only) + ETag        (F3.2/F3.3)
//   GET /apps/<slug>/shapes/<table> → single object shape of a package (reg:published, 404)   (ws 3 rev 8)
//   GET /apps/<slug>/fragment       → raw fragment + fragment_hash + state + supersedes     (F3.5)
// Read = any authenticated pod user (same as GET /apps/ in E11). No write path here:
// the write path stays SQL-only (spec §1); validation endpoints land in J3 (POST .../validate).
const { createPool } = require('./lib/pgpool-lite');
const { claimsFromRequest } = require('./lib/auth');
const { createStore } = require('./lib/store');
const { validate } = require('./lib/validate');

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
      const mPkgShape = p.match(/^\/apps\/([^/]+)\/shapes\/([^/]+)$/);
      const mCoreShape = p.match(/^\/shapes\/([^/]+)$/);
      const mPkgFragment = p.match(/^\/apps\/([^/]+)\/fragment$/);
      const mPkgValidate = p.match(/^\/apps\/([^/]+)\/validate$/);
      const mTblValidate = p.match(/^\/apps\/([^/]+)\/([^/]+)\/validate$/);
      const isPreview = p === '/shacl/preview';
      const isCoreShapes = p === '/shapes' || p === '/shapes/'; // '/shapes' contract, '/shapes/' index
      const isCoreFragment = p === '/fragment';
      if (req.method === 'POST' && isPreview) {
        handlePreview(req, res)
          .catch(e => {
            node.error(e.stack || e.message);
            if (!res.headersSent) sendError(res, 500, 'InternalError', e.message);
          });
        return;
      }
      if (req.method === 'POST' && (mPkgValidate || mTblValidate)) {
        const slug = (mPkgValidate || mTblValidate)[1];
        const table = mTblValidate ? mTblValidate[2] : null;
        handleValidate(req, res, slug, table)
          .catch(e => {
            node.error(e.stack || e.message);
            if (!res.headersSent) sendError(res, 500, 'InternalError', e.message);
          });
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (!mPkgShapes && !mPkgFragment && !isCoreShapes && !isCoreFragment && !mPkgShape && !mCoreShape) return next();
      handle(req, res, { mPkgShapes, mPkgShape, mCoreShape, mPkgFragment, isCoreShapes, isCoreFragment })
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

    // Content negotiation (F3.2): Turtle when explicitly requested, JSON-LD otherwise —
    // workstream 3 (app-ui-editor) fetches the contract with a plain res.json().
    function wantsTurtle(req) {
      const a = String(req.headers.accept || '');
      if (!a || a === '*/*') return false; // default → JSON-LD (workstream 3 reader)
      if (/text\/turtle/.test(a) && !/json/.test(a)) return true;
      return false;
    }

    function sendContract(req, res, compiled, uri) {
      const etag = 'W/"' + compiled.hash + '"';
      if (String(req.headers['if-none-match'] || '') === etag) {
        return res.status(304).set('ETag', etag).end();
      }
      res.set('ETag', etag).set('Cache-Control', 'no-cache');
      if (!wantsTurtle(req)) {
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

      // GET /shapes/<table> (core) / GET /apps/<slug>/shapes/<table> (package) — workstream 3 rev 8:
      // 1 shape = 1 JSON = 1 object type, with reg:published embedded; 404 unknown table.
      if (route.mCoreShape || route.mPkgShape) {
        const kind = route.mCoreShape ? 'core' : route.mPkgShape[1];
        const table = route.mCoreShape ? route.mCoreShape[1] : route.mPkgShape[2];
        const shape = await store.shapeOf(kind, table, node.baseIri);
        if (!shape) {
          if (kind !== 'core') {
            const pkg = await store.loadPackage(kind);
            if (pkg && pkg.state === 'revoked') return sendError(res, 410, 'Gone', `package "${kind}" is revoked`);
          }
          return sendError(res, 404, 'NotFound', `unknown object "${table}"`);
        }
        return res.status(200).set('Content-Type', 'application/ld+json').json({
          '@context': {
            sh: 'http://www.w3.org/ns/shacl#',
            rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
            xsd: 'http://www.w3.org/2001/XMLSchema#',
            reg: `${node.baseIri}ns/reg#`
          },
          ...shape
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

    // POST /apps/<slug>/validate (+ /<table>/validate) — F4.1: RDF body in, W3C report out.
    // Read-only: no write, no authority on the internal path. When the fragment carries a FK
    // toward users, both graphs are loaded: package contract + core contract (F4.1).
    async function handleValidate(req, res, slug, table) {
      const { claims } = await claimsFromRequest(req, {
        devTokens: node.devTokens, idpUserinfoUrl: node.idpUserinfoUrl
      });
      if (!claims) {
        res.set('WWW-Authenticate', 'DPoP, Bearer');
        return sendError(res, 401, 'Unauthorized', 'authentication required');
      }
      const body = await readJsonBody(req);
      if (!body || typeof body !== 'object') {
        return sendError(res, 400, 'BadRequest', 'body must be an RDF/JSON-LD document');
      }
      const pkg = await store.loadPackage(slug);
      if (!pkg) return sendError(res, 404, 'NotFound', `unknown package "${slug}"`);
      if (pkg.state === 'revoked') return sendError(res, 410, 'Gone', `package "${slug}" is revoked`);
      const compiled = await store.contract(slug, node.baseIri);
      if (!compiled) return sendError(res, 404, 'NotFound', `package "${slug}" exposes no contract (no published table)`);

      let shapes = compiled.shapes;
      const needsCore = shapes.some(s => s.properties.some(p => p.class));
      if (needsCore) {
        const core = await store.contract('core', node.baseIri);
        if (core) shapes = [...core.shapes, ...shapes];
      }
      const tableShapeIri = table ? `${node.baseIri}ns/app/store_${slug}_${table}#Shape` : null;
      if (table && !shapes.some(s => s.iri === tableShapeIri)) {
        return sendError(res, 404, 'NotFound', `no published table "${table}" in package "${slug}"`);
      }
      const report = validate(body, shapes, { tableShapeIri });
      return res.status(200).set('Content-Type', 'application/ld+json').json(report);
    }

    // POST /shacl/preview — compile a DRAFT fragment without persisting anything (screen 4 of the
    // editor: live contract preview + diff + optional sample validation). Body:
    // { fragment, slug? , publishedTables?, data? } → { hash, turtle, report? }
    async function handlePreview(req, res) {
      const { claims } = await claimsFromRequest(req, {
        devTokens: node.devTokens, idpUserinfoUrl: node.idpUserinfoUrl
      });
      if (!claims) {
        res.set('WWW-Authenticate', 'DPoP, Bearer');
        return sendError(res, 401, 'Unauthorized', 'authentication required');
      }
      const body = await readJsonBody(req);
      if (!body || !body.fragment || typeof body.fragment !== 'object') {
        return sendError(res, 400, 'BadRequest', 'body must be { fragment, slug?, data? }');
      }
      const { compile } = require('./lib/compiler');
      const compiled = compile({
        fragment: body.fragment,
        baseIri: node.baseIri,
        slug: body.slug || null,
        published: body.publishedTables ? new Set(body.publishedTables) : null
      });
      const out = { hash: compiled.hash, turtle: compiled.turtle };
      if (body.data) out.report = validate(body.data, compiled.shapes);
      return res.status(200).set('Content-Type', 'application/ld+json').json(out);
    }

    async function readJsonBody(req) {
      if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
      let raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
      if (!raw) {
        await new Promise((ok, ko) => {
          let acc = '';
          req.on('data', c => { acc += c; });
          req.on('end', () => { raw = acc; ok(); });
          req.on('error', ko);
        });
      }
      try { return raw ? JSON.parse(raw) : null; } catch { return null; }
    }
  }

  RED.nodes.registerType('fap-ldp-shacl-serve', ShaclServeNode);
};
