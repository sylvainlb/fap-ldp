// mergepatch.js — JSON Merge Patch (RFC 7386)
// - null supprime la clé, les tableaux sont remplacés entiers, les objets fusionnés récursivement.
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function mergePatch(target, patch) {
  if (!isPlainObject(patch)) return patch; // remplacement complet (y compris null → géré par l'appelant)
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
