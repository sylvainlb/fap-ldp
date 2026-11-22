// auth.js — ext/model-injection: resolving claims from the HTTP request.
// Same channel as the core (spec §7.6): Bearer/DPoP → OIDC userinfo (idpUserinfoUrl),
// or devTokens (TCK/test only, never in prod). The "signed contract" path with a
// dsp.capacities capacity is deferred to v2 (spec §3.2); in v1 only the admin role writes.
async function claimsFromRequest(req, { devTokens = {}, idpUserinfoUrl = '' } = {}) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^(?:Bearer|DPoP)\s+(.+)$/i);
  if (!m) return { token: null, claims: null };
  const token = m[1].trim();
  if (devTokens[token]) return { token, claims: devTokens[token] };
  if (idpUserinfoUrl) {
    try {
      const r = await fetch(idpUserinfoUrl, { headers: { Authorization: 'Bearer ' + token } });
      if (!r.ok) return { token, claims: null };
      const info = await r.json();
      return { token, claims: { webid: info.webid, role: info.role, org: info.org, did: info.did } };
    } catch { return { token, claims: null }; }
  }
  return { token, claims: null };
}

module.exports = { claimsFromRequest };
