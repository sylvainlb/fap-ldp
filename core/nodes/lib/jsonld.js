// jsonld.js — JSON-LD v1 serialization (spec fap-ldp v0.2 §6.2, without E4)
// Minimal embedded context, per-table prefix, @vocab = container IRI, columns as-is.

const LDP = 'http://www.w3.org/ns/ldp#';

function tablePrefix(schema, table) { return schema + '_' + table; }

function contextFor(baseIri, containerUri, schema, table) {
  const ctx = {
    ldp: LDP,
    dspace: 'https://www.w3.org/ns/dspace#',
    '@vocab': baseIri + containerUri.replace(/^\//, '')
  };
  if (schema && table) ctx[tablePrefix(schema, table)] = baseIri + 'ns/' + schema + '/' + table + '#';
  return ctx;
}

function camel(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// PG row (column→value object) → LDP/JSON-LD resource document
function resourceDoc(baseIri, containerUri, schema, table, row, pkCol) {
  const prefix = tablePrefix(schema, table);
  const doc = {
    '@context': contextFor(baseIri, containerUri, schema, table),
    '@id': baseIri + containerUri.replace(/^\//, '') + row[pkCol],
    '@type': ['ldp:Resource', prefix + ':' + camel(table)]
  };
  for (const [col, val] of Object.entries(row)) {
    doc[prefix + ':' + col] = val;
  }
  return doc;
}

// BasicContainer container
function containerDoc(baseIri, containerUri, memberIris, opts) {
  const doc = {
    '@context': contextFor(baseIri, containerUri, null, null),
    '@id': baseIri + containerUri.replace(/^\//, ''),
    '@type': ['ldp:BasicContainer', 'ldp:Container', 'ldp:Resource'],
    'ldp:contains': memberIris.map(iri => ({ '@id': iri }))
  };
  return doc;
}

// JSON-LD dspace:Error error (same format as the core data plane)
function errorDoc(code, message) {
  return {
    '@context': { dspace: 'https://www.w3.org/ns/dspace#' },
    '@type': 'dspace:Error',
    'dspace:errorCode': code,
    'dspace:message': message
  };
}

// incoming document (POST/PUT/PATCH) → column→value object (prefixes stripped)
function docToRow(doc, schema, table) {
  const prefix = tablePrefix(schema, table) + ':';
  const row = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k.startsWith('@')) continue;
    if (k.startsWith(prefix)) row[k.slice(prefix.length)] = v;
    else if (!k.includes(':')) row[k] = v; // @vocab
  }
  return row;
}

module.exports = { resourceDoc, containerDoc, errorDoc, docToRow, tablePrefix, contextFor };
