#!/usr/bin/env node
/**
 * npm run dev:seed
 *
 * SOLO DESARROLLO. Arma dos tenants locales con datos distintos para probar
 * el aislamiento:
 *   tenant-a  "Concesionaria Alfa"   dominio tenant-a.localhost   (todo con la palabra "Alfa")
 *   tenant-b  "Concesionaria Bravo"  dominio tenant-b.localhost   (todo con la palabra "Bravo",
 *                                                                 módulo agente_ia apagado)
 *
 * Cada corrida BORRA y recrea los schemas crm_tenant-a / crm_tenant-b y sus
 * filas en autoatento_control. Por seguridad solo toca esos dos slugs y se
 * niega a correr con NODE_ENV=production.
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
  { slug: 'tenant-a', marca: 'Alfa', tz: 'America/Argentina/Buenos_Aires', color: '#2563eb', modulos: {} },
  { slug: 'tenant-b', marca: 'Bravo', tz: 'America/Montevideo', color: '#16a34a', modulos: { agente_ia: false } },
];
const PERMITIDOS = new Set(TENANTS.map((t) => t.slug));

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
         VALUES (?, ?, ?, 'fiat', 'Contado', ?, 'community', ?, ?, ?, NOW(), NOW())`,
        [`Cliente ${M} ${i + 1}`, `${t.slug === 'tenant-a' ? '' : '9'}${tel}`, `Modelo ${M}`, estado, `Nota del lead ${M}`, vend, owner.id]));
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
    await c.execute("INSERT INTO presupuestos (modelo, marca, precio_contado, created_by) VALUES (?, 'fiat', 1500000, ?)", [`Presupuesto ${M}`, owner.id]);
    await c.execute("INSERT INTO metas (vendedor_id, mes, meta_ventas, meta_leads, created_by) VALUES (?, ?, 5, 20, ?)", [v1, nowInTz(t.tz).monthKey, gerente]);
    await c.execute("INSERT INTO call_logs (lead_id, user_id, telefono, duracion_segundos, resultado, notas) VALUES (?, ?, '1155550001', 60, 'contactado', ?)", [l1, v1, `Llamada ${M}`]);
    const phone = `54911555500${t.slug === 'tenant-a' ? '01' : '91'}`;
    await c.execute("INSERT INTO wa_conversations (phone, session_id, nombre, modelo) VALUES (?, ?, ?, ?)", [phone, `user_${v1}`, `Cliente ${M} 1`, `Modelo ${M}`]);
    await c.execute("INSERT INTO wa_messages (session_id, lead_id, phone, direction, message) VALUES (?, ?, ?, 'in', ?)", [`user_${v1}`, l1, phone, `Hola, mensaje de WhatsApp ${M}`]);
    await c.execute("INSERT INTO wa_messages (session_id, lead_id, phone, direction, message) VALUES (?, ?, ?, 'out', ?)", [`user_${v1}`, l1, phone, `Respuesta WhatsApp ${M}`]);
    await c.execute("INSERT INTO distribucion_equipos (lider_id, modo, nota) VALUES (?, 'plano', ?)", [sup, `Equipo ${M}`]);

    return { owner: owner.id, gerente, sup, v1, v2, leads, ofertado };
  } finally {
    await c.end();
  }
}

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('dev-seed no corre con NODE_ENV=production');
  const password = process.env.DEV_TENANT_PASSWORD;
  if (!password) throw new Error('Falta DEV_TENANT_PASSWORD en el .env');

  await createControlDatabase();
  await ensureControlSchema();

  for (const t of TENANTS) {
    await borrarTenant(t.slug);
    const dbUrl = await provision.createTenantSchema(t.slug);
    const tablas = await provision.loadBaseSchema(dbUrl);
    await provision.ensureOwner(dbUrl, { email: 'owner@demo.test', password, name: `Owner ${t.marca}` });
    const ids = await cargarDatos(dbUrl, t, password);
    const id = await provision.registerTenant({
      slug: t.slug,
      nombre: `Concesionaria ${t.marca}`,
      plan: 'pro',
      dbUrl,
      dominios: [`${t.slug}.localhost`],
      modulos: t.modulos,
      branding: { nombre: `Concesionaria ${t.marca}`, color_primario: t.color },
      config: {
        timezone: t.tz, pais: 'Argentina', prefijo_telefonico: '54', moneda: 'ARS',
        wa_bot_url: `http://127.0.0.1:9/wa-${t.slug}`,
        wa_bot_key: crypto.randomBytes(16).toString('hex'),
        lead_api_keys: {
          'whatsapp-bot': crypto.randomBytes(16).toString('hex'),
          'sheet-emanuel': crypto.randomBytes(16).toString('hex'),
        },
        agent_mcp_key: crypto.randomBytes(16).toString('hex'),
      },
    });
    console.log(`✅ ${t.slug} (#${id}): ${tablas} tablas, ${ids.leads.length + 1} leads, 5 usuarios`);
  }
  console.log('\nLogin: owner@demo.test (o gerente/super/vend1/vend2) con DEV_TENANT_PASSWORD, header X-Tenant: tenant-a | tenant-b');
}

main()
  .catch((e) => { console.error('❌', e.message); process.exitCode = 1; })
  .finally(() => closeControlPool());
