/**
 * Entorno de los tests de aislamiento (Fase 4).
 *
 * Cada corrida usa su propio espacio en la base de desarrollo:
 *   schemas  crm_test_<run>_a, crm_test_<run>_b
 *   tenants  test-<run>-a, test-<run>-b   (dominio propio crm.test-<run>-a.test, ...)
 *   superadmin test-<run>@autoatento.test
 * y lo borra al terminar. Al arrancar también borra restos de corridas
 * anteriores que se hayan cortado (crm_test_* / test-*). Nunca toca otros
 * schemas ni tenants (demo-norte / demo-sur de dev:seed quedan intactos).
 *
 * No va dentro de test/ para que `node --test` no lo tome como archivo de tests.
 */
require('../tenancy/env');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const env = require('../tenancy/env');
const provision = require('../tenancy/provision');
const registry = require('../tenancy/registry');
const { getControlPool, closeControlPool, createControlDatabase, ensureControlSchema } = require('../tenancy/control');
const { closeAll } = require('../tenancy/pools');
const { nowInTz } = require('../tenancy/time');

if (process.env.NODE_ENV === 'production') throw new Error('Los tests no corren con NODE_ENV=production');
if (!process.env.DEV_MYSQL_URL && !process.env.TENANT_DB_SERVER_URL) {
  throw new Error('Los tests necesitan la MySQL de desarrollo (DEV_MYSQL_URL en el .env)');
}

const RUN = crypto.randomBytes(3).toString('hex');
const PASSWORD = `Test-${crypto.randomBytes(8).toString('hex')}`;
const SA_EMAIL = `test-${RUN}@autoatento.test`;
const SA_PASSWORD = `Sa-${crypto.randomBytes(10).toString('hex')}`;
const PREFIJO = `test-${RUN}-`;

const schemaDe = (sufijo) => `crm_test_${RUN}_${sufijo}`;
const q = (n) => `\`${String(n).replace(/`/g, '')}\``;

async function servidor() {
  return mysql.createConnection({ uri: env.tenantServerUrl() });
}

/** Borra restos de corridas anteriores: solo crm_test_* y tenants test-*. */
async function limpiarRestos() {
  const c = await servidor();
  try {
    const [dbs] = await c.query("SHOW DATABASES LIKE 'crm\\_test\\_%'");
    for (const row of dbs) await c.query(`DROP DATABASE IF EXISTS ${q(Object.values(row)[0])}`);
  } finally {
    await c.end();
  }
  const ctrl = getControlPool();
  const [ts] = await ctrl.query("SELECT id FROM tenants WHERE slug LIKE 'test-%'");
  if (ts.length) await ctrl.query('DELETE FROM audit_log WHERE tenant_id IN (?)', [ts.map((t) => t.id)]);
  await ctrl.query("DELETE FROM tenants WHERE slug LIKE 'test-%'");
  await ctrl.query("DELETE FROM superadmins WHERE email LIKE 'test-%@autoatento.test'");
}

/** Hora local del tenant N minutos desde ahora. */
function local(tz, minutos) {
  const n = nowInTz(tz, new Date(Date.now() + minutos * 60 * 1000));
  return { fecha: n.date, hora: `${n.time}:00`, dt: `${n.date} ${n.time}:00` };
}

/**
 * Crea un tenant de prueba con datos marcados con `marca` (texto único de la
 * corrida) en todas las tablas que se verifican: leads, notas, alertas,
 * recordatorios, tareas, wa_messages, agent_actions.
 */
