#!/usr/bin/env node
/**
 * npm run tenant:add -- --slug <slug> --nombre "<nombre>" (--create-schema | --db-url <mysql://...>) [opciones]
 *
 * Alta de un tenant por línea de comandos (lo mismo que hace el panel
 * superadmin: POST /api/superadmin/tenants).
 *
 *   --create-schema           crea crm_<slug> en TENANT_DB_SERVER_URL y le corre las migraciones
 *   --db-url <url>            usa una base existente (ej. la de un cliente ya en producción).
 *                             Corre las migraciones salvo que pases --sin-migrar.
 *   --plan esencial|pro|arm
 *   --dominio <host>          repetible: dominios propios del cliente (el subdominio
 *                             <slug>.<BASE_DOMAIN> funciona solo, no se carga acá)
 *   --owner-email / --owner-name   owner (obligatorio con --create-schema). La contraseña
 *                             va en la variable OWNER_PASSWORD (no queda en el historial).
 *   --branding-nombre / --logo-url / --color
 *   --timezone <IANA>         default America/Argentina/Buenos_Aires
 *   --wa-bot-url <url>
 *   --marca <marca>           repetible (marcas habilitadas); la primera es la default
 *   --marca-default <marca>
 *   --modulo nombre=0|1       repetible
 *
 * Los secretos (wa_bot_key, lead_api_keys, agent_mcp_key, openai_api_key) se
 * cargan desde el panel superadmin (PATCH /api/superadmin/tenants/:id), no
 * por línea de comandos.
 */
require('../tenancy/env');
const { parseArgs } = require('util');
const provision = require('../tenancy/provision');
const { ensureControlSchema, closeControlPool } = require('../tenancy/control');

const { values: a } = parseArgs({
  options: {
    slug: { type: 'string' }, nombre: { type: 'string' }, plan: { type: 'string' },
    'create-schema': { type: 'boolean' }, 'db-url': { type: 'string' }, 'sin-migrar': { type: 'boolean' },
    dominio: { type: 'string', multiple: true },
    'owner-email': { type: 'string' }, 'owner-name': { type: 'string' },
    'branding-nombre': { type: 'string' }, 'logo-url': { type: 'string' }, color: { type: 'string' },
    timezone: { type: 'string' }, 'wa-bot-url': { type: 'string' },
    marca: { type: 'string', multiple: true }, 'marca-default': { type: 'string' },
    modulo: { type: 'string', multiple: true },
  },
});

async function main() {
  if (!a.slug || !a.nombre) throw new Error('Faltan --slug y --nombre');
  if (!!a['create-schema'] === !!a['db-url']) throw new Error('Usá --create-schema o --db-url (uno de los dos)');
  await ensureControlSchema();

  const modulos = {};
  for (const m of a.modulo || []) {
    const [k, v] = m.split('=');
    modulos[k] = v === '1' || v === 'true';
  }
  const branding = {};
  if (a['branding-nombre']) branding.nombre = a['branding-nombre'];
  if (a['logo-url']) branding.logo_url = a['logo-url'];
  if (a.color) branding.color_primario = a.color;
  const config = { timezone: a.timezone || 'America/Argentina/Buenos_Aires', pais: 'Argentina', prefijo_telefonico: '54', moneda: 'ARS' };
  if (a['wa-bot-url']) config.wa_bot_url = a['wa-bot-url'];
  if (a.marca?.length) {
    config.marcas = a.marca.map((m) => m.toLowerCase());
    config.marca_default = (a['marca-default'] || a.marca[0]).toLowerCase();
  }

  const r = await provision.crearTenant({
    slug: a.slug, nombre: a.nombre, plan: a.plan, dominios: a.dominio || [], modulos, branding, config,
    dbUrl: a['db-url'] || null,
    migrar: !a['sin-migrar'],
    owner: a['owner-email'] ? { email: a['owner-email'], password: process.env.OWNER_PASSWORD, name: a['owner-name'] } : null,
  });
  if (r.schemaCreado) console.log(`🗄️  Schema ${provision.schemaName(a.slug)} creado`);
  console.log(r.migraciones.omitidas ? '🗄️  Migraciones omitidas (--sin-migrar)' : `🗄️  Migraciones aplicadas: ${r.migraciones.aplicadas.join(', ') || 'ninguna (al día)'}`);
  if (r.owner) console.log(r.owner.creado ? `👤 Owner creado (#${r.owner.id})` : `👤 El owner ya existía (#${r.owner.id})`);
  console.log(`✅ Tenant "${r.slug}" registrado (#${r.id})`);
  const url = require('../tenancy/subdominios').urlDeSlug(r.slug);
  console.log(url ? `🌐 ${url}` : '🌐 Sin BASE_DOMAIN: el CRM se abre solo por sus dominios propios');
}

main()
  .catch((e) => { console.error('❌', e.message); process.exitCode = 1; })
  .finally(() => closeControlPool());
