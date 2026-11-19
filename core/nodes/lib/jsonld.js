// jsonld.js — sérialisation JSON-LD v1 (spec fap-ldp v0.2 §6.2, sans E4)
// Contexte minimal embarqué, préfixe par table, @vocab = IRI du conteneur, colonnes telles quelles.

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

// ligne PG (objet colonne→valeur) → document ressource LDP/JSON-LD
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

// conteneur BasicContainer
function containerDoc(baseIri, containerUri, memberIris, opts) {
  const doc = {
    '@context': contextFor(baseIri, containerUri, null, null),
    '@id': baseIri + containerUri.replace(/^\//, ''),
    '@type': ['ldp:BasicContainer', 'ldp:Container', 'ldp:Resource'],
    'ldp:contains': memberIris.map(iri => ({ '@id': iri }))
  };
  return doc;
}

// erreur JSON-LD dspace:Error (même format que le data plane cœur)
function errorDoc(code, message) {
  return {
    '@context': { dspace: 'https://www.w3.org/ns/dspace#' },
    '@type': 'dspace:Error',
    'dspace:errorCode': code,
    'dspace:message': message
  };
}

// document entrant (POST/PUT/PATCH) → objet colonne→valeur (préfixes retirés)
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
