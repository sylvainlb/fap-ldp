// vc.js — vérification cryptographique d'une VC présentée en JWT (header Authorization: Bearer <vc-jwt>).
// spec fap-ldp v0.3 §7.6 : signature vérifiée, trust anchors = préfixes did:web configurés,
// did:web du pod + partenaires déclarés. Jamais en query string.
// did:web : document DID résolu en HTTPS (https://<host>/.well-known/did.json), avec override
// possible via config (tests/TCk : vcDidDocs = { did: { ...didDoc } }).
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
    } catch { /* on essaie l'URL suivante */ }
  }
  throw new Error('document DID introuvable pour ' + did);
}

function pickVerificationMethod(didDoc, kid) {
  const vms = didDoc.verificationMethod || [];
  return vms.find(m => m.publicKeyJwk && (!kid || m.id === kid || m.id.endsWith('#' + kid)))
      || vms.find(m => m.publicKeyJwk);
}

// Retourne les claims de la VC si valide, null si le token n'est pas une VC,
// lève une erreur si c'est une VC mais invalide (→ 401).
async function verifyVc(token, opts) {
  const jwt = decodeJwt(token);
  if (!jwt || !jwt.payload || !jwt.payload.vc) return null; // pas une VC → la caller tombe sur userinfo/devTokens
  const { header, payload, signingInput, signature } = jwt;
  const iss = payload.iss || '';
  const anchors = (opts && opts.trustAnchors) || [];
  if (!anchors.some(a => iss.startsWith(a))) {
    throw new Error('émetteur VC hors trust anchors: ' + iss);
  }
  const didDoc = await resolveDidDoc(iss, opts && opts.didDocOverrides);
  const vm = pickVerificationMethod(didDoc, header.kid);
  if (!vm) throw new Error('pas de clé publique dans le did doc de ' + iss);
  const key = crypto.createPublicKey({ key: vm.publicKeyJwk, format: 'jwk' });
  let ok;
  if (header.alg === 'ES256') {
    ok = crypto.verify('sha256', signingInput, { key, dsaEncoding: 'ieee-p1363' }, signature);
  } else if (header.alg === 'RS256') {
    ok = crypto.verify('sha256', signingInput, key, signature);
  } else {
    throw new Error('alg non supporté: ' + header.alg);
  }
  if (!ok) throw new Error('signature VC invalide pour ' + iss);
  const sub = (payload.vc.credentialSubject && payload.vc.credentialSubject.id) || iss;
  return { did: sub, webid: sub, vc: payload.vc, iss };
}

module.exports = { verifyVc, decodeJwt, resolveDidDoc };
