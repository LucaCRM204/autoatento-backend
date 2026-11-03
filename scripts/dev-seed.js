#!/usr/bin/env node
/**
 * npm run dev:seed
 *
 * SOLO DESARROLLO. Arma dos tenants locales con datos distintos para probar
 * el aislamiento:
 *   demo-norte  "Concesionaria Demo Norte"  (todo con la palabra "Norte")
 *   demo-sur    "Concesionaria Demo Sur"    (todo con la palabra "Sur";
 *                                            módulos agente_ia y metas apagados)
 * Se abren en http://<slug>.localhost:5173 (subdominio automático) o con el
 * dominio propio simulado crm.<slug>.test (solo para probar la API).
 *
 * Cada corrida BORRA y recrea los schemas crm_demo-norte / crm_demo-sur y sus
 * filas en autoatento_control (y los tenant-a / tenant-b de antes, si quedaron).
 * Por seguridad solo toca esos slugs y se niega a correr con NODE_ENV=production.
 *
 * Usuarios (los mismos emails en los dos tenants, contraseña DEV_TENANT_PASSWORD):
 *   owner@demo.test, gerente@demo.test, super@demo.test, vend1@demo.test, vend2@demo.test
 */
require('../tenancy/env');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const env = require('../tenancy/env');
const provision = require('../tenancy/provision');
const { ensureControlSchema, createControlDatabase, getControlPool, closeControlPool } = require('../tenancy/control');
const { nowInTz } = require('../tenancy/time');

const TENANTS = [
  { slug: 'demo-norte', nombre: 'Concesionaria Demo Norte', marca: 'Norte', marcas: ['fiat'], tz: 'America/Argentina/Buenos_Aires', color: '#2563eb', modulos: {}, tel: '' },
  // Sur: dos marcas y dos módulos apagados (agente IA y metas) para probar el menú y el 403
  { slug: 'demo-sur', nombre: 'Concesionaria Demo Sur', marca: 'Sur', marcas: ['peugeot', 'citroen'], tz: 'America/Montevideo', color: '#16a34a', modulos: { agente_ia: false, metas: false }, tel: '9' },
];
/** Tenants de desarrollo de versiones anteriores del seed: se borran si quedaron. */
const ANTERIORES = ['tenant-a', 'tenant-b'];
const PERMITIDOS = new Set([...TENANTS.map((t) => t.slug), ...ANTERIORES]);

async function borrarTenant(slug) {
  if (!PERMITIDOS.has(slug)) throw new Error(`dev-seed no borra "${slug}"`);
  await getControlPool().execute('DELETE FROM tenants WHERE slug = ?', [slug]);
  const conn = await mysql.createConnection({ uri: env.tenantServerUrl() });
  try {
    await conn.query(`DROP DATABASE IF EXISTS ${provision.quoteId(provision.schemaName(slug))}`);
  } finally {
    await conn.end();
  }
}

/** Fecha/hora local del tenant N minutos desde ahora (negativo = pasado). */
function local(tz, minutos) {
  const n = nowInTz(tz, new Date(Date.now() + minutos * 60 * 1000));
  return { fecha: n.date, hora: `${n.time}:00`, dt: `${n.date} ${n.time}:00` };
}

