// vc.js — cryptographic verification of a VC presented as a JWT (Authorization: Bearer <vc-jwt> header).
// spec fap-ldp v0.3 §7.6: signature verified, trust anchors = configured did:web prefixes,
// the pod's did:web + declared partners. Never in a query string.
// did:web: DID document resolved over HTTPS (https://<host>/.well-known/did.json), with an
// override possible via config (tests/TCK: vcDidDocs = { did: { ...didDoc } }).
const crypto = require('crypto');

function b64urlToBuf(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function decodeJwt(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  try {
    return {
      header: JSON.parse(b64urlToBuf(parts[0]).toString('utf8')),
      payload: JSON.parse(b64urlToBuf(parts[1]).toString('utf8')),
      signingInput: Buffer.from(parts[0] + '.' + parts[1]),
      signature: b64urlToBuf(parts[2])
    };
  } catch { return null; }
}

async function resolveDidDoc(did, overrides) {
  if (overrides && overrides[did]) return overrides[did];
  const rest = did.replace(/^did:web:/, '');
  const [host, ...pathParts] = rest.split('%3A').join(':').split(':');
  const path = pathParts.join('/');
  const urls = path
    ? [`https://${host}/${path}/did.json`, `https://${host}/.well-known/did.json`]
    : [`https://${host}/.well-known/did.json`];
  for (const u of urls) {
    try {
      const r = await fetch(u);
      if (r.ok) return await r.json();
    } catch { /* try the next URL */ }
  }
  throw new Error('DID document not found for ' + did);
}

function pickVerificationMethod(didDoc, kid) {
  const vms = didDoc.verificationMethod || [];
  return vms.find(m => m.publicKeyJwk && (!kid || m.id === kid || m.id.endsWith('#' + kid)))
      || vms.find(m => m.publicKeyJwk);
}

// Returns the VC claims if valid, null if the token is not a VC,
// throws an error if it is a VC but invalid (→ 401).
async function verifyVc(token, opts) {
  const jwt = decodeJwt(token);
  if (!jwt || !jwt.payload || !jwt.payload.vc) return null; // not a VC → caller falls back to userinfo/devTokens
  const { header, payload, signingInput, signature } = jwt;
  const iss = payload.iss || '';
  const anchors = (opts && opts.trustAnchors) || [];
  if (!anchors.some(a => iss.startsWith(a))) {
    throw new Error('VC issuer outside trust anchors: ' + iss);
  }
  const didDoc = await resolveDidDoc(iss, opts && opts.didDocOverrides);
  const vm = pickVerificationMethod(didDoc, header.kid);
  if (!vm) throw new Error('no public key in the DID doc of ' + iss);
  const key = crypto.createPublicKey({ key: vm.publicKeyJwk, format: 'jwk' });
  let ok;
  if (header.alg === 'ES256') {
    ok = crypto.verify('sha256', signingInput, { key, dsaEncoding: 'ieee-p1363' }, signature);
  } else if (header.alg === 'RS256') {
    ok = crypto.verify('sha256', signingInput, key, signature);
  } else {
    throw new Error('unsupported alg: ' + header.alg);
  }
  if (!ok) throw new Error('invalid VC signature for ' + iss);
  const sub = (payload.vc.credentialSubject && payload.vc.credentialSubject.id) || iss;
  return { did: sub, webid: sub, vc: payload.vc, iss };
}

module.exports = { verifyVc, decodeJwt, resolveDidDoc };
