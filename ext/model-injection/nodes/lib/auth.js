// auth.js — ext/model-injection : résolution des claims depuis la requête HTTP.
// Même canal que le core (spec §7.6) : Bearer/DPoP → userinfo OIDC (idpUserinfoUrl),
// ou devTokens (TCK/test uniquement, jamais en prod). Le chemin « contrat signé » avec
// capacité dsp.capacities est reporté en v2 (spec §3.2) ; en v1 seul le rôle admin écrit.
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