async function cargarDatos(dbUrl, t, password) {
  const c = await mysql.createConnection({ uri: dbUrl });
  const M = t.marca;
  try {
    const hash = await bcrypt.hash(password, 10);
    const ins = async (sql, params) => (await c.execute(sql, params))[0].insertId;

    const [[owner]] = await c.query("SELECT id FROM users WHERE email = 'owner@demo.test'");
    const gerente = await ins("INSERT INTO users (name, email, password, role, reportsTo, active) VALUES (?, 'gerente@demo.test', ?, 'gerente', ?, 1)", [`Gerente ${M}`, hash, owner.id]);
    const sup = await ins("INSERT INTO users (name, email, password, role, reportsTo, active) VALUES (?, 'super@demo.test', ?, 'supervisor', ?, 1)", [`Supervisor ${M}`, hash, gerente]);
    const v1 = await ins("INSERT INTO users (name, email, password, role, reportsTo, active) VALUES (?, 'vend1@demo.test', ?, 'vendedor', ?, 1)", [`Vendedor ${M} Uno`, hash, sup]);
    const v2 = await ins("INSERT INTO users (name, email, password, role, reportsTo, active) VALUES (?, 'vend2@demo.test', ?, 'vendedor', ?, 1)", [`Vendedor ${M} Dos`, hash, sup]);

    const leads = [];
    for (const [i, [vend, estado, tel]] of [[v1, 'nuevo', '1155550001'], [v2, 'contactado', '1155550002'], [v1, 'interesado', '1155550003']].entries()) {
      leads.push(await ins(
        `INSERT INTO leads (nombre, telefono, modelo, marca, formaPago, estado, fuente, notas, assigned_to, created_by, created_at, assigned_at)
         VALUES (?, ?, ?, ?, 'Contado', ?, 'community', ?, ?, ?, NOW(), NOW())`,
        [`Cliente ${M} ${i + 1}`, `${t.tel}${tel}`, `Modelo ${M}`, t.marcas[0], estado, `Nota del lead ${M}`, vend, owner.id]));
    }
    // Lead con oferta de aceptación vencida: el checker (loop) lo tiene que pasar a vend2
    const ofertado = await ins(
      `INSERT INTO leads (nombre, telefono, modelo, estado, fuente, pending_acceptance, current_offer_to, acceptance_expires_at, created_at)
       VALUES (?, '1100000000', ?, 'nuevo', 'community', 1, ?, NOW() - INTERVAL 5 MINUTE, NOW())`,
      [`Cliente ${M} Ofertado`, `Modelo ${M}`, v1]);

    const [l1, l2] = leads;
    await c.execute('INSERT INTO notas_internas (lead_id, texto, usuario, user_id) VALUES (?, ?, ?, ?)', [l1, `Nota interna ${M}`, `Supervisor ${M}`, sup]);
    await c.execute("INSERT INTO alertas (user_id, type, message, lead_id) VALUES (?, 'manual', ?, ?)", [v1, `Alerta ${M}`, l1]);
    await c.execute("INSERT INTO alertas (user_id, type, message, lead_id) VALUES (?, 'manual', ?, ?)", [owner.id, `Alerta owner ${M}`, l1]);
    const futuro = local(t.tz, 24 * 60);
    await c.execute('INSERT INTO recordatorios (lead_id, fecha, hora, descripcion, created_by) VALUES (?, ?, ?, ?, ?)', [l1, futuro.fecha, futuro.hora, `Recordatorio futuro ${M}`, sup]);
    // Vencido hace 5 min en la hora local del tenant: el scanner (loop) tiene que avisarlo
    const vencido = local(t.tz, -5);
    await c.execute('INSERT INTO recordatorios (lead_id, fecha, hora, descripcion, created_by) VALUES (?, ?, ?, ?, ?)', [l2, vencido.fecha, vencido.hora, `Recordatorio vencido ${M}`, sup]);
    await c.execute(
      "INSERT INTO tareas_asignadas (lead_id, asignado_a, created_by, tipo, prioridad, fecha_limite, descripcion) VALUES (?, ?, ?, 'seguimiento', 'alta', ?, ?)",
      [l1, v1, sup, futuro.dt, `Tarea ${M}`]);
    await c.execute("INSERT INTO cotizaciones (lead_id, vehiculo, precio_contado, anticipo, created_by) VALUES (?, ?, 1000000, 200000, ?)", [l1, `Vehiculo ${M}`, v1]);
    await c.execute("INSERT INTO presupuestos (modelo, marca, precio_contado, created_by) VALUES (?, ?, 1500000, ?)", [`Presupuesto ${M}`, t.marcas[0], owner.id]);
    await c.execute("INSERT INTO metas (vendedor_id, mes, meta_ventas, meta_leads, created_by) VALUES (?, ?, 5, 20, ?)", [v1, nowInTz(t.tz).monthKey, gerente]);
    await c.execute("INSERT INTO call_logs (lead_id, user_id, telefono, duracion_segundos, resultado, notas) VALUES (?, ?, '1155550001', 60, 'contactado', ?)", [l1, v1, `Llamada ${M}`]);
    const phone = `54911555500${t.tel ? '91' : '01'}`;
    await c.execute("INSERT INTO wa_conversations (phone, session_id, nombre, modelo) VALUES (?, ?, ?, ?)", [phone, `user_${v1}`, `Cliente ${M} 1`, `Modelo ${M}`]);
    await c.execute("INSERT INTO wa_messages (session_id, lead_id, phone, direction, message) VALUES (?, ?, ?, 'in', ?)", [`user_${v1}`, l1, phone, `Hola, mensaje de WhatsApp ${M}`]);
    await c.execute("INSERT INTO wa_messages (session_id, lead_id, phone, direction, message) VALUES (?, ?, ?, 'out', ?)", [`user_${v1}`, l1, phone, `Respuesta WhatsApp ${M}`]);
    await c.execute("INSERT INTO distribucion_equipos (lider_id, modo, nota) VALUES (?, 'plano', ?)", [sup, `Equipo ${M}`]);

    return { owner: owner.id, gerente, sup, v1, v2, leads, ofertado };
  } finally {
    await c.end();
  }
}

