/**
 * Registro de tenants (lee autoatento_control.tenants con caché).
 *
 * El objeto tenant que circula por la app NO tiene secretos a la vista:
 *   { id, slug, nombre, estado, plan, dominios, modulos, branding, config }
 * La connection string y las keys descifradas viven en un WeakMap aparte
 * (dbUrlOf / secretsOf), así un console.log(tenant) o un res.json(tenant)
 * nunca las filtra.
 */
const { getControlPool } = require('./control');
const { decrypt, decryptJSON, isEncrypted } = require('./crypto');
const { normalizarModulos } = require('./modules');
const env = require('./env');

/** Claves de tenants.config que se guardan cifradas. */
const SECRET_KEYS = ['wa_bot_key', 'openai_api_key', 'anthropic_api_key', 'agent_mcp_key', 'lead_api_keys'];
/** Claves de config que se pueden mostrar al frontend (endpoint público). */
const PUBLIC_CONFIG_KEYS = ['timezone', 'pais', 'prefijo_telefonico', 'moneda', 'wa_bot_url', 'marcas', 'marca_default'];

const DEFAULT_TIMEZONE = 'America/Argentina/Buenos_Aires';

const secrets = new WeakMap(); // tenant -> { dbUrl, error, ...keys }

let cache = null; // { at, list, bySlug, byId, byHost }
let loading = null;

const parseJSON = (v, def) => {
  if (v === null || v === undefined || v === '') return def;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return def; }
};

const normHost = (h) => String(h || '').trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');

function hydrate(row) {
  const config = parseJSON(row.config, {}) || {};
  const sec = { dbUrl: null, error: null };
  const publicConfig = {};
  for (const [k, v] of Object.entries(config)) {
    if (!SECRET_KEYS.includes(k)) publicConfig[k] = v;
  }
  if (!publicConfig.timezone) publicConfig.timezone = DEFAULT_TIMEZONE;

  try {
    sec.dbUrl = decrypt(row.db_url_cifrada);
    for (const k of SECRET_KEYS) {
      const v = config[k];
      if (v === undefined || v === null || v === '') continue;
      if (!isEncrypted(v)) throw new Error(`config.${k} no está cifrada`);
      sec[k] = k === 'lead_api_keys' ? decryptJSON(v) : decrypt(v);
    }
  } catch (e) {
    sec.error = e.message;
    console.error(`[tenancy] tenant "${row.slug}": no se pudieron descifrar sus secretos (${e.message})`);
  }

  const tenant = {
    id: row.id,
    slug: row.slug,
    nombre: row.nombre,
    estado: row.estado,
    plan: row.plan,
    dominios: (parseJSON(row.dominios, []) || []).map(normHost).filter(Boolean),
    modulos: normalizarModulos(parseJSON(row.modulos, {})),
    branding: parseJSON(row.branding, {}) || {},
    config: publicConfig,
  };
  Object.freeze(tenant);
  secrets.set(tenant, sec);
  return tenant;
}

async function load() {
  const [rows] = await getControlPool().query('SELECT * FROM tenants ORDER BY id');
  const next = { at: Date.now(), list: [], bySlug: new Map(), byId: new Map(), byHost: new Map() };
  for (const row of rows) {
    const t = hydrate(row);
    next.list.push(t);
    next.bySlug.set(t.slug, t);
    next.byId.set(t.id, t);
    for (const d of t.dominios) if (!next.byHost.has(d)) next.byHost.set(d, t);
  }
  cache = next;
  return cache;
}

async function ensure() {
  if (cache && Date.now() - cache.at < env.TENANT_CACHE_TTL_MS) return cache;
  if (!loading) {
    loading = load()
      .catch((e) => {
        // Si la base de control no responde, se sigue con la última foto
        // conocida en vez de tirar abajo todos los tenants.
        if (cache) {
          console.error('[tenancy] no se pudo refrescar tenants, uso la caché anterior:', e.message);
          return cache;
        }
        throw e;
      })
      .finally(() => { loading = null; });
  }
  return loading;
}

async function getBySlug(slug) {
  const c = await ensure();
  return c.bySlug.get(String(slug || '').trim().toLowerCase()) || null;
}

async function getById(id) {
  const c = await ensure();
  return c.byId.get(Number(id)) || null;
}

async function getByHost(host) {
  const c = await ensure();
  const h = normHost(host);
  return c.byHost.get(h) || c.byHost.get(h.replace(/^www\./, '')) || null;
}

async function listActive() {
  const c = await ensure();
  return c.list.filter((t) => t.estado === 'activo');
}

async function listAll() {
  return (await ensure()).list;
}

/** Versión más reciente en caché (sin ir a la base). Útil en sockets. */
function peekById(id) {
  return cache?.byId.get(Number(id)) || null;
}

function invalidate() {
  if (cache) cache.at = 0;
}

function dbUrlOf(tenant) {
  const s = secrets.get(tenant);
  if (!s) throw new Error(`Tenant "${tenant?.slug}" no viene del registro`);
  if (s.error) throw new Error(`Tenant "${tenant.slug}" con secretos inválidos: ${s.error}`);
  return s.dbUrl;
}

/** Secretos descifrados de config (wa_bot_key, openai_api_key, lead_api_keys, ...). */
function secretsOf(tenant) {
  const s = secrets.get(tenant);
  if (!s || s.error) return {};
  const { dbUrl, error, ...rest } = s;
  return rest;
}

/** Lo que puede ver cualquiera (endpoint público): nunca credenciales. */
function publicView(tenant) {
  const config = {};
  for (const k of PUBLIC_CONFIG_KEYS) if (tenant.config[k] !== undefined) config[k] = tenant.config[k];
  return {
    slug: tenant.slug,
    nombre: tenant.nombre,
    estado: tenant.estado,
    branding: { nombre: 'AutoAtento', ...tenant.branding, nombre: tenant.branding?.nombre || 'AutoAtento' },
    modulos: tenant.modulos,
    config,
  };
}

module.exports = {
  getBySlug, getById, getByHost, listActive, listAll, peekById, invalidate,
  dbUrlOf, secretsOf, publicView, normHost,
  SECRET_KEYS, PUBLIC_CONFIG_KEYS, DEFAULT_TIMEZONE,
};
