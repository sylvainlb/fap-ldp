// compiler.js — ext/shacl: pure compiler model fragment → SHACL graph (spec app-shape-editor
// rev 4, §3.2). Deterministic and idempotent (F2.3): same fragment → same bytes → same sha256.
// IRIs are computed on the PHYSICAL PG table name (R1.2/R1.3): core tables app.<table> →
// ${base}/ns/app/<table>#<field> ; E11 packages app.store_<slug>_<table> →
// ${base}/ns/app/store_<slug>_<table>#<field> — identical to the served JSON-LD context
// (core/nodes/lib/jsonld.js contextFor uses schema + '_' + physical table).
// Never emits sh:closed (F2.5): the served JSON-LD includes service columns excluded here (R1.4).
const crypto = require('crypto');

const SERVICE_FIELDS = new Set(['id', 'created_at', 'updated_at', 'deleted_at']);

// Fixed prefix map for align / align_class values (spec §3.1 examples: geo:lat, foaf:mbox…).
// Deterministic: same input → same expansion → same bytes (F2.3).
const PREFIXES = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  owl: 'http://www.w3.org/2002/07/owl#',
  skos: 'http://www.w3.org/2004/02/skos/core#',
  dcterms: 'http://purl.org/dc/terms/',
  foaf: 'http://xmlns.com/foaf/0.1/',
  geo: 'http://www.w3.org/2003/01/geo/wgs84_pos#',
  schema: 'https://schema.org/',
  sosa: 'http://www.w3.org/ns/sosa/',
  qudt: 'http://qudt.org/schema/qudt/',
  saref: 'https://saref.etsi.org/core/'
};

function expandIri(v) {
  const m = String(v).match(/^([a-z][a-z0-9]*):(.+)$/i);
  if (m && PREFIXES[m[1].toLowerCase()]) return PREFIXES[m[1].toLowerCase()] + m[2];
  return String(v); // already a full IRI
}
const XSD = {
  text: 'xsd:string',
  bigint: 'xsd:integer',
  'double precision': 'xsd:double', // core model.json dialect
  numeric: 'xsd:decimal',
  boolean: 'xsd:boolean',
  timestamptz: 'xsd:dateTime'
  // jsonb: intentionally unmapped in v1 (F2.1) — the DSL does not constrain its content
};

function esc(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}

function labelOf(labelI18n, fallback) {
  return (labelI18n && labelI18n.en) || fallback; // R1.1: pivot English
}

