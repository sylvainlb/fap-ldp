// jsonpatch.js — JSON Patch (RFC 6902): add / remove / replace / move / copy / test
// JSON Pointer pointers: /a/b/0, escaping ~0 (~) and ~1 (/).

function parsePointer(p) {
  if (p === '') return [];
  return p.split('/').slice(1).map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function getParent(doc, parts) {
  let cur = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur == null) throw new Error('json-patch: invalid path ' + parts.join('/'));
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
        if (op.op === 'replace' && !(key in parent)) throw new Error('json-patch: replace on missing key ' + op.path);
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
      throw new Error('json-patch: unknown op ' + op.op);
  }
}

function apply(doc, ops) {
  if (!Array.isArray(ops)) throw new Error('json-patch: body must be an array of operations');
  let out = structuredClone(doc);
  for (const op of ops) out = applyOp(out, op);
  return out;
}

module.exports = { apply, parsePointer };