/** Borra y recrea un tenant de desarrollo con el mismo circuito que el panel (schema + migraciones + owner). */
async function seedTenant(t, password) {
  await borrarTenant(t.slug);
  const r = await provision.crearTenant({
    slug: t.slug,
    nombre: t.nombre,
    plan: 'pro',
    // Dominio propio simulado (el subdominio <slug>.localhost no hace falta cargarlo)
    dominios: [`crm.${t.slug}.test`],
    modulos: t.modulos,
    branding: { nombre: t.nombre, color_primario: t.color },
    config: {
      timezone: t.tz, pais: 'Argentina', prefijo_telefonico: '54', moneda: 'ARS',
      marcas: t.marcas, marca_default: t.marcas[0],
      wa_bot_url: `http://127.0.0.1:9/wa-${t.slug}`,
      wa_bot_key: crypto.randomBytes(16).toString('hex'),
      lead_api_keys: {
        'whatsapp-bot': crypto.randomBytes(16).toString('hex'),
        'sheet-emanuel': crypto.randomBytes(16).toString('hex'),
      },
      agent_mcp_key: crypto.randomBytes(16).toString('hex'),
    },
    owner: { email: 'owner@demo.test', password, name: `Owner ${t.marca}` },
  });
  const dbUrl = env.withDatabase(env.tenantServerUrl(), provision.schemaName(t.slug));
  const ids = await cargarDatos(dbUrl, t, password);
  console.log(`✅ ${t.slug} (#${r.id}): ${r.migraciones.aplicadas.length} migraciones, ${ids.leads.length + 1} leads, 5 usuarios`);
  return r;
}

async function seed({ slugs = null } = {}) {
  if (process.env.NODE_ENV === 'production') throw new Error('dev-seed no corre con NODE_ENV=production');
  const password = process.env.DEV_TENANT_PASSWORD;
  if (!password) throw new Error('Falta DEV_TENANT_PASSWORD en el .env');

  await createControlDatabase();
  await ensureControlSchema();
  if (!slugs) {
    for (const slug of ANTERIORES) await borrarTenant(slug);
  }
  for (const t of TENANTS) {
    if (!slugs || slugs.includes(t.slug)) await seedTenant(t, password);
  }
}

module.exports = { seed, borrarTenant, TENANTS };

if (require.main === module) {
  seed()
    .then(() => console.log('\nLogin: owner@demo.test (o gerente/super/vend1/vend2) con DEV_TENANT_PASSWORD, header X-Tenant: demo-norte | demo-sur'))
    .catch((e) => { console.error('❌', e.message); process.exitCode = 1; })
    .finally(() => closeControlPool());
}
