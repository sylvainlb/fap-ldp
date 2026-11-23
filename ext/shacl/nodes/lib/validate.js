// validate.js — ext/shacl J3: external validation endpoint engine (F4.1).
// Validates an RDF/JSON-LD data graph against the COMPILED contract model (the same model the
// compiler emits), covering exactly the SHACL Core subset the compiler produces:
// sh:path, sh:datatype, sh:minCount, sh:in, sh:nodeKind, sh:class, sh:targetClass.
// Read-only: no write, no authority on the internal write path (spec §1, F4.1).
// Report = W3C SHACL validation results graph, JSON-LD (sh:ValidationReport).
const SH = 'http://www.w3.org/ns/shacl#';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

// ---------- minimal JSON-LD term expansion (prefix map from the doc's @context) ----------
function prefixMap(doc) {
  const ctx = doc['@context'] || {};
  const map = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (typeof v === 'string' && /^[a-z][a-z0-9+.-]*:/i.test(v)) map[k.toLowerCase()] = v;
  }
  // well-known prefixes always available
  Object.assign(map, {
    sh: SH, xsd: XSD, rdf: RDF, rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
    ldp: 'http://www.w3.org/ns/ldp#', dspace: 'https://www.w3.org/ns/dspace#'
  });
  return map;
}

function expand(term, map) {
  if (typeof term !== 'string') return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(term)) return term; // already an IRI
  const m = term.match(/^([A-Za-z][A-Za-z0-9_]*):(.+)$/); // prefix names may contain _ (app_tickets, app_store_flotte_vehicules)
  if (m && map[m[1].toLowerCase()]) return map[m[1].toLowerCase()] + m[2];
  return null; // keyword or unmapped term — not a property IRI
}

// ---------- data graph normalization ----------
// → nodes: [{ id, types:Set, props: Map<propIri, values[]> }]
// value: { kind:'iri', iri } | { kind:'literal', value, datatype, lang }
function toNodes(doc) {
  const map = prefixMap(doc);
  let raw = doc['@graph'] || (Array.isArray(doc) ? doc : [doc]);
  const nodes = [];
  const byId = new Map();
  function nodeFor(id) {
    if (!byId.has(id)) { const n = { id, types: new Set(), props: new Map() }; byId.set(id, n); nodes.push(n); }
    return byId.get(id);
  }
  function addValue(node, piri, v) {
    if (v === null || v === undefined) return; // JSON-LD null = property absent (SQL NULL)
    if (!node.props.has(piri)) node.props.set(piri, []);
    node.props.get(piri).push(v);
  }
  function readValue(v) {
    if (v === null || v === undefined) return null;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (v['@id']) return { kind: 'iri', iri: v['@id'] };
      return {
        kind: 'literal',
        value: v['@value'],
        datatype: v['@type'] ? expand(v['@type'], map) : undefined,
        lang: v['@language'] || undefined
      };
    }
    if (typeof v === 'boolean') return { kind: 'literal', value: v, datatype: XSD + 'boolean' };
    if (typeof v === 'number') return { kind: 'literal', value: v, datatype: XSD + (Number.isInteger(v) ? 'integer' : 'decimal') };
    return { kind: 'literal', value: v, datatype: XSD + 'string' };
  }
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const id = item['@id'] || '_:b' + nodes.length;
    const node = nodeFor(id);
    const types = item['@type'] ? (Array.isArray(item['@type']) ? item['@type'] : [item['@type']]) : [];
    for (const t of types) { const e = expand(t, map); if (e) node.types.add(e); }
    for (const [k, v] of Object.entries(item)) {
      if (k.startsWith('@')) continue;
      const piri = expand(k, map);
      if (!piri) continue;
      for (const val of Array.isArray(v) ? v : [v]) addValue(node, piri, readValue(val));
    }
  }
  return { nodes, byId };
}

// ---------- SHACL Core subset evaluation ----------
const ISO_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

