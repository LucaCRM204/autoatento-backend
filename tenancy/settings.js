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

/**
 * Bot de WhatsApp del tenant: { url, key }. Sale de tenants.config
 * (wa_bot_url / wa_bot_key cifrada) con fallback a WA_BOT_URL / WA_BOT_KEY.
 * Sin default hardcodeado: antes caía al bot de Fiat.
 */
function waBot() {
  return {
    url: String(tenantConfig('wa_bot_url', 'WA_BOT_URL', '') || '').replace(/\/$/, ''),
    key: tenantSecret('wa_bot_key', 'WA_BOT_KEY', '') || '',
  };
}

// ---------- Marcas del tenant ----------
// tenants.config.marcas = ['fiat', 'jeep'] (habilitadas) y marca_default = 'fiat'.
// Nada hardcodeado: sin config, la marca queda en null salvo que venga una.
const normMarca = (m) => String(m ?? '').trim().toLowerCase().slice(0, 30);

function marcasTenant() {
  const l = tenantConfig('marcas');
  return Array.isArray(l) ? l.map(normMarca).filter(Boolean) : [];
}

function marcaDefault() {
  return normMarca(tenantConfig('marca_default')) || marcasTenant()[0] || null;
}

/** ¿Se puede usar esta marca? Con lista configurada, tiene que estar en la lista. */
function marcaPermitida(m) {
  const n = normMarca(m);
  if (!n) return false;
  const lista = marcasTenant();
  return lista.length ? lista.includes(n) : true;
}

/** Para webhooks/bot: la del payload si está habilitada; si no, la default. */
function resolverMarca(m) {
  const n = normMarca(m);
  if (n && marcasTenant().includes(n)) return n;
  return marcaDefault();
}

/** Nombre visible del tenant (branding), con fallback a AutoAtento. */
function tenantNombre(tenant = currentTenant()) {
  return tenant?.branding?.nombre || tenant?.nombre || 'AutoAtento';
}

module.exports = {
  tenantConfig, tenantSecret, tenantNombre, waBot,
  normMarca, marcasTenant, marcaDefault, marcaPermitida, resolverMarca,
};