async function crearTenant(sufijo, { modulos = {}, tz = 'America/Argentina/Buenos_Aires' } = {}) {
  const slug = `${PREFIJO}${sufijo}`;
  const marca = `Marca${sufijo.toUpperCase()}${RUN}`;
  const c = await servidor();
  try {
    await c.query(`CREATE DATABASE ${q(schemaDe(sufijo))} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally {
    await c.end();
  }
  const dbUrl = env.withDatabase(env.tenantServerUrl(), schemaDe(sufijo));
  const keys = { 'whatsapp-bot': crypto.randomBytes(16).toString('hex'), 'sheet-emanuel': crypto.randomBytes(16).toString('hex') };
  const r = await provision.crearTenant({
    slug, nombre: `Test ${marca}`, plan: 'pro', dbUrl, migrar: true,
    dominios: [`crm.${slug}.test`], // dominio propio simulado (<slug>.localhost resuelve solo)
    modulos,
    branding: { nombre: `Concesionaria ${marca}` },
    config: { timezone: tz, marcas: ['fiat'], marca_default: 'fiat', wa_bot_url: 'http://127.0.0.1:9/bot', lead_api_keys: keys },
    owner: { email: 'owner@test.local', password: PASSWORD, name: `Owner ${marca}` },
  });

  const db = await mysql.createConnection({ uri: dbUrl });
  try {
    const hash = await bcrypt.hash(PASSWORD, 8);
    const ins = async (sql, p) => (await db.execute(sql, p))[0].insertId;
    const owner = r.owner.id;
    const sup = await ins("INSERT INTO users (name, email, password, role, reportsTo) VALUES (?, 'super@test.local', ?, 'supervisor', ?)", [`Super ${marca}`, hash, owner]);
    const v1 = await ins("INSERT INTO users (name, email, password, role, reportsTo) VALUES (?, 'vend1@test.local', ?, 'vendedor', ?)", [`Vend1 ${marca}`, hash, sup]);
    const v2 = await ins("INSERT INTO users (name, email, password, role, reportsTo) VALUES (?, 'vend2@test.local', ?, 'vendedor', ?)", [`Vend2 ${marca}`, hash, sup]);
    const lead = await ins(
      "INSERT INTO leads (nombre, telefono, modelo, marca, estado, fuente, assigned_to, created_by, assigned_at) VALUES (?, '1155550001', 'Modelo', 'fiat', 'contactado', 'community', ?, ?, NOW())",
      [`Lead ${marca}`, v1, owner]);
    const ofertado = await ins(
      "INSERT INTO leads (nombre, telefono, modelo, estado, fuente, pending_acceptance, current_offer_to, acceptance_expires_at) VALUES (?, '1100000000', 'Modelo', 'nuevo', 'community', 1, ?, NOW() - INTERVAL 5 MINUTE)",
      [`Ofertado ${marca}`, v1]);
    await db.execute('INSERT INTO notas_internas (lead_id, texto, usuario, user_id) VALUES (?, ?, ?, ?)', [lead, `Nota ${marca}`, `Super ${marca}`, sup]);
    await db.execute("INSERT INTO alertas (user_id, type, message, lead_id) VALUES (?, 'manual', ?, ?)", [owner, `Alerta ${marca}`, lead]);
    const fut = local(tz, 24 * 60);
    await db.execute('INSERT INTO recordatorios (lead_id, fecha, hora, descripcion, created_by) VALUES (?, ?, ?, ?, ?)', [lead, fut.fecha, fut.hora, `Recordatorio ${marca}`, sup]);
    const venc = local(tz, -5);
    await db.execute('INSERT INTO recordatorios (lead_id, fecha, hora, descripcion, created_by) VALUES (?, ?, ?, ?, ?)', [lead, venc.fecha, venc.hora, `Vencido ${marca}`, sup]);
    await db.execute("INSERT INTO tareas_asignadas (lead_id, asignado_a, created_by, fecha_limite, descripcion) VALUES (?, ?, ?, ?, ?)", [lead, v1, sup, fut.dt, `Tarea ${marca}`]);
    await db.execute("INSERT INTO wa_messages (session_id, lead_id, phone, direction, message) VALUES (?, ?, '5491155550001', 'in', ?)", [`user_${v1}`, lead, `WhatsApp ${marca}`]);
    await db.execute("INSERT INTO agent_actions (lead_id, tool, args, reason, status) VALUES (?, 'add_nota', '{}', ?, 'pending')", [lead, `Accion ${marca}`]);
    return { id: r.id, slug, sufijo, marca, dbUrl, keys, ids: { owner, sup, v1, v2, lead, ofertado }, migraciones: r.migraciones };
  } finally {
    await db.end();
  }
}

async function crearSuperadmin() {
  await getControlPool().execute(
    'INSERT INTO superadmins (email, password, nombre, activo) VALUES (?, ?, ?, 1)',
    [SA_EMAIL, await bcrypt.hash(SA_PASSWORD, 8), `Test ${RUN}`]);
}

/** Borra todo lo de esta corrida. */
async function limpiar() {
  try {
    await limpiarRestos();
  } finally {
    await closeAll();
    await closeControlPool();
  }
}

async function preparar() {
  await createControlDatabase();
  await ensureControlSchema();
  await limpiarRestos();
  registry.invalidate();
}

/** Consulta directa a la base de un tenant de prueba. */
async function enBase(tenant, sql, params = []) {
  const c = await mysql.createConnection({ uri: tenant.dbUrl });
  try {
    const [rows] = await c.query(sql, params);
    return rows;
  } finally {
    await c.end();
  }
}

/** Espera hasta que fn() devuelva algo truthy (o vence el plazo). */
async function esperar(fn, { ms = 30000, cada = 500 } = {}) {
  const hasta = Date.now() + ms;
  let ultimo;
  while (Date.now() < hasta) {
    ultimo = await fn();
    if (ultimo) return ultimo;
    await new Promise((r) => setTimeout(r, cada));
  }
  return ultimo;
}

module.exports = {
  RUN, PASSWORD, SA_EMAIL, SA_PASSWORD, PREFIJO,
  preparar, crearTenant, crearSuperadmin, limpiar, enBase, esperar, schemaDe,
};