function camel(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// Core model.json dialect: fields are SQL-ish strings ("text not null",
// "text default 'OPEN' check in ('OPEN','CLOSED')", "bigint fk users(id)", "bigserial").
// E11 fragments (appendix A v0.4) use structured objects. normalizeField accepts both.
function parseCoreField(def) {
  if (typeof def !== 'string') return def; // already structured (appendix A)
  let d = def.trim();
  const out = {};
  const chk = d.match(/^(.*?)\bcheck\s+in\s*\((.*)\)$/i);
  if (chk) {
    d = chk[1].trim();
    out.check_in = chk[2].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  }
  const fk = d.match(/^(\S+)\s+\bfk\s+(\w+)\((\w+)\)$/i);
  if (fk) { out.type = fk[1]; out.fk = fk[2]; }
  else {
    const dp = d.match(/^(double\s+precision)\b/i);
    const defM = d.match(/^(\S+)\s+default\s+(.+)$/i);
    if (dp) { out.type = 'double precision'; d = d.slice(dp[1].length).trim(); }
    else if (defM) { out.type = defM[1]; d = defM[2].trim(); } // default: not compiled (R1.5)
    else { out.type = d.split(/\s+/)[0]; d = d.split(/\s+/).slice(1).join(' '); }
    if (/\bnot\s+null\b/i.test(d)) out.not_null = true;
    if (/\bunique\b/i.test(d)) out.unique = true;
    if (/\bbigserial\b/i.test(out.type)) { out.type = 'bigint'; out.serial = true; }
  }
  return out;
}

function normalizeTable(spec) {
  // returns a table spec whose fields are all structured objects
  const fields = {};
  for (const [f, def] of Object.entries(spec.fields || {})) fields[f] = parseCoreField(def);
  return { ...spec, fields };
}

function labelsOf(labelI18n) {
  if (!labelI18n) return [];
  const keys = Object.keys(labelI18n).sort((a, b) => (a === 'en' ? -1 : b === 'en' ? 1 : a.localeCompare(b)));
  return keys.map(k => ({ value: String(labelI18n[k]), lang: k }));
}

// opts: { fragment, baseIri, slug (null = core model.json), published (Set of logical table
// names exposed, from dsp.asset_mapping; null = all tables) }
function compile(opts) {
  const { fragment, baseIri, slug } = opts;
  const published = opts.published || null;
  const shapes = [];
  for (const t of Object.keys(fragment.tables || {}).sort()) {
    if (published && !published.has(t)) continue; // F3.3/F3.4: unpublished tables have no contract
    const table = normalizeTable(fragment.tables[t]);
    const phys = slug ? `store_${slug}_${t}` : t;
    const ns = `${baseIri}ns/app/${phys}#`;
    const exclude = new Set([...SERVICE_FIELDS, ...(table.contract_exclude || [])]); // R1.4
    const shape = {
      iri: ns + 'Shape',
      // R1.3: default class IRI = the namespace itself (trailing '#', empty local part) — the
      // form expected by workstream 3 contract.js. The served @type is ns#Camel(phys); the
      // validator accepts both forms when matching focus nodes (rev 4.1).
      targetClass: table.align_class ? expandIri(table.align_class) : ns,
      name: labelOf(table.label_i18n, t),
      labels: labelsOf(table.label_i18n),
      properties: []
    };
    for (const f of Object.keys(table.fields || {}).sort()) {
      const fd = table.fields[f];
      if (exclude.has(f)) continue;
      if (fd.type === 'jsonb') continue; // F2.1: omitted in v1, documented in README non-mappings
      // F2.1 (rev 4.1): a FK compiles to its served form (xsd:integer) unless the field is
      // explicitly annotated node_kind: "iri" — then sh:nodeKind sh:IRI + sh:class on the
      // target table's shape (core users shape for E11 packages; same-contract table for core)
      const iriRef = fd.node_kind === 'iri';
      const fkTarget = fd.fk ? (slug ? 'users' : fd.fk) : null; // E11: fk enum = users only (core table)
      const prop = {
        iri: ns + f + 'Property',
        path: fd.align ? expandIri(fd.align) : (ns + f), // R1.2: align wins, else local convention IRI
        name: labelOf(fd.label_i18n, f),
        labels: labelsOf(fd.label_i18n),
        datatype: fd.lang === true ? 'rdf:langString' : XSD[fd.type], // F2.1
        minCount: fd.not_null ? 1 : null, // F2.1: not null → sh:minCount 1
        in: Array.isArray(fd.check_in) && fd.check_in.length ? fd.check_in.slice() : null, // sh:in, original order (workstream 3); sorted only in Turtle output
        nodeKind: iriRef ? 'sh:IRI' : null,
        // workstream 3 contract.js expects sh:class = the target CLASS IRI (trailing '#'),
        // e.g. https://<pod>/ns/app/users# — not the shape IRI
        class: (iriRef && fkTarget) ? `${baseIri}ns/app/${fkTarget}#` : null
      };
      shape.properties.push(prop);
    }
    shapes.push(shape);
  }
  const turtle = toTurtle(shapes);
  const hash = crypto.createHash('sha256').update(turtle, 'utf8').digest('hex'); // F2.3
  // the compiled graph carries the @id of ITS OWN contract (core /shapes, package
  // /apps/<slug>/shapes) — a package contract must not claim the core contract IRI
  const contractIri = slug ? `${baseIri}apps/${slug}/shapes` : `${baseIri}shapes`;
  return { turtle, hash, shapes, jsonld: toJsonLd(shapes, contractIri) };
}

function toTurtle(shapes) {
  const out = [
    '@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .',
    '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
    '@prefix sh: <http://www.w3.org/ns/shacl#> .',
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    ''
  ];
  for (const s of shapes) {
    out.push(`<${s.iri}> a sh:NodeShape ;`);
    out.push(`    sh:targetClass <${s.targetClass}> ;`);
    out.push(`    sh:name ${esc(s.name)} ;`);
    for (const l of s.labels) out.push(`    rdfs:label ${esc(l.value)}@${l.lang} ;`);
    for (const p of s.properties) out.push(`    sh:property <${p.iri}> ;`);
    out.push('    .');
    out.push('');
  }
  for (const s of shapes) {
    for (const p of s.properties) {
      out.push(`<${p.iri}> a sh:PropertyShape ;`);
      out.push(`    sh:path <${p.path}> ;`);
      out.push(`    sh:name ${esc(p.name)} ;`);
      for (const l of p.labels) out.push(`    rdfs:label ${esc(l.value)}@${l.lang} ;`);
      if (p.datatype) out.push(`    sh:datatype ${p.datatype} ;`);
      if (p.minCount) out.push(`    sh:minCount ${p.minCount} ;`);
      if (p.in) out.push(`    sh:in ( ${p.in.slice().sort().map(esc).join(' ')} ) ;`); // sorted here → canonical Turtle
      if (p.nodeKind) out.push(`    sh:nodeKind ${p.nodeKind} ;`);
      if (p.class) out.push(`    sh:class <${p.class}> ;`);
      out.push('    .');
      out.push('');
    }
  }
  return out.join('\n');
}

// JSON-LD serialization consumed by workstream 3 (app-ui-editor/src/contract.js):
// - sh:property = INLINE property-shape objects (not @id refs)
// - sh:name / rdfs:label = localized maps { "en": …, "fr": … }
// - sh:in = plain array of strings ; sh:datatype / sh:nodeKind = prefixed forms (expanded via @context)
// - sh:targetClass / sh:class = full IRIs, class form = namespace with trailing '#'
// - lang fields: sh:datatype rdf:langString AND @type rdf:langString (contract.js reads @type)
function toJsonLd(shapes, contractIri) {
  const ctx = {
    rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
    sh: 'http://www.w3.org/ns/shacl#',
    xsd: 'http://www.w3.org/2001/XMLSchema#'
  };
  const labelMap = labels => Object.fromEntries(labels.map(l => [l.lang, l.value]));
  const graph = [];
  for (const s of shapes) {
    graph.push({
      '@id': s.iri,
      '@type': 'sh:NodeShape',
      'sh:targetClass': { '@id': s.targetClass },
      'sh:name': { en: s.name },
      'rdfs:label': labelMap(s.labels),
      'sh:property': s.properties.map(p => {
        const node = {
          '@id': p.iri,
          '@type': p.datatype === 'rdf:langString' ? ['sh:PropertyShape', 'rdf:langString'] : 'sh:PropertyShape',
          'sh:path': { '@id': p.path },
          'sh:name': { en: p.name },
          'rdfs:label': labelMap(p.labels)
        };
        if (p.datatype) node['sh:datatype'] = p.datatype; // prefixed, expanded via @context
        if (p.minCount) node['sh:minCount'] = p.minCount;
        if (p.in) node['sh:in'] = p.in;
        if (p.nodeKind) node['sh:nodeKind'] = p.nodeKind; // 'sh:IRI' → expanded
        if (p.class) node['sh:class'] = { '@id': p.class };
        return node;
      })
    });
  }
  return { '@context': ctx, '@id': contractIri, '@graph': graph };
}

module.exports = { compile, SERVICE_FIELDS };
