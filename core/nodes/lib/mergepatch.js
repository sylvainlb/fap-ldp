// mergepatch.js — JSON Merge Patch (RFC 7386)
// - null deletes the key, arrays are replaced whole, objects merged recursively.
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function mergePatch(target, patch) {
  if (!isPlainObject(patch)) return patch; // full replacement (including null → handled by the caller)
  if (!isPlainObject(target)) target = {};
  const out = Object.assign({}, target);
  for (const key of Object.keys(patch)) {
    if (patch[key] === null) {
      delete out[key];
    } else {
      out[key] = mergePatch(out[key], patch[key]);
    }
  }
  return out;
}

module.exports = mergePatch;
