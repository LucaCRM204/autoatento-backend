/**
 * Alta de tenants: crear schema, cargar esquema base, owner y registro en
 * autoatento_control. Lo usan los scripts de la Fase 1 (tenant-add, dev-seed)
 * y lo va a usar el panel superadmin en la Fase 2.
 *
 * Hasta que existan las migraciones (Fase 2), el esquema base es database.sql.
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const env = require('./env');
const { getControlPool } = require('./control');
const { encrypt, encryptJSON } = require('./crypto');
const { SECRET_KEYS, normHost, invalidate } = require('./registry');
const { MODULOS } = require('./modules');

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
const PLANES = ['esencial', 'pro', 'arm'];

const schemaName = (slug) => `crm_${slug}`;
const quoteId = (name) => `\`${String(name).replace(/`/g, '')}\``;

function validarSlug(slug) {
  if (!SLUG_RE.test(String(slug || ''))) {
    throw new Error('Slug inválido: minúsculas, números y guiones (máx. 60), empezando con letra o número');
  }
}

/** Crea crm_<slug> en TENANT_DB_SERVER_URL. Devuelve la connection string. */
async function createTenantSchema(slug) {
  validarSlug(slug);
  const server = env.tenantServerUrl();
  const conn = await mysql.createConnection({ uri: server });
  try {
    await conn.query(`CREATE DATABASE IF NOT EXISTS ${quoteId(schemaName(slug))} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally {
    await conn.end().catch(() => {});
  }
  return env.withDatabase(server, schemaName(slug));
}

/** Carga database.sql (todo CREATE TABLE IF NOT EXISTS). Se reemplaza por migraciones en la Fase 2. */
async function loadBaseSchema(dbUrl) {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'database.sql'), 'utf8');
  const conn = await mysql.createConnection({ uri: dbUrl, multipleStatements: true });
  try {
    await conn.query(sql);
    const [tablas] = await conn.query('SHOW TABLES');
    return tablas.length;
  } finally {
    await conn.end().catch(() => {});
  }
}

/** Crea el owner si no existe (no pisa la contraseña de uno existente). */
async function ensureOwner(dbUrl, { email, password, name }) {
  const conn = await mysql.createConnection({ uri: dbUrl });
  try {
    const [rows] = await conn.execute('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
    if (rows.length) return { id: rows[0].id, creado: false };
    if (!password) throw new Error('Falta la contraseña del owner');
    const hash = await bcrypt.hash(password, 10);
    const [r] = await conn.execute(
      "INSERT INTO users (name, email, password, role, active) VALUES (?, ?, ?, 'owner', 1)",
      [name || 'Owner', email, hash]);
    return { id: r.insertId, creado: true };
  } finally {
    await conn.end().catch(() => {});
  }
}

/** Cifra las claves secretas de config (wa_bot_key, lead_api_keys, ...). */
function cifrarConfig(config = {}) {
  const out = {};
  for (const [k, v] of Object.entries(config)) {
    if (v === undefined) continue;
    if (SECRET_KEYS.includes(k) && v !== null && v !== '') {
      out[k] = k === 'lead_api_keys' ? encryptJSON(v) : encrypt(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function verificarDominiosLibres(dominios, exceptoId = null) {
  if (!dominios.length) return;
  const [rows] = await getControlPool().query('SELECT id, slug, dominios FROM tenants');
  for (const r of rows) {
    if (exceptoId && r.id === exceptoId) continue;
    const suyos = (typeof r.dominios === 'string' ? JSON.parse(r.dominios || '[]') : r.dominios || []).map(normHost);
    const choque = dominios.find((d) => suyos.includes(d));
    if (choque) throw new Error(`El dominio ${choque} ya es del tenant "${r.slug}"`);
  }
}

/**
 * Registra el tenant en autoatento_control.
 * @param {{slug, nombre, plan?, dbUrl, dominios?, modulos?, branding?, config?, estado?}} t
 * config puede traer secretos en claro: se cifran acá.
 */
async function registerTenant(t) {
  validarSlug(t.slug);
  if (!t.nombre) throw new Error('Falta el nombre del tenant');
  if (!t.dbUrl) throw new Error('Falta la connection string del tenant');
  const plan = t.plan || 'esencial';
  if (!PLANES.includes(plan)) throw new Error(`Plan inválido (${PLANES.join(', ')})`);
  const dominios = [...new Set((t.dominios || []).map(normHost).filter(Boolean))];
  await verificarDominiosLibres(dominios);
  const modulos = {};
  for (const [k, v] of Object.entries(t.modulos || {})) {
    if (!(k in MODULOS)) throw new Error(`Módulo desconocido: ${k}`);
    modulos[k] = !!v;
  }
  const [r] = await getControlPool().execute(
    `INSERT INTO tenants (slug, nombre, estado, plan, db_url_cifrada, dominios, modulos, branding, config)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [t.slug, t.nombre, t.estado || 'activo', plan, encrypt(t.dbUrl),
      JSON.stringify(dominios), JSON.stringify(modulos), JSON.stringify(t.branding || {}), JSON.stringify(cifrarConfig(t.config || {}))]);
  invalidate();
  return r.insertId;
}

module.exports = {
  createTenantSchema, loadBaseSchema, ensureOwner, registerTenant, cifrarConfig,
  validarSlug, schemaName, quoteId, PLANES,
};
