/**
 * Subdominios automáticos: <slug>.<BASE_DOMAIN>.
 *
 * Con BASE_DOMAIN=autoatento.com.ar, demo-norte.autoatento.com.ar abre el CRM
 * del tenant "demo-norte" sin cargarlo en tenants.dominios. Los dominios
 * propios de cada cliente (crm.cliente.com.ar) siguen yendo por "dominios" y
 * tienen prioridad.
 *
 * Fuera de producción también vale <slug>.localhost (desarrollo).
 *
 * Por eso un slug nuevo tiene que servir como subdominio: minúsculas, números
 * y guiones, sin guion al principio ni al final ni dos seguidos, y no puede
 * ser uno de los nombres reservados para AutoAtento (www, api, app, ...).
 */
const env = require('./env');

/** Subdominios de BASE_DOMAIN que no pueden ser tenants. */
const RESERVADOS = Object.freeze([
  'www', 'api', 'app', 'admin', 'superadmin', 'panel', 'soporte', 'ayuda', 'help', 'status',
  'mail', 'email', 'smtp', 'imap', 'pop', 'webmail', 'ftp', 'ns1', 'ns2', 'dns',
  'cdn', 'static', 'assets', 'img', 'media', 'files', 'docs', 'blog',
  'dev', 'staging', 'test', 'beta', 'bot', 'wa', 'webhooks', 'auth', 'login',
]);
const reservados = new Set(RESERVADOS);

/** Etiqueta DNS válida de hasta 60 caracteres (crm_<slug> entra en los 64 de MySQL). */
const SLUG_SUBDOMINIO_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

const normHost = (h) => String(h || '').trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');

/** Dominios base que se aceptan para subdominios automáticos. */
function bases() {
  const out = [];
  if (env.BASE_DOMAIN) out.push(env.BASE_DOMAIN);
  if (process.env.NODE_ENV !== 'production') out.push('localhost');
  return out;
}

/** Slug candidato si el host es <slug>.<base> (un solo nivel), si no null. */
function slugDeHost(host) {
  const h = normHost(host);
  for (const base of bases()) {
    if (!h.endsWith(`.${base}`)) continue;
    const etiqueta = h.slice(0, -(base.length + 1));
    if (!etiqueta || etiqueta.includes('.') || reservados.has(etiqueta)) return null;
    return etiqueta;
  }
  return null;
}

/** ¿El host es BASE_DOMAIN o un subdominio suyo? (esos no se cargan como dominios propios) */
function esDeBaseDomain(host) {
  const b = env.BASE_DOMAIN;
  if (!b) return false;
  const h = normHost(host);
  return h === b || h.endsWith(`.${b}`);
}

/** URL del CRM del tenant por subdominio, o null si no hay BASE_DOMAIN. */
function urlDeSlug(slug) {
  return env.BASE_DOMAIN ? `https://${slug}.${env.BASE_DOMAIN}` : null;
}

/** Motivo por el que el slug no sirve para un tenant nuevo, o null si está bien. */
function problemaSlug(slug) {
  const s = String(slug || '');
  if (!SLUG_SUBDOMINIO_RE.test(s)) {
    return 'Slug inválido: solo minúsculas, números y guiones (máx. 60), sin guion al principio ni al final';
  }
  if (s.includes('--')) return 'Slug inválido: no puede tener dos guiones seguidos';
  if (reservados.has(s)) return `El slug "${s}" está reservado para AutoAtento`;
  return null;
}

module.exports = {
  RESERVADOS, SLUG_SUBDOMINIO_RE, normHost, bases, slugDeHost, esDeBaseDomain, urlDeSlug, problemaSlug,
};
