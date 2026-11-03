#!/usr/bin/env node
/**
 * npm run smoke:fase2
 *
 * Verificación de la Fase 2 contra la base de desarrollo. SOLO DESARROLLO:
 * borra y recrea crm_demo-sur varias veces y al final deja demo-norte y
 * demo-sur como los arma `npm run dev:seed`.
 *
 *   - login superadmin separado de los CRMs
 *   - alta de tenant de punta a punta (schema + migraciones + owner) y rollback si falla
 *   - "usar base existente" con una base vieja (marca ENUM, sin schema_migrations):
 *     migraciones con dry-run, AUTO_MIGRATE al arrancar, idempotencia
 *   - runner: un tenant roto y una migración que falla no frenan a los demás
 *   - edición (branding, módulos, config, secretos), validaciones y auditoría
 *   - suspender / reactivar: 402, sockets cortados en el momento y por el vigilante
 *   - uso mensual (usuarios activos, leads, bot) y "entrar como owner"
 */
require('../tenancy/env');
const path = require('path');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const { spawnSync } = require('child_process');
const { io: ioClient } = require('socket.io-client');
const env = require('../tenancy/env');
const provision = require('../tenancy/provision');
const registry = require('../tenancy/registry');
const { migrateTenants, migrateDatabase, listMigrations } = require('../tenancy/migrate');
const { getControlPool, closeControlPool } = require('../tenancy/control');
const { nowInTz } = require('../tenancy/time');
const { seed, borrarTenant } = require('./dev-seed');
const { levantarServer, sleep } = require('./lib/test-server');

const PASSWORD = process.env.DEV_TENANT_PASSWORD;
const SA_EMAIL = 'smoke-superadmin@demo.test'; // propio: no pisa el superadmin de desarrollo
const SA_PASSWORD = `${PASSWORD}-superadmin`;
const SERVER_ENV = { SUSPENSION_WATCH_MS: '1500', AGENT_DISABLED: '1' };
const urlB = () => env.withDatabase(env.tenantServerUrl(), provision.schemaName('demo-sur'));

const resultados = [];
function check(nombre, ok, detalle = '') {
  resultados.push({ nombre, ok: !!ok });
  console.log(`${ok ? '✅' : '❌'} ${nombre}${!ok && detalle ? `  ->  ${String(detalle).slice(0, 400)}` : ''}`);
}

async function enB(fn) {
  const c = await mysql.createConnection({ uri: urlB() });
  try { return await fn(c); } finally { await c.end(); }
}
const tipoMarca = (c) => c.query("SELECT DATA_TYPE AS t, CHARACTER_MAXIMUM_LENGTH AS len FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leads' AND COLUMN_NAME = 'marca'").then(([[r]]) => r);

function conectarSocket(base, token, slug) {
  return new Promise((resolve) => {
    const s = ioClient(base, { auth: { token, tenant: slug }, transports: ['websocket'], reconnection: false, timeout: 5000 });
    const st = { s, ok: false, eventos: [], desconectado: false };
    s.onAny((ev, data) => st.eventos.push({ ev, data }));
    s.on('disconnect', () => { st.desconectado = true; });
    s.on('connect', () => { st.ok = true; resolve(st); });
    s.on('connect_error', (e) => { st.error = e.message; resolve(st); });
  });
}

