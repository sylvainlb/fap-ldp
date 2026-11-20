// mi-boot.js — nœud fap-ldp-mi-boot (ext/model-injection, E11) : application au boot des
// fragments de app.app_packages (state installed/drift), de façon idempotente, + détection
// de drift (CA-B7). Le nœud core fap-ldp-model applique config/model.json ; celui-ci applique
// les fragments injectés (tables app.store_<slug>_*), sans toucher au core (règle ext/).
// v2 : hot-reload à chaud via E12 (pg_notify sur app.app_packages).
const { createPool } = require('./lib/pgpool-lite');
const { applyFragmentsAtBoot } = require('./lib/installer');

module.exports = function (RED) {
  function MiBootNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.baseIri = (config.baseIri || 'http://localhost:1880/').replace(/\/?$/, '/');
    node.pool = createPool(config); // rôle admin (boot = migration)

    node.on('close', async () => { await node.pool.end().catch(() => {}); });

    applyFragmentsAtBoot(node.pool, node.baseIri, m => node.warn(m))
      .then(({ applied, drifted }) => {
        node.log(`fap-ldp ext/model-injection: fragments appliqués: ${applied.join(', ') || '(aucun)'}` +
          (drifted.length ? ` — DRIFT: ${drifted.join(', ')}` : ''));
        if (drifted.length) node.error(`DRIFT détecté sur: ${drifted.join(', ')} (état passé à 'drift', audit écrit)`);
      })
      .catch(e => node.error('boot model-injection failed: ' + (e.stack || e.message)));
  }

  RED.nodes.registerType('fap-ldp-mi-boot', MiBootNode);
};
