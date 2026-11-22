// gen-vc.js — generates a signed (ES256) VC JWT for the TCK. Usage: node gen-vc.js <key.json> [payloadOverrideJson]
const crypto = require('crypto'), fs = require('fs');
const key = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const b64u = b => Buffer.from(JSON.stringify(b)).toString('base64url');
const header = { alg: 'ES256', typ: 'JWT', kid: key.did + '#key-1' };
const payload = Object.assign({
  iss: key.did, sub: key.did, jti: crypto.randomUUID(), nbf: Math.floor(Date.now()/1000) - 5,
  vc: { '@context': ['https://www.w3.org/2018/credentials/v1'], type: ['VerifiableCredential'], credentialSubject: { id: key.did } }
}, process.argv[3] ? JSON.parse(process.argv[3]) : {});
const input = b64u(header) + '.' + b64u(payload);
const sig = crypto.sign('sha256', Buffer.from(input), { key: crypto.createPrivateKey({ key: key.privateKeyJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }).toString('base64url');
console.log(input + '.' + sig);