async function main() {
  if (!PASSWORD) throw new Error('Falta DEV_TENANT_PASSWORD');
  if (process.env.NODE_ENV === 'production') throw new Error('No correr en producción');

  console.log('Preparando: dev:seed + superadmin de prueba...');
  await seed();
  const sa = spawnSync(process.execPath, [path.join(__dirname, 'superadmin-add.js'), '--email', SA_EMAIL, '--nombre', 'Smoke'],
    { env: { ...process.env, SUPERADMIN_PASSWORD: SA_PASSWORD }, encoding: 'utf8' });
  if (sa.status !== 0) throw new Error(`superadmin:add falló: ${sa.stderr}`);

  let srv = await levantarServer(SERVER_ENV);
  const mk = () => axios.create({ baseURL: `${srv.base}/api`, validateStatus: () => true, timeout: 60000 });
  let http = mk();
  const A = await registry.getBySlug('demo-norte');

  try {
    // ---------- Auth superadmin ----------
    check('superadmin sin token -> 401', (await http.get('/superadmin/tenants')).status === 401);
    check('superadmin contraseña mala -> 401', (await http.post('/superadmin/login', { email: SA_EMAIL, password: 'mala-mala-mala' })).status === 401);
    const lsa = await http.post('/superadmin/login', { email: SA_EMAIL, password: SA_PASSWORD });
    const SA = { headers: { Authorization: `Bearer ${lsa.data.token}` } };
    check('superadmin login -> token con scope superadmin', lsa.status === 200 && jwt.decode(lsa.data.token)?.scope === 'superadmin', JSON.stringify(lsa.data));
    const ownerA = (await http.post('/auth/login', { email: 'owner@demo.test', password: PASSWORD }, { headers: { 'X-Tenant': 'demo-norte' } })).data.token;
    check('token de un CRM no sirve en el panel -> 401', (await http.get('/superadmin/tenants', { headers: { Authorization: `Bearer ${ownerA}` } })).status === 401);
    const crmConSa = await http.get('/leads', { headers: { 'X-Tenant': 'demo-norte', Authorization: `Bearer ${lsa.data.token}` } });
    check('token de superadmin no sirve en un CRM', [401, 403].includes(crmConSa.status), crmConSa.status);

    const lista = await http.get('/superadmin/tenants', SA);
    const txtLista = JSON.stringify(lista.data);
    const keysA = registry.secretsOf(A).lead_api_keys;
    check('lista de tenants sin secretos (base enmascarada, keys ocultas)',
      lista.status === 200 && lista.data.tenants.some((t) => t.slug === 'demo-norte') &&
      !Object.values(keysA).some((k) => txtLista.includes(k)) &&
      !txtLista.includes(decodeURIComponent(new URL(registry.dbUrlOf(A)).password) || '\u0000') &&
      lista.data.tenants.every((t) => !/:\/\/[^/@]*@/.test(t.base) || t.base.includes(':***@')) &&
      lista.data.tenants.find((t) => t.slug === 'demo-norte').secretos.lead_api_keys.includes('whatsapp-bot'), txtLista.slice(0, 400));

    // ---------- Alta de punta a punta ----------
    await borrarTenant('demo-sur');
    registry.invalidate();
    const altaB = {
      slug: 'demo-sur', nombre: 'Concesionaria Demo Sur', plan: 'pro', dominios: ['crm.demo-sur.test'],
      branding: { nombre: 'Concesionaria Demo Sur', color_primario: '#16a34a' }, modulos: { agente_ia: false },
      config: { timezone: 'America/Montevideo', lead_api_keys: { 'whatsapp-bot': 'clave-de-prueba-bravo-123456' } },
      owner: { email: 'owner@demo.test', password: 'corta', name: 'Owner Sur' },
    };
    const fallida = await http.post('/superadmin/tenants', altaB, SA);
    const quedoSchema = await provision.schemaTableCount('demo-sur');
    const [quedoFila] = await getControlPool().execute("SELECT id FROM tenants WHERE slug = 'demo-sur'");
    check('alta que falla en el owner -> 400 y rollback (sin schema ni registro)', fallida.status === 400 && quedoSchema === null && !quedoFila.length,
      `${fallida.status} ${JSON.stringify(fallida.data)} schema=${quedoSchema} fila=${quedoFila.length}`);

    altaB.owner.password = PASSWORD;
    const alta = await http.post('/superadmin/tenants', altaB, SA);
    const idB = alta.data.id;
    check('alta de tenant: schema nuevo + 5 migraciones + owner -> 201',
      alta.status === 201 && alta.data.schemaCreado && alta.data.migraciones.aplicadas.length === listMigrations().length && alta.data.owner?.creado,
      JSON.stringify(alta.data).slice(0, 300));
    const loginB = await http.post('/auth/login', { email: 'owner@demo.test', password: PASSWORD }, { headers: { 'X-Tenant': 'demo-sur' } });
    check('el owner del tenant nuevo entra a su CRM', loginB.status === 200 && jwt.decode(loginB.data.token)?.tid === idB, JSON.stringify(loginB.data).slice(0, 200));
    const leadsB = await http.get('/leads', { headers: { 'X-Tenant': 'demo-sur', Authorization: `Bearer ${loginB.data.token}` } });
    check('el tenant nuevo responde con su base vacía', leadsB.status === 200 && !JSON.stringify(leadsB.data).includes('Norte'));
    check('alta con slug repetido -> 409', (await http.post('/superadmin/tenants', altaB, SA)).status === 409);
    check('alta con slug inválido -> 400', (await http.post('/superadmin/tenants', { ...altaB, slug: 'Mal Slug!' }, SA)).status === 400);
    check('alta con dominio de otro tenant -> 409', (await http.post('/superadmin/tenants', { ...altaB, slug: 'demo-sur', dominios: ['crm.demo-norte.test'] }, SA)).status === 409);
    check('alta con schema nuevo sin owner -> 400', (await http.post('/superadmin/tenants', { ...altaB, slug: 'tenant-sin-owner', dominios: [], owner: null }, SA)).status === 400);
    check('alta con módulo desconocido -> 400', (await http.post('/superadmin/tenants', { ...altaB, modulos: { inventado: true } }, SA)).status === 400);

    // ---------- Base existente (como Fiat): vieja, sin schema_migrations ----------
    await borrarTenant('demo-sur');
    await provision.createTenantSchema('demo-sur');
    await provision.runSqlFile(urlB(), path.join(__dirname, '..', 'migrations', '000_baseline.sql'));
    await enB(async (c) => {
      await c.query("INSERT INTO users (name, email, password, role) VALUES ('Owner Viejo', 'viejo@demo.test', ?, 'owner')", [await require('bcrypt').hash(PASSWORD, 10)]);
      await c.query("INSERT INTO leads (nombre, telefono, marca) VALUES ('Lead Viejo Sur', '1100000001', 'fiat')");
    });
    const antes = await enB(tipoMarca);
    check('base vieja: leads.marca es ENUM', antes.t === 'enum', JSON.stringify(antes));
    const ex = await http.post('/superadmin/tenants', { ...altaB, db_url: urlB(), migrar: false, owner: null }, SA);
    const idBx = ex.data.id;
    check('alta con base existente sin migrar -> 201 (sin tocar la base)', ex.status === 201 && ex.data.migraciones.omitidas && !ex.data.schemaCreado, JSON.stringify(ex.data).slice(0, 300));
    const sinTabla = await enB((c) => c.query("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'schema_migrations'").then(([[r]]) => r.n));
    check('base existente: todavía sin schema_migrations', sinTabla === 0);
    const dry = await http.post(`/superadmin/tenants/${idBx}/migrar`, { dry_run: true }, SA);
    check('migrar dry-run -> 5 pendientes', dry.status === 200 && dry.data.pendientes.length === listMigrations().length, JSON.stringify(dry.data));

    // Reinicio con AUTO_MIGRATE=1: tiene que migrar demo-sur al arrancar
    await srv.stop();
    srv = await levantarServer({ ...SERVER_ENV, AUTO_MIGRATE: '1' });
    http = mk();
    const despues = await enB(tipoMarca);
    const versiones = await enB((c) => c.query('SELECT version FROM schema_migrations ORDER BY version').then(([r]) => r.map((x) => x.version)));
    const leadViejo = await enB((c) => c.query("SELECT marca FROM leads WHERE nombre = 'Lead Viejo Sur'").then(([[r]]) => r));
    check('AUTO_MIGRATE migró la base existente al arrancar', versiones.length === listMigrations().length, versiones.join(','));
    check('migración 003: leads.marca VARCHAR(30) y los datos se conservan', despues.t === 'varchar' && Number(despues.len) === 30 && leadViejo?.marca === 'fiat', `${JSON.stringify(despues)} ${JSON.stringify(leadViejo)}`);
    check('base existente: el owner viejo sigue entrando', (await http.post('/auth/login', { email: 'viejo@demo.test', password: PASSWORD }, { headers: { 'X-Tenant': 'demo-sur' } })).status === 200);
    const otra = await http.post(`/superadmin/tenants/${idBx}/migrar`, {}, SA);
    check('migrar otra vez -> nada que aplicar (idempotente)', otra.status === 200 && otra.data.aplicadas.length === 0, JSON.stringify(otra.data));
    check('el log del arranque reporta AUTO_MIGRATE', /AUTO_MIGRATE: \d+\/\d+ tenants al día/.test(srv.logs.join('')));

    // ---------- Runner: fallas aisladas ----------
    await provision.registerTenant({ slug: 'tenant-roto', nombre: 'Roto', dbUrl: 'mysql://nadie:nada@127.0.0.1:1/no_existe' });
    const rep = await migrateTenants({ log: false });
    const r = Object.fromEntries(rep.map((x) => [x.slug, x]));
    check('runner: un tenant roto falla sin frenar a los demás', r['tenant-roto']?.ok === false && r['demo-norte']?.ok && r['demo-sur']?.ok, JSON.stringify(rep));
    await getControlPool().execute("DELETE FROM tenants WHERE slug = 'tenant-roto'");
    registry.invalidate();
    const conRota = [...listMigrations(), { version: '999_rota', file: '999_rota.sql', sql: 'SELECT * FROM tabla_que_no_existe', checksum: 'x'.repeat(64) }];
    let errRota = null;
    try { await migrateDatabase(registry.dbUrlOf(A), { migrations: conRota }); } catch (e) { errRota = e.message; }
    const registrada = await (async () => { const c = await mysql.createConnection({ uri: registry.dbUrlOf(A) }); try { return (await c.query("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = '999_rota'"))[0][0].n; } finally { await c.end(); } })();
    check('runner: una migración que falla se reporta y no queda registrada', /999_rota\.sql/.test(errRota || '') && registrada === 0, errRota);
    const sana = await migrateDatabase(registry.dbUrlOf(A));
    check('runner: después de la falla la base sigue al día', sana.aplicadas.length === 0);

    // ---------- Edición ----------
    const ed = await http.patch(`/superadmin/tenants/${A.id}`, {
      branding: { nombre: 'Norte Editada' }, modulos: { metas: false },
      config: { timezone: 'America/Argentina/Cordoba', wa_bot_key: 'clave-nueva-del-bot-1234' },
    }, SA);
    await sleep(700);
    const pub = await http.get('/public/tenant', { params: { host: 'demo-norte.localhost' } });
    check('editar branding/módulos/config se ve en /public/tenant',
      ed.status === 200 && pub.data.branding.nombre === 'Norte Editada' && pub.data.modulos.metas === false && pub.data.config.timezone === 'America/Argentina/Cordoba',
      JSON.stringify(pub.data));
    check('el secreto editado queda cifrado y oculto', ed.data.tenant?.secretos?.wa_bot_key === true && !JSON.stringify(ed.data).includes('clave-nueva-del-bot-1234'));
    check('editar con zona horaria inválida -> 400', (await http.patch(`/superadmin/tenants/${A.id}`, { config: { timezone: 'Marte/Olympus' } }, SA)).status === 400);
    check('editar con clave de config desconocida -> 400', (await http.patch(`/superadmin/tenants/${A.id}`, { config: { inventada: 1 } }, SA)).status === 400);
    check('editar estado por PATCH -> 400', (await http.patch(`/superadmin/tenants/${A.id}`, { estado: 'baja' }, SA)).status === 400);
    const sec = await http.get(`/superadmin/tenants/${A.id}/secretos/lead_api_keys`, SA);
    check('ver secreto (lead_api_keys) devuelve el valor', sec.status === 200 && sec.data.valor['whatsapp-bot'] === keysA['whatsapp-bot']);
    await http.patch(`/superadmin/tenants/${A.id}`, { branding: { nombre: 'Concesionaria Demo Norte' }, modulos: { metas: true }, config: { timezone: 'America/Argentina/Buenos_Aires' } }, SA);

    // ---------- Suspender: 402 + sockets cortados ----------
    const ownerA2 = (await http.post('/auth/login', { email: 'owner@demo.test', password: PASSWORD }, { headers: { 'X-Tenant': 'demo-norte' } })).data.token;
    const sock = await conectarSocket(srv.base, ownerA2, 'demo-norte');
    check('socket de A conectado antes de suspender', sock.ok, sock.error);
    const susp = await http.post(`/superadmin/tenants/${A.id}/suspender`, { motivo: 'smoke' }, SA);
    await sleep(800);
    check('suspender corta los sockets del tenant en el momento', susp.status === 200 && susp.data.sockets_cortados >= 1 && sock.desconectado &&
      sock.eventos.some((e) => e.ev === 'tenant:estado' && e.data?.estado === 'suspendido'), JSON.stringify({ r: susp.data.sockets_cortados, d: sock.desconectado, ev: sock.eventos.map((e) => e.ev) }));
    check('tenant suspendido -> 402', (await http.get('/leads', { headers: { 'X-Tenant': 'demo-norte', Authorization: `Bearer ${ownerA2}` } })).status === 402);
    const reco = await conectarSocket(srv.base, ownerA2, 'demo-norte');
    check('reconexión del socket rechazada mientras está suspendido', !reco.ok);
    reco.s.close();
    check('no se puede entrar como owner a un tenant suspendido -> 409', (await http.post(`/superadmin/tenants/${A.id}/impersonar`, {}, SA)).status === 409);
    await http.post(`/superadmin/tenants/${A.id}/reactivar`, {}, SA);
    await sleep(700);
    check('reactivar -> 200', (await http.get('/leads', { headers: { 'X-Tenant': 'demo-norte', Authorization: `Bearer ${ownerA2}` } })).status === 200);

    // Vigilante: suspensión hecha directo en la base (u otra instancia)
    const ownerB = (await http.post('/auth/login', { email: 'viejo@demo.test', password: PASSWORD }, { headers: { 'X-Tenant': 'demo-sur' } })).data.token;
    const sockB = await conectarSocket(srv.base, ownerB, 'demo-sur');
    await getControlPool().execute("UPDATE tenants SET estado = 'suspendido' WHERE slug = 'demo-sur'");
    for (let i = 0; i < 20 && !sockB.desconectado; i++) await sleep(500);
    check('el vigilante corta sockets de un tenant suspendido por fuera del panel', sockB.ok && sockB.desconectado);
    await getControlPool().execute("UPDATE tenants SET estado = 'activo' WHERE slug = 'demo-sur'");

    // ---------- Uso mensual + entrar como owner ----------
    const vend = await http.post('/auth/login', { email: 'vend1@demo.test', password: PASSWORD }, { headers: { 'X-Tenant': 'demo-norte' } });
    const sV = await conectarSocket(srv.base, vend.data.token, 'demo-norte');
    await sleep(500);
    sV.s.close();
    const uso = await http.get(`/superadmin/tenants/${A.id}/uso`, SA);
    check('uso: usuarios activos (owner + vend1) y leads del mes', uso.status === 200 && uso.data.actual?.usuarios_activos >= 2 && uso.data.actual?.leads_ingresados >= 4, JSON.stringify(uso.data.actual));
    check('uso: estado del bot (configurado, no alcanzable en dev)', uso.data.bot?.configurado === true && uso.data.bot?.alcanzable === false, JSON.stringify(uso.data.bot));
    const usoTodos = await http.get('/superadmin/uso', { ...SA, params: { mes: nowInTz().monthKey, recalcular: '1' } });
    const filaA = usoTodos.data.tenants?.find((t) => t.slug === 'demo-norte');
    check('uso de todos los tenants (facturación) con recalcular', usoTodos.status === 200 && filaA?.usuarios_activos >= 2, JSON.stringify(usoTodos.data).slice(0, 300));

    const sesionesAntes = (await (async () => { const c = await mysql.createConnection({ uri: registry.dbUrlOf(A) }); try { return (await c.query('SELECT COUNT(*) AS n FROM user_sessions'))[0][0].n; } finally { await c.end(); } })());
    const imp = await http.post(`/superadmin/tenants/${A.id}/impersonar`, { motivo: 'soporte smoke' }, SA);
    const me = await http.get('/auth/me', { headers: { 'X-Tenant': 'demo-norte', Authorization: `Bearer ${imp.data.token}` } });
    check('entrar como owner: token del tenant que funciona en su CRM', imp.status === 200 && me.status === 200 && me.data.role === 'owner' && jwt.decode(imp.data.token)?.imp?.email === SA_EMAIL, JSON.stringify(me.data));
    check('el token de soporte no sirve en otro tenant', (await http.get('/leads', { headers: { 'X-Tenant': 'demo-sur', Authorization: `Bearer ${imp.data.token}` } })).status === 401);
    const sImp = await conectarSocket(srv.base, imp.data.token, 'demo-norte');
    await sleep(500);
    sImp.s.close();
    await sleep(300);
    const sesionesDespues = (await (async () => { const c = await mysql.createConnection({ uri: registry.dbUrlOf(A) }); try { return (await c.query('SELECT COUNT(*) AS n FROM user_sessions'))[0][0].n; } finally { await c.end(); } })());
    check('la sesión de soporte no cuenta como uso del cliente', sImp.ok && sesionesDespues === sesionesAntes, `${sesionesAntes} -> ${sesionesDespues}`);

    // ---------- Auditoría ----------
    const aud = await http.get('/superadmin/auditoria', { ...SA, params: { tenant_id: A.id } });
    const acciones = new Set((aud.data.eventos || []).map((e) => e.accion));
    const faltan = ['editar_tenant', 'ver_secreto', 'suspender_tenant', 'reactivar_tenant', 'impersonar'].filter((a) => !acciones.has(a));
    check('auditoría registra edición, secretos, suspensión e impersonación', aud.status === 200 && !faltan.length, `faltan: ${faltan}`);
    const edit = aud.data.eventos.find((e) => e.accion === 'editar_tenant' && e.detalle?.campos?.includes('config.wa_bot_key'));
    check('la auditoría nombra los campos tocados sin guardar valores secretos',
      !!edit && !JSON.stringify(aud.data).includes('clave-nueva-del-bot-1234'),
      JSON.stringify(aud.data.eventos?.filter((e) => e.accion === 'editar_tenant')));
    const audAlta = await http.get('/superadmin/auditoria', { ...SA, params: { tenant_id: idBx } });
    check('auditoría del alta con base existente', audAlta.data.eventos?.some((e) => e.accion === 'crear_tenant' && e.detalle?.base_existente === true));

    check('el server no registró consultas ni eventos sin tenant', !/sin tenant en el contexto/.test(srv.logs.join('')));
  } finally {
    await srv.stop();
    console.log('\nRestaurando demo-norte y demo-sur (dev:seed)...');
    await seed().catch((e) => console.error('❌ restaurando:', e.message));
    await getControlPool().execute('DELETE FROM superadmins WHERE email = ?', [SA_EMAIL]).catch(() => {});
    await closeControlPool();
  }

  const fallas = resultados.filter((x) => !x.ok);
  console.log(`\n${resultados.length - fallas.length}/${resultados.length} checks OK`);
  if (fallas.length) process.exitCode = 1;
}

main().catch(async (e) => { console.error('❌', e.stack || e.message); process.exitCode = 1; await closeControlPool(); });
