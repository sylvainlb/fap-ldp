// jsonpatch.js — JSON Patch (RFC 6902) : add / remove / replace / move / copy / test
// Pointeurs JSON Pointer : /a/b/0, échappement ~0 (~) et ~1 (/).

function parsePointer(p) {
  if (p === '') return [];
  return p.split('/').slice(1).map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function getParent(doc, parts) {
  let cur = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur == null) throw new Error('json-patch: chemin invalide ' + parts.join('/'));
    cur = cur[parts[i]];
  }
  return { parent: cur, key: parts[parts.length - 1] };
}

function applyOp(doc, op) {
  const parts = parsePointer(op.path || '');
  switch (op.op) {
    case 'add': case 'replace': {
      const { parent, key } = getParent(doc, parts);
      if (Array.isArray(parent)) {
        const idx = key === '-' ? parent.length : parseInt(key, 10);
        if (op.op === 'add') parent.splice(idx, 0, op.value);
        else parent[idx] = op.value;
      } else {
        if (op.op === 'replace' && !(key in parent)) throw new Error('json-patch: replace sur clé absente ' + op.path);
        parent[key] = op.value;
      }
      return doc;
    }
    case 'remove': {
      const { parent, key } = getParent(doc, parts);
      if (Array.isArray(parent)) parent.splice(parseInt(key, 10), 1);
      else delete parent[key];
      return doc;
    }
    case 'move': {
      const from = parsePointer(op.from || '');
      const v = applyOp(structuredClone(doc), { op: 'remove', path: op.from });
      const val = get(v, from);
      return applyOp(doc, { op: 'add', path: op.path, value: val });
    }
    case 'copy': {
      const from = parsePointer(op.from || '');
      const val = get(doc, from);
      return applyOp(doc, { op: 'add', path: op.path, value: structuredClone(val) });
    }
    case 'test': {
      const val = get(doc, parts);
      if (JSON.stringify(val) !== JSON.stringify(op.value)) throw new Error('json-patch: test failed ' + op.path);
      return doc;
    }
    default:
      throw new Error('json-patch: op inconnue ' + op.op);
  }
}

function apply(doc, ops) {
  if (!Array.isArray(ops)) throw new Error('json-patch: le corps doit être un tableau d\'opérations');
  let out = structuredClone(doc);
  for (const op of ops) out = applyOp(out, op);
  return out;
}

module.exports = { apply, parsePointer };
