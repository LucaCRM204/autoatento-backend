/**
 * Alta y edición de tenants. Lo usan el panel superadmin (superadmin/routes.js)
 * y los scripts (tenant-add, dev-seed).
 *
 * crearTenant() hace todo el circuito:
 *   1. schema crm_<slug> nuevo (o una base existente si viene dbUrl)
 *   2. migraciones
 *   3. owner
 *   4. registro en autoatento_control.tenants
 * Si falla y el schema lo creó esta misma llamada, se borra (rollback): era
 * un schema vacío recién creado. Nunca se borra una base existente.
 */
const fs = require('fs');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const env = require('./env');
const { getControlPool } = require('./control');
const { encrypt, encryptJSON } = require('./crypto');
const { SECRET_KEYS, normHost, invalidate } = require('./registry');
const { MODULOS } = require('./modules');
const { migrateDatabase } = require('./migrate');
const { problemaSlug, esDeBaseDomain } = require('./subdominios');

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
const PLANES = ['esencial', 'pro', 'arm'];
const ESTADOS = ['activo', 'suspendido', 'baja'];
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Claves de config que se aceptan (las de SECRET_KEYS se guardan cifradas). */
const CONFIG_KEYS = [
  'timezone', 'pais', 'prefijo_telefonico', 'moneda', 'wa_bot_url',
  'sheet_fuentes', 'dist_excluidos', 'agent_provider', 'agent_model', 'marcas', 'marca_default',
  ...SECRET_KEYS,
];
const BRANDING_KEYS = ['nombre', 'logo_url', 'favicon_url', 'color_primario'];

const schemaName = (slug) => `crm_${slug}`;
const quoteId = (name) => `\`${String(name).replace(/`/g, '')}\``;

function fail(msg, status = 400) {
  const e = new Error(msg);
  e.status = status;
  throw e;
}

function validarSlug(slug) {
  if (!SLUG_RE.test(String(slug || ''))) {
    fail('Slug inválido: minúsculas, números y guiones (máx. 60), empezando con letra o número');
  }
}

/** Slug de un tenant nuevo: además tiene que servir como subdominio <slug>.<BASE_DOMAIN>. */
function validarSlugNuevo(slug) {
  const problema = problemaSlug(slug);
  if (problema) fail(problema);
}

/** Connection string sin contraseña, para mostrar. */
function maskDbUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '(inválida)';
  }
}

async function serverConn() {
  return mysql.createConnection({ uri: env.tenantServerUrl() });
}

