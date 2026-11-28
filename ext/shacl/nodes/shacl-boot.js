// shacl-boot.js — fap-ldp-shacl-boot node (ext/shacl): boot prewarm of published contracts
// (F3.1, C7) + cache invalidation on revocation (pg_notify fap_revoked, C2) and on core-model
// hot patch (pg_notify fap_core_model → store.reloadCore(), E11 POST /admin/model → GET /shapes
// serves the new contract without restart). Compilation itself is lazy (first GET compiles,
// cache keyed by fragment_hash); E11 emits no install event, so the boot only warms the cache,
// it never blocks serving.
const { createPool } = require('./lib/pgpool-lite');
const { createStore } = require('./lib/store');

module.exports = function (RED) {
  function ShaclBootNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.baseIri = (config.baseIri || 'http://localhost:1880/').replace(/\/?$/, '/');
    node.pool = createPool(config);
    node.modelPath = config.modelPath || process.env.FAP_LDP_CONFIG || '/config/model.json';
    const store = createStore({ pool: node.pool, modelPath: node.modelPath });
    global.__fapShaclStore = global.__fapShaclStore || store;

    node.on('close', async () => {
      if (listener) { try { listener.release(); } catch {} }
      await node.pool.end().catch(() => {});
    });

    let listener = null;

    (async () => {
      // revocation channel (same one E11 revocation triggers via dsp.contracts): drop the cache;
      // core-model hot patch (E11 POST /admin/model): purge the core:* entries only (reloadCore)
      listener = await node.pool.connect();
      listener.on('notification', (msg) => {
        if (msg && msg.channel === 'fap_core_model') store.reloadCore();
        else store.clearCache();
      });
      await listener.query('LISTEN fap_revoked');
      await listener.query('LISTEN fap_core_model');

      // prewarm (C7: demo deployment core + packages < 5 s)
      const t0 = Date.now();
      const warmed = [];
      try {
        const core = await store.contract('core', node.baseIri);
        if (core) warmed.push('core');
        for (const p of await store.listPackages()) {
          if (p.state === 'revoked') continue;
          const c = await store.contract(p.slug, node.baseIri);
          if (c) warmed.push(p.slug);
        }
        node.log(`fap-ldp ext/shacl: contracts prewarmed: ${warmed.join(', ') || '(none)'} in ${Date.now() - t0} ms`);
      } catch (e) {
        node.warn('ext/shacl prewarm failed (lazy compile still available): ' + e.message);
      }
    })().catch(e => node.error('ext/shacl boot failed: ' + (e.stack || e.message)));
  }

  RED.nodes.registerType('fap-ldp-shacl-boot', ShaclBootNode);
};
