#!/usr/bin/env node
/**
 * npm run tenant:add -- --slug <slug> --nombre "<nombre>" (--create-schema | --db-url <mysql://...>) [opciones]
 *
 * Alta de un tenant por línea de comandos (hasta que esté el panel superadmin, Fase 2).
 *
 *   --create-schema           crea crm_<slug> en TENANT_DB_SERVER_URL y carga database.sql
 *   --db-url <url>            usa una base existente (ej. la de un cliente ya en producción).
 *                             NO carga el esquema salvo que pases --load-schema.
 *   --plan esencial|pro|arm
 *   --dominio <host>          repetible
 *   --owner-email / --owner-password / --owner-name   crea el owner si no existe
 *   --branding-nombre / --logo-url / --color          branding visible
 *   --timezone <IANA>         default America/Argentina/Buenos_Aires
 *   --wa-bot-url <url> / --wa-bot-key <key>
 *   --lead-key proveedor:clave                        repetible (API keys de webhooks)
 *   --mcp-key <key> / --openai-key <key>
 *   --modulo nombre=0|1                               repetible
 *
 * Ojo: las claves pasadas por línea de comandos quedan en el historial de la
 * terminal. En la Fase 2 esto se hace desde el panel.
 */
require('../tenancy/env');
const { parseArgs } = require('util');
const provision = require('../tenancy/provision');
const { ensureControlSchema, getControlPool, closeControlPool } = require('../tenancy/control');

const { values: a } = parseArgs({
  options: {
    slug: { type: 'string' }, nombre: { type: 'string' }, plan: { type: 'string' },
    'create-schema': { type: 'boolean' }, 'db-url': { type: 'string' }, 'load-schema': { type: 'boolean' },
    dominio: { type: 'string', multiple: true },
    'owner-email': { type: 'string' }, 'owner-password': { type: 'string' }, 'owner-name': { type: 'string' },
    'branding-nombre': { type: 'string' }, 'logo-url': { type: 'string' }, color: { type: 'string' },
    timezone: { type: 'string' }, 'wa-bot-url': { type: 'string' }, 'wa-bot-key': { type: 'string' },
    'lead-key': { type: 'string', multiple: true }, 'mcp-key': { type: 'string' }, 'openai-key': { type: 'string' },
    modulo: { type: 'string', multiple: true },
  },
});

async function main() {
  if (!a.slug || !a.nombre) throw new Error('Faltan --slug y --nombre');
  if (!!a['create-schema'] === !!a['db-url']) throw new Error('Usá --create-schema o --db-url (uno de los dos)');
  provision.validarSlug(a.slug);
  await ensureControlSchema();
  const [existe] = await getControlPool().execute('SELECT id FROM tenants WHERE slug = ?', [a.slug]);
  if (existe.length) throw new Error(`Ya existe un tenant con slug "${a.slug}" (#${existe[0].id}); no se tocó nada`);

  let dbUrl = a['db-url'];
  if (a['create-schema']) {
    dbUrl = await provision.createTenantSchema(a.slug);
    console.log(`🗄️  Schema ${provision.schemaName(a.slug)} creado`);
  }
  if (a['create-schema'] || a['load-schema']) {
    const n = await provision.loadBaseSchema(dbUrl);
    console.log(`🗄️  Esquema base cargado (${n} tablas)`);
  }
  if (a['owner-email']) {
    const o = await provision.ensureOwner(dbUrl, { email: a['owner-email'], password: a['owner-password'], name: a['owner-name'] });
    console.log(o.creado ? `👤 Owner creado (#${o.id})` : `👤 El owner ya existía (#${o.id})`);
  }

  const leadKeys = {};
  for (const lk of a['lead-key'] || []) {
    const i = lk.indexOf(':');
    if (i < 1) throw new Error(`--lead-key inválida (proveedor:clave): ${lk}`);
    leadKeys[lk.slice(0, i)] = lk.slice(i + 1);
  }
  const modulos = {};
  for (const m of a.modulo || []) {
    const [k, v] = m.split('=');
    modulos[k] = v === '1' || v === 'true';
  }
  const branding = {};
  if (a['branding-nombre']) branding.nombre = a['branding-nombre'];
  if (a['logo-url']) branding.logo_url = a['logo-url'];
  if (a.color) branding.color_primario = a.color;

  const config = {
    timezone: a.timezone || 'America/Argentina/Buenos_Aires',
    pais: 'Argentina', prefijo_telefonico: '54', moneda: 'ARS',
  };
  if (a['wa-bot-url']) config.wa_bot_url = a['wa-bot-url'];
  if (a['wa-bot-key']) config.wa_bot_key = a['wa-bot-key'];
  if (Object.keys(leadKeys).length) config.lead_api_keys = leadKeys;
  if (a['mcp-key']) config.agent_mcp_key = a['mcp-key'];
  if (a['openai-key']) config.openai_api_key = a['openai-key'];

  const id = await provision.registerTenant({
    slug: a.slug, nombre: a.nombre, plan: a.plan, dbUrl, dominios: a.dominio || [], modulos, branding, config,
  });
  console.log(`✅ Tenant "${a.slug}" registrado (#${id})`);
}

main()
  .catch((e) => { console.error('❌', e.message); process.exitCode = 1; })
  .finally(() => closeControlPool());
