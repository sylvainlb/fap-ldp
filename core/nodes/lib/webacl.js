// webacl.js — WebACL/JSON-LD serialization ⇄ auth.acl rows (spec fap-ldp v0.2 §7.3)
// Mapping: acl:accessTo → resource_uri · acl:default → inherited (container, trailing slash)
//            acl:agent / acl:agentClass → subject (webid, did, 'role:xxx', 'foaf:Agent')
//            acl:mode → modes[] (acl:Read/Write/Append/Control)

const MODE_TO_WAC = { read: 'acl:Read', write: 'acl:Write', append: 'acl:Append', control: 'acl:Control' };
const WAC_TO_MODE = { 'acl:Read': 'read', 'acl:Write': 'write', 'acl:Append': 'append', 'acl:Control': 'control' };

const CONTEXT = {
  acl: 'http://www.w3.org/ns/auth/acl#',
  foaf: 'http://xmlns.com/foaf/0.1/'
};

function modeToWac(m) { return MODE_TO_WAC[m] || m; }
function wacToMode(m) { return WAC_TO_MODE[m] || String(m).replace(/^.*#/, '').toLowerCase(); }

// rows: [{resource_uri, subject, modes[], inherited}] → WebACL JSON-LD document
function serialize(resourceUri, rows) {
  const graph = rows.map(r => {
    const authz = {
      '@type': 'acl:Authorization',
      'acl:accessTo': r.resource_uri
    };
    if (r.resource_uri.endsWith('/')) authz['acl:default'] = true; // inherited on the content
    if (r.subject === 'foaf:Agent' || r.subject.startsWith('role:')) {
      authz['acl:agentClass'] = r.subject === 'foaf:Agent' ? 'foaf:Agent' : r.subject;
    } else {
      authz['acl:agent'] = r.subject;
    }
    authz['acl:mode'] = r.modes.map(modeToWac);
    return authz;
  });
  return { '@context': CONTEXT, '@id': resourceUri + '.acl', '@graph': graph };
}

// WebACL document → rows to insert into auth.acl (resource_uri = targeted resource)
function parse(doc, resourceUri) {
  const graph = Array.isArray(doc['@graph']) ? doc['@graph'] : (doc['@type'] ? [doc] : []);
  const rows = [];
  for (const a of graph) {
    const accessTo = a['acl:accessTo'];
    const target = Array.isArray(accessTo) ? accessTo[0] : accessTo;
    const subject = a['acl:agent'] ||
      (a['acl:agentClass'] === 'foaf:Agent' ? 'foaf:Agent' : a['acl:agentClass']);
    const modesRaw = a['acl:mode'] || [];
    const modes = (Array.isArray(modesRaw) ? modesRaw : [modesRaw]).map(wacToMode);
    rows.push({
      resource_uri: target || resourceUri,
      subject: String(subject),
      modes,
      inherited: a['acl:default'] === true || (target || resourceUri).endsWith('/')
    });
  }
  return rows;
}

module.exports = { serialize, parse, CONTEXT };