// the compiler emits datatypes in prefixed form (xsd:string, rdf:langString) — expand for comparison
const DT_PREFIXES = { xsd: XSD, rdf: RDF, sh: SH, rdfs: 'http://www.w3.org/2000/01/rdf-schema#' };
function expandDt(dt) {
  const m = String(dt).match(/^([A-Za-z][A-Za-z0-9_]*):(.+)$/);
  if (m && DT_PREFIXES[m[1].toLowerCase()]) return DT_PREFIXES[m[1].toLowerCase()] + m[2];
  return dt;
}

function datatypeOk(dt, value) {
  if (!dt) return true;
  if (dt === RDF + 'langString') return value.lang != null;
  if (value.lang) return false;
  switch (dt) {
    case XSD + 'string': return typeof value.value === 'string';
    case XSD + 'integer': return Number.isInteger(value.value) || /^-?\d+$/.test(String(value.value));
    case XSD + 'decimal': case XSD + 'double': return typeof value.value === 'number' || /^-?\d+(\.\d+)?$/.test(String(value.value));
    case XSD + 'boolean': return typeof value.value === 'boolean' || ['true', 'false'].includes(String(value.value));
    case XSD + 'dateTime': return typeof value.value === 'string' && ISO_DT.test(value.value);
    default: return true;
  }
}

// shapes: compiled model (array of shape objects from compiler.compile().shapes)
// opts: { tableShapeIri? (per-table endpoint), classIndex?: Map<classIri→Set<typeIri>> }
function validate(dataDoc, shapes, opts = {}) {
  const { nodes, byId } = toNodes(dataDoc);
  const results = [];
  const only = opts.tableShapeIri || null;

  for (const shape of shapes) {
    if (only && shape.iri !== only) continue;
    const focus = nodes.filter(n => n.types.has(shape.targetClass));
    for (const p of shape.properties) {
      for (const f of focus) {
        const values = f.props.get(p.path) || [];
        if (p.minCount && values.length < p.minCount) {
          results.push(result(f.id, p.iri, 'sh:MinCountConstraintComponent',
            `Property ${p.path} requires at least ${p.minCount} value(s), found ${values.length}.`, null));
        }
        for (const v of values) {
          if (p.datatype && v.kind === 'literal' && !datatypeOk(expandDt(p.datatype), v)) {
            results.push(result(f.id, p.iri, 'sh:DatatypeConstraintComponent',
              `Value ${JSON.stringify(v.value)} does not match datatype ${expandDt(p.datatype)}.`, v));
          }
          if (p.nodeKind === 'sh:IRI' && v.kind !== 'iri') {
            results.push(result(f.id, p.iri, 'sh:NodeKindConstraintComponent',
              `Value ${JSON.stringify(v.value)} must be an IRI.`, v));
          }
          if (p.in && v.kind === 'literal' && !p.in.includes(String(v.value))) {
            results.push(result(f.id, p.iri, 'sh:InConstraintComponent',
              `Value ${JSON.stringify(v.value)} not in (${p.in.join(', ')}).`, v));
          }
          if (p.class && v.kind === 'iri') {
            const target = byId.get(v.iri);
            const classShape = shapes.find(s => s.iri === p.class);
            if (classShape && target && !target.types.has(classShape.targetClass)) {
              results.push(result(f.id, p.iri, 'sh:ClassConstraintComponent',
                `Value <${v.iri}> is not of class <${classShape.targetClass}>.`, v));
            }
          }
        }
      }
    }
  }
  return report(results);
}

function result(focus, shape, component, message, value) {
  const r = {
    '@type': 'sh:ValidationResult',
    'sh:focusNode': focus.startsWith('_:') ? { '@id': focus } : { '@id': focus },
    'sh:sourceShape': { '@id': shape },
    'sh:sourceConstraintComponent': { '@id': SH + component.replace('sh:', '') },
    'sh:resultMessage': message
  };
  if (value) r['sh:value'] = value.kind === 'iri' ? { '@id': value.iri } : { '@value': value.value };
  return r;
}

function report(results) {
  return {
    '@context': { sh: SH, xsd: XSD, rdf: RDF, rdfs: 'http://www.w3.org/2000/01/rdf-schema#' },
    '@type': 'sh:ValidationReport',
    'sh:conforms': results.length === 0,
    'sh:result': results
  };
}

module.exports = { validate };
