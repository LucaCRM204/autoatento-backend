// middleware/intakeAuth.js
// Autentica webhooks entrantes (bot de WhatsApp, Zapier, Google Sheets) por API key.
//
// Multi-tenant: las keys son de cada tenant y se guardan cifradas en
// tenants.config.lead_api_keys como { proveedor: clave }, ej.
//   { "whatsapp-bot": "abc123", "zapier-formularios": "xyz789", "sheet-emanuel": "..." }
// Una key solo vale para su tenant (/api/t/<slug>/webhooks/...). No hay
// fallback a LEAD_API_KEYS del env: una key global serviría en todos.
const crypto = require('crypto');
const { currentTenant } = require('../tenancy/context');
const registry = require('../tenancy/registry');

function iguales(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = function intakeAuth(req, res, next) {
  const key = String(req.headers['x-api-key'] || '');
  const tenant = currentTenant();
  const keys = (tenant && registry.secretsOf(tenant).lead_api_keys) || {};
  let provider = null;
  if (key) {
    for (const [prov, k] of Object.entries(keys)) {
      if (k && iguales(key, k)) { provider = prov; break; }
    }
  }
  if (!provider) return res.status(401).json({ error: 'API key inválida' });
  req.provider = provider;
  next();
};
