/**
 * Configuración del tenant actual con fallback a variables de entorno.
 *
 *   tenantConfig('wa_bot_url', 'WA_BOT_URL')     -> config pública
 *   tenantSecret('wa_bot_key', 'WA_BOT_KEY')     -> secreto descifrado
 *
 * Ojo con el fallback a env en producción multi-tenant: un WA_BOT_KEY global
 * lo usarían TODOS los tenants que no tengan el suyo (ver MULTITENANT.md).
 */
const { currentTenant } = require('./context');
const registry = require('./registry');

const vacio = (v) => v === undefined || v === null || v === '';

function tenantConfig(key, envVar = null, def = undefined) {
  const t = currentTenant();
  const v = t?.config?.[key];
  if (!vacio(v)) return v;
  if (envVar && !vacio(process.env[envVar])) return process.env[envVar];
  return def;
}

function tenantSecret(key, envVar = null, def = undefined) {
  const t = currentTenant();
  const v = t ? registry.secretsOf(t)[key] : undefined;
  if (!vacio(v)) return v;
  if (envVar && !vacio(process.env[envVar])) return process.env[envVar];
  return def;
}

/** Nombre visible del tenant (branding), con fallback a AutoAtento. */
function tenantNombre(tenant = currentTenant()) {
  return tenant?.branding?.nombre || tenant?.nombre || 'AutoAtento';
}

module.exports = { tenantConfig, tenantSecret, tenantNombre };