/** Cantidad de tablas del schema crm_<slug>, o null si no existe. */
async function schemaTableCount(slug) {
  const conn = await serverConn();
  try {
    const [[s]] = await conn.query('SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [schemaName(slug)]);
    if (!s.n) return null;
    const [[t]] = await conn.query('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [schemaName(slug)]);
    return t.n;
  } finally {
    await conn.end().catch(() => {});
  }
}

/** Crea crm_<slug> en TENANT_DB_SERVER_URL. Devuelve la connection string. */
async function createTenantSchema(slug) {
  validarSlug(slug);
  const conn = await serverConn();
  try {
    await conn.query(`CREATE DATABASE IF NOT EXISTS ${quoteId(schemaName(slug))} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally {
    await conn.end().catch(() => {});
  }
  return env.withDatabase(env.tenantServerUrl(), schemaName(slug));
}

/** Borra crm_<slug>. Solo para rollback de un alta fallida y para dev-seed. */
async function dropTenantSchema(slug) {
  validarSlug(slug);
  const conn = await serverConn();
  try {
    await conn.query(`DROP DATABASE IF EXISTS ${quoteId(schemaName(slug))}`);
  } finally {
    await conn.end().catch(() => {});
  }
}

/** Corre un .sql entero contra una base (lo usan los tests para simular bases viejas). */
async function runSqlFile(dbUrl, file) {
  const conn = await mysql.createConnection({ uri: dbUrl, multipleStatements: true });
  try {
    await conn.query(fs.readFileSync(file, 'utf8'));
  } finally {
    await conn.end().catch(() => {});
  }
}

/** Verifica que la connection string conecte y apunte a una base. */
async function testConnection(dbUrl) {
  let conn;
  try {
    conn = await mysql.createConnection({ uri: dbUrl, connectTimeout: 10000 });
    const [[r]] = await conn.query('SELECT DATABASE() AS db, VERSION() AS version');
    if (!r.db) fail('La connection string no indica la base (falta /<base> al final)');
    const [[t]] = await conn.query('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
    return { db: r.db, version: r.version, tablas: t.n };
  } catch (e) {
    if (e.status) throw e;
    fail(`No se pudo conectar a la base: ${e.code || e.message}`);
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}

/** Crea el owner si no existe (no pisa la contraseña de uno existente). */
async function ensureOwner(dbUrl, { email, password, name }) {
  const conn = await mysql.createConnection({ uri: dbUrl });
  try {
    const [rows] = await conn.execute('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
    if (rows.length) return { id: rows[0].id, creado: false };
    if (!password) fail('Falta la contraseña del owner');
    if (String(password).length < 8) fail('La contraseña del owner tiene que tener al menos 8 caracteres');
    const hash = await bcrypt.hash(password, 10);
    const [r] = await conn.execute(
      "INSERT INTO users (name, email, password, role, active) VALUES (?, ?, ?, 'owner', 1)",
      [name || 'Owner', email, hash]);
    return { id: r.insertId, creado: true };
  } finally {
    await conn.end().catch(() => {});
  }
}

// ---------- validación de los JSON ----------

function normalizarDominios(dominios) {
  if (dominios === undefined) return undefined;
  if (!Array.isArray(dominios)) fail('dominios tiene que ser una lista');
  const out = [...new Set(dominios.map(normHost).filter(Boolean))];
  for (const d of out) {
    if (!HOST_RE.test(d)) fail(`Dominio inválido: ${d}`);
    if (esDeBaseDomain(d)) {
      fail(`${d} no se carga como dominio: los subdominios de ${env.BASE_DOMAIN} son automáticos (<slug>.${env.BASE_DOMAIN})`);
    }
  }
  return out;
}

function normalizarModulos(modulos) {
  if (modulos === undefined) return undefined;
  if (!modulos || typeof modulos !== 'object' || Array.isArray(modulos)) fail('modulos tiene que ser un objeto');
  const out = {};
  for (const [k, v] of Object.entries(modulos)) {
    if (!(k in MODULOS)) fail(`Módulo desconocido: ${k}`);
    out[k] = !!v;
  }
  return out;
}

function normalizarBranding(branding) {
  if (branding === undefined) return undefined;
  if (!branding || typeof branding !== 'object' || Array.isArray(branding)) fail('branding tiene que ser un objeto');
  const out = {};
  for (const [k, v] of Object.entries(branding)) {
    if (!BRANDING_KEYS.includes(k)) fail(`Clave de branding desconocida: ${k}`);
    if (v === null || v === '') continue;
    if (typeof v !== 'string' || v.length > 500) fail(`branding.${k} inválido`);
    if (k === 'color_primario' && !/^#[0-9a-f]{3,8}$/i.test(v)) fail('color_primario tiene que ser un color hex (#rrggbb)');
    out[k] = v;
  }
  return out;
}

function validarValorConfig(k, v) {
  if (v === null) return;
  switch (k) {
    case 'timezone':
      try { new Intl.DateTimeFormat('en-US', { timeZone: v }); } catch { fail(`Zona horaria inválida: ${v}`); }
      break;
    case 'lead_api_keys':
      if (typeof v !== 'object' || Array.isArray(v)) fail('lead_api_keys tiene que ser { proveedor: clave }');
      for (const [p, key] of Object.entries(v)) {
        if (!/^[a-z0-9-]{1,40}$/.test(p)) fail(`Proveedor inválido en lead_api_keys: ${p}`);
        if (typeof key !== 'string' || key.length < 16) fail(`La clave de ${p} tiene que tener al menos 16 caracteres`);
      }
      break;
    case 'sheet_fuentes':
      if (typeof v !== 'object' || Array.isArray(v)) fail('sheet_fuentes tiene que ser { proveedor: fuente }');
      break;
    case 'dist_excluidos':
      if (!Array.isArray(v) && typeof v !== 'string') fail('dist_excluidos tiene que ser una lista de ids');
      break;
    case 'marcas':
      if (!Array.isArray(v) || !v.length) fail('marcas tiene que ser una lista con al menos una marca');
      for (const m of v) {
        if (typeof m !== 'string' || !/^[a-z0-9][a-z0-9 -]{0,29}$/.test(m)) fail(`Marca inválida: ${m} (minúsculas, máx. 30)`);
      }
      break;
    case 'marca_default':
      if (typeof v !== 'string' || !/^[a-z0-9][a-z0-9 -]{0,29}$/.test(v)) fail('marca_default inválida (minúsculas, máx. 30)');
      break;
    case 'agent_provider':
      if (!['openai', 'anthropic'].includes(v)) fail('agent_provider: openai o anthropic');
      break;
    case 'wa_bot_url':
      if (!/^https?:\/\/\S+$/.test(v)) fail('wa_bot_url tiene que ser una URL http(s)');
      break;
    default:
      if (typeof v !== 'string' || v.length > 500) fail(`config.${k} inválido`);
  }
}

/**
 * Mezcla cambios de config sobre la config guardada (ya cifrada).
 *   valor     -> se guarda (cifrado si es secreto)
 *   null / '' -> se borra la clave
 *   ausente   -> queda como estaba
 */
function mergeConfig(guardada = {}, cambios = {}) {
  if (!cambios || typeof cambios !== 'object' || Array.isArray(cambios)) fail('config tiene que ser un objeto');
  const out = { ...guardada };
  for (const [k, v] of Object.entries(cambios)) {
    if (!CONFIG_KEYS.includes(k)) fail(`Clave de config desconocida: ${k}`);
    if (v === undefined) continue;
    if (v === null || v === '') { delete out[k]; continue; }
    validarValorConfig(k, v);
    out[k] = SECRET_KEYS.includes(k) ? (k === 'lead_api_keys' ? encryptJSON(v) : encrypt(v)) : v;
  }
  if (out.marca_default && Array.isArray(out.marcas) && !out.marcas.includes(out.marca_default)) {
    fail(`marca_default (${out.marca_default}) tiene que estar en marcas`);
  }
  return out;
}

const parseJSON = (v, def) => (v == null ? def : typeof v === 'object' ? v : JSON.parse(v));

async function verificarDominiosLibres(dominios, exceptoId = null) {
  if (!dominios?.length) return;
  const [rows] = await getControlPool().query('SELECT id, slug, dominios FROM tenants');
  for (const r of rows) {
    if (exceptoId && r.id === exceptoId) continue;
    const suyos = (parseJSON(r.dominios, []) || []).map(normHost);
    const choque = dominios.find((d) => suyos.includes(d));
    if (choque) fail(`El dominio ${choque} ya es del tenant "${r.slug}"`, 409);
  }
}

/** Inserta la fila en tenants. config puede traer secretos en claro: se cifran acá. */
async function registerTenant(t) {
  validarSlug(t.slug);
  if (!t.nombre) fail('Falta el nombre del tenant');
  if (!t.dbUrl) fail('Falta la connection string del tenant');
  const plan = t.plan || 'esencial';
  if (!PLANES.includes(plan)) fail(`Plan inválido (${PLANES.join(', ')})`);
  const dominios = normalizarDominios(t.dominios || []);
  await verificarDominiosLibres(dominios);
  const [r] = await getControlPool().execute(
    `INSERT INTO tenants (slug, nombre, estado, plan, db_url_cifrada, dominios, modulos, branding, config)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [t.slug, t.nombre, t.estado || 'activo', plan, encrypt(t.dbUrl),
      JSON.stringify(dominios), JSON.stringify(normalizarModulos(t.modulos || {})),
      JSON.stringify(normalizarBranding(t.branding || {})), JSON.stringify(mergeConfig({}, t.config || {}))]);
  invalidate();
  return r.insertId;
}

async function slugOcupado(slug) {
  const [rows] = await getControlPool().execute('SELECT id FROM tenants WHERE slug = ?', [slug]);
  return rows[0]?.id || null;
}

/**
 * Alta completa. opts:
 *   { slug, nombre, plan, dominios, modulos, branding, config,
 *     dbUrl?            (usar base existente; si no, se crea crm_<slug>)
 *     migrar?           (default true; con base existente se puede dejar en
 *                        false para registrarla y migrar después)
 *     owner?: { email, password, name }  (obligatorio con schema nuevo) }
 * Devuelve { id, slug, schemaCreado, migraciones, owner, base }.
 */
async function crearTenant(opts) {
  validarSlugNuevo(opts.slug);
  if (!opts.nombre) fail('Falta el nombre');
  if (opts.plan && !PLANES.includes(opts.plan)) fail(`Plan inválido (${PLANES.join(', ')})`);
  // Validar todo lo validable antes de tocar ninguna base
  normalizarDominios(opts.dominios || []);
  normalizarModulos(opts.modulos || {});
  normalizarBranding(opts.branding || {});
  mergeConfig({}, opts.config || {});
  if (await slugOcupado(opts.slug)) fail(`Ya existe un tenant con slug "${opts.slug}"`, 409);
  await verificarDominiosLibres(normalizarDominios(opts.dominios || []));

  const existente = !!opts.dbUrl;
  if (!existente) {
    if (!opts.owner?.email || !opts.owner?.password) fail('Con schema nuevo hacen falta email y contraseña del owner');
    const tablas = await schemaTableCount(opts.slug);
    if (tablas !== null && tablas > 0) {
      fail(`Ya existe el schema ${schemaName(opts.slug)} con ${tablas} tablas: usá "base existente" o revisalo a mano`, 409);
    }
  }

  let schemaCreado = false;
  let dbUrl = opts.dbUrl;
  try {
    let base;
    if (existente) {
      base = await testConnection(dbUrl);
    } else {
      const previo = await schemaTableCount(opts.slug);
      dbUrl = await createTenantSchema(opts.slug);
      schemaCreado = previo === null;
      base = { db: schemaName(opts.slug), tablas: 0 };
    }

    const migrar = !existente || opts.migrar !== false;
    const migraciones = migrar ? await migrateDatabase(dbUrl) : { aplicadas: [], omitidas: true };
    let owner = null;
    if (opts.owner?.email) owner = await ensureOwner(dbUrl, opts.owner);

    const id = await registerTenant({ ...opts, dbUrl });
    return { id, slug: opts.slug, schemaCreado, base, migraciones, owner };
  } catch (e) {
    if (schemaCreado) {
      await dropTenantSchema(opts.slug).catch((err) => console.error(`[provision] rollback de ${schemaName(opts.slug)}:`, err.message));
    }
    throw e;
  }
}

/**
 * Edición. cambios: { nombre, plan, estado, dominios, modulos, branding, config, dbUrl }
 * modulos y branding se mezclan con lo guardado; config usa mergeConfig.
 * Devuelve la lista de campos tocados (para auditoría, sin valores secretos).
 */
async function actualizarTenant(id, cambios = {}) {
  const [[row]] = await getControlPool().execute('SELECT * FROM tenants WHERE id = ?', [id]);
  if (!row) fail('Tenant inexistente', 404);

  const sets = [];
  const vals = [];
  const tocados = [];
  const set = (col, val, nombre = col) => { sets.push(`${col} = ?`); vals.push(val); tocados.push(nombre); };

  if (cambios.nombre !== undefined) {
    if (!cambios.nombre || String(cambios.nombre).length > 150) fail('Nombre inválido');
    set('nombre', String(cambios.nombre));
  }
  if (cambios.plan !== undefined) {
    if (!PLANES.includes(cambios.plan)) fail(`Plan inválido (${PLANES.join(', ')})`);
    set('plan', cambios.plan);
  }
  if (cambios.estado !== undefined) {
    if (!ESTADOS.includes(cambios.estado)) fail(`Estado inválido (${ESTADOS.join(', ')})`);
    set('estado', cambios.estado);
  }
  if (cambios.dominios !== undefined) {
    const d = normalizarDominios(cambios.dominios);
    await verificarDominiosLibres(d, row.id);
    set('dominios', JSON.stringify(d));
  }
  if (cambios.modulos !== undefined) {
    set('modulos', JSON.stringify({ ...parseJSON(row.modulos, {}), ...normalizarModulos(cambios.modulos) }));
  }
  if (cambios.branding !== undefined) {
    const actual = parseJSON(row.branding, {});
    const nuevo = normalizarBranding(cambios.branding);
    for (const [k, v] of Object.entries(cambios.branding)) if (v === null || v === '') delete actual[k];
    set('branding', JSON.stringify({ ...actual, ...nuevo }));
  }
  if (cambios.config !== undefined) {
    set('config', JSON.stringify(mergeConfig(parseJSON(row.config, {}), cambios.config)));
    tocados.pop();
    tocados.push(...Object.keys(cambios.config).map((k) => `config.${k}`));
  }
  if (cambios.dbUrl !== undefined) {
    await testConnection(cambios.dbUrl);
    set('db_url_cifrada', encrypt(cambios.dbUrl), 'db_url');
  }
  if (!sets.length) return [];
  vals.push(id);
  await getControlPool().execute(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ?`, vals);
  invalidate();
  return tocados;
}

module.exports = {
  crearTenant, actualizarTenant, registerTenant, ensureOwner, testConnection,
  createTenantSchema, dropTenantSchema, schemaTableCount, runSqlFile, mergeConfig,
  validarSlug, validarSlugNuevo, schemaName, quoteId, maskDbUrl, PLANES, ESTADOS, CONFIG_KEYS, BRANDING_KEYS,
};
