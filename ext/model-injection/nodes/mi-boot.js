// mi-boot.js — fap-ldp-mi-boot node (ext/model-injection, E11): applies at boot the
// fragments of app.app_packages (state installed/drift), idempotently, + drift detection
// (AC-B7). The core fap-ldp-model node applies config/model.json; this one applies the
// injected fragments (tables app.store_<slug>_*), without touching the core (ext/ rule).
// v2: hot-reload via E12 (pg_notify on app.app_packages).
const { createPool } = require('./lib/pgpool-lite');
const { applyFragmentsAtBoot } = require('./lib/installer');

module.exports = function (RED) {
  function MiBootNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.baseIri = (config.baseIri || 'http://localhost:1880/').replace(/\/?$/, '/');
    node.pool = createPool(config); // admin role (boot = migration)

    node.on('close', async () => { await node.pool.end().catch(() => {}); });

    applyFragmentsAtBoot(node.pool, node.baseIri, m => node.warn(m))
      .then(({ applied, drifted }) => {
        node.log(`fap-ldp ext/model-injection: fragments applied: ${applied.join(', ') || '(none)'}` +
          (drifted.length ? ` — DRIFT: ${drifted.join(', ')}` : ''));
        if (drifted.length) node.error(`DRIFT detected on: ${drifted.join(', ')} (state set to 'drift', audit written)`);
      })
      .catch(e => node.error('boot model-injection failed: ' + (e.stack || e.message)));
  }

  RED.nodes.registerType('fap-ldp-mi-boot', MiBootNode);
};
