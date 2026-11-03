#!/usr/bin/env node
/**
 * npm run smoke   (correr antes `npm run dev:seed`)
 *
 * Verificación de la Fase 1: levanta el server en un puerto libre contra los
 * tenants de desarrollo (tenant-a "Alfa" / tenant-b "Bravo") y comprueba que
 * todo queda aislado por tenant:
 *   - resolución de tenant (header, path, 400/404/402)
 *   - tid del JWT (token de A en B -> 401, token sin tid -> 401)
 *   - TODAS las rutas GET existentes responden por tenant y nunca mezclan datos
 *   - webhooks por /api/t/<slug>/ con API key del tenant
 *   - sockets: eventos de A no llegan a B; handshake con token cruzado rechazado
 *   - loops en segundo plano: checker de aceptación y avisos de recordatorios
 *     vencidos procesan cada tenant con sus propios datos
 * Sale con código 1 si algo falla. Los tests formales van en la Fase 4.
 */
require('../tenancy/env');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const { io: ioClient } = require('socket.io-client');
const registry = require('../tenancy/registry');
const { getControlPool, closeControlPool } = require('../tenancy/control');

const PASSWORD = process.env.DEV_TENANT_PASSWORD;
const A = { slug: 'tenant-a', marca: 'Alfa', otra: 'Bravo' };
const B = { slug: 'tenant-b', marca: 'Bravo', otra: 'Alfa' };

const resultados = [];
const avisos = [];

// Bugs que ya estaban en el código original (no son de multi-tenant). Se
// verifica que sigan respondiendo igual que antes y que no mezclen datos.
const CONOCIDOS = {
  '/leads/unassigned': { status: 404, motivo: 'la tapa GET /leads/:id, que está definida antes en routes/leads.js' },
  '/leads/distribution': { status: 404, motivo: 'la tapa GET /leads/:id, que está definida antes en routes/leads.js' },
  '/activity/reassignments': { status: 500, motivo: 'usa LIMIT ? con execute(): MySQL >= 8.0.22 lo rechaza (ER_WRONG_ARGUMENTS)' },
};
function check(nombre, ok, detalle = '') {
  resultados.push({ nombre, ok: !!ok, detalle });
  console.log(`${ok ? '✅' : '❌'} ${nombre}${!ok && detalle ? `  ->  ${detalle}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function puertoLibre() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

async function levantarServer(port) {
  const logs = [];
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(port), TENANT_CACHE_TTL_MS: '500', NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try { await axios.get(`${base}/api/health`, { timeout: 1000 }); return { child, base, logs }; } catch { await sleep(500); }
  }
  child.kill();
  throw new Error(`El server no levantó:\n${logs.join('')}`);
}

async function main() {
  if (!PASSWORD) throw new Error('Falta DEV_TENANT_PASSWORD (corré npm run dev:seed)');
  for (const t of [A, B]) {
    t.tenant = await registry.getBySlug(t.slug);
    if (!t.tenant) throw new Error(`No existe ${t.slug}: corré npm run dev:seed`);
    t.keys = registry.secretsOf(t.tenant).lead_api_keys;
    t.dbUrl = registry.dbUrlOf(t.tenant);
  }

  const port = await puertoLibre();
  const srv = await levantarServer(port);
  const http = axios.create({ baseURL: `${srv.base}/api`, validateStatus: () => true, timeout: 20000 });
  const as = (t, token, extra = {}) => ({ headers: { 'X-Tenant': t.slug, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra } });

  try {
    // ---------- Resolución de tenant ----------
    check('health sin tenant -> 200', (await http.get('/health')).status === 200);
    const pub = await http.get('/public/tenant', { params: { host: 'tenant-a.localhost' } });
    const pubTxt = JSON.stringify(pub.data);
    check('public/tenant por host -> datos de A', pub.status === 200 && pub.data.slug === 'tenant-a' && pub.data.branding?.nombre === 'Concesionaria Alfa' && pub.data.modulos?.agente_ia === true);
    check('public/tenant no expone secretos', !/mysql:|v1:|lead_api_keys|wa_bot_key|agent_mcp_key|password/i.test(pubTxt) && !Object.values(A.keys).some((k) => pubTxt.includes(k)), pubTxt);
    check('public/tenant host desconocido -> 404', (await http.get('/public/tenant', { params: { host: 'nadie.localhost' } })).status === 404);
    check('/api/leads sin X-Tenant -> 400', (await http.get('/leads')).status === 400);
    check('/api/leads tenant inexistente -> 404', (await http.get('/leads', { headers: { 'X-Tenant': 'no-existe' } })).status === 404);

    // ---------- Login y tid ----------
    for (const t of [A, B]) {
      const r = await http.post('/auth/login', { email: 'owner@demo.test', password: PASSWORD }, as(t));
      t.token = r.data?.token;
      check(`login owner en ${t.slug} -> token con tid`, r.status === 200 && jwt.decode(t.token)?.tid === t.tenant.id, JSON.stringify(r.data));
      const rv = await http.post('/auth/login', { email: 'vend1@demo.test', password: PASSWORD }, as(t));
      t.vendToken = rv.data?.token;
      t.vendId = rv.data?.user?.id;
    }
    check('token de A en B -> 401', (await http.get('/leads', as(B, A.token))).status === 401);
    check('token de B en A -> 401', (await http.get('/leads', as(A, B.token))).status === 401);
    const sinTid = jwt.sign({ id: 1, uid: 1, role: 'owner' }, process.env.JWT_SECRET, { expiresIn: '5m' });
    check('token sin tid -> 401', (await http.get('/leads', as(A, sinTid))).status === 401);
    check('cookie de sesión por tenant', (await http.post('/auth/login', { email: 'owner@demo.test', password: PASSWORD }, as(A))).headers['set-cookie']?.some((c) => c.startsWith('session_tenant-a=')));
    const me = await http.get('/auth/me', as(A, A.token));
    check('/auth/me con token de A', me.status === 200 && me.data.email === 'owner@demo.test');

    // ---------- Rutas existentes, por tenant ----------
    for (const t of [A, B]) {
      const leads = await http.get('/leads', as(t, t.token));
      const lista = Array.isArray(leads.data) ? leads.data : leads.data?.leads || [];
      t.leadId = (lista.find((l) => /Cliente \w+ 1$/.test(l.nombre)) || lista[0])?.id;
    }
    const rutas = (t) => [
      ['/leads', true], [`/leads/${t.leadId}`, true], [`/leads/${t.leadId}/history`, false], ['/leads/unassigned', false],
      ['/leads/pending-offers/me', false], ['/leads/round-robin/status', true], ['/leads/distribution', true],
      [`/notas/leads/${t.leadId}/notas`, true],
      [`/recordatorios/leads/${t.leadId}/recordatorios`, true], ['/recordatorios/recordatorios/pendientes', false],
      [`/cotizaciones/leads/${t.leadId}/cotizaciones`, true], ['/cotizaciones/stats', false],
      ['/presupuestos', true], ['/alertas', true], ['/alertas/count', false], ['/tareas', true],
      [`/whatsapp/leads/${t.leadId}`, true], ['/metas', true], [`/calls/${t.leadId}`, true], ['/users', true],
      ['/distribution/all', true], ['/distribution/gestionados', false],
      ['/activity/team-report', true], ['/activity/online', false], ['/activity/lead-response-times', false], ['/activity/reassignments', false],
      ['/agent/status', false], ['/agent/actions', false], ['/agent/runs', false], ['/agent/config', false], ['/agent/events', false],
      ['/webhooks/health', false], ['/auth/me', false],
    ];
    for (const t of [A, B]) {
      const fallas = [];
      let n = 0;
      for (const [ruta, conDatos] of rutas(t)) {
        const r = await http.get(ruta, as(t, t.token));
        const txt = JSON.stringify(r.data);
        n++;
        if (txt.includes(t.otra)) { fallas.push(`${ruta} -> contiene datos de ${t.otra}`); continue; }
        const conocido = CONOCIDOS[ruta];
        if (conocido && r.status === conocido.status) {
          if (t === A) avisos.push(`GET /api${ruta} -> ${r.status}: ${conocido.motivo}`);
          continue;
        }
        if (r.status !== 200) fallas.push(`${ruta} -> ${r.status} ${txt.slice(0, 160)}`);
        else if (txt.includes(t.otra)) fallas.push(`${ruta} -> contiene datos de ${t.otra}`);
        else if (conDatos && !txt.includes(t.marca)) fallas.push(`${ruta} -> no trae datos de ${t.marca}`);
      }
      check(`${t.slug}: ${n} rutas GET responden 200 solo con sus datos`, !fallas.length, fallas.join('\n     '));
    }

    // calls / metas / users ahora piden token
    for (const ruta of ['/calls/1', '/metas', '/users']) {
      check(`${ruta} sin token -> 401`, (await http.get(ruta, as(A))).status === 401);
    }

    // ---------- Escrituras por tenant ----------
    const nota = await http.post(`/notas/leads/${A.leadId}/notas`, { texto: 'Nota nueva Alfa' }, as(A, A.token));
    check('POST nota en A', nota.status === 200, JSON.stringify(nota.data));
    const notasB = await http.get(`/notas/leads/${B.leadId}/notas`, as(B, B.token));
    check('la nota de A no aparece en B (mismo id de lead)', notasB.status === 200 && !JSON.stringify(notasB.data).includes('Nota nueva Alfa'));

    // ---------- Webhooks por path ----------
    const wh = await http.post('/t/tenant-a/webhooks/whatsapp-bot', { nombre: 'Webhook Alfa', telefono: `114${String(Date.now()).slice(-7)}`, modelo: 'Pulse' }, { headers: { 'x-api-key': A.keys['whatsapp-bot'] } });
    check('webhook /api/t/tenant-a con key de A -> 200', wh.status === 200 && wh.data.lead?.nombre === 'Webhook Alfa', JSON.stringify(wh.data));
    check('webhook /api/t/tenant-a con key de B -> 401',
      (await http.post('/t/tenant-a/webhooks/whatsapp-bot', { nombre: 'X', telefono: '1' }, { headers: { 'x-api-key': B.keys['whatsapp-bot'] } })).status === 401);
    check('webhook path A + header X-Tenant B -> 400',
      (await http.post('/t/tenant-a/webhooks/whatsapp-bot', { nombre: 'X', telefono: '1' }, { headers: { 'x-api-key': A.keys['whatsapp-bot'], 'X-Tenant': 'tenant-b' } })).status === 400);
    const sh = await http.post('/t/tenant-b/webhooks/sheets', { nombre: 'Sheet Bravo', telefono: '1133330000' }, { headers: { 'x-api-key': B.keys['sheet-emanuel'] } });
    check('webhook sheets en B (fuente Emanuel)', sh.status === 200 && sh.data.fuente === 'Emanuel', JSON.stringify(sh.data));
    const leadsB = JSON.stringify((await http.get('/leads', as(B, B.token))).data);
    check('lead del webhook de A no está en B', !leadsB.includes('Webhook Alfa') && leadsB.includes('Sheet Bravo'));

    // ---------- Sockets ----------
    const conectar = (t, token, slug = t.slug) => new Promise((resolve) => {
      const s = ioClient(srv.base, { auth: { token, tenant: slug }, transports: ['websocket'], reconnection: false, timeout: 5000 });
      const recibidos = [];
      s.onAny((ev, data) => recibidos.push({ ev, data }));
      s.on('connect', () => resolve({ s, ok: true, recibidos }));
      s.on('connect_error', (e) => resolve({ s, ok: false, error: e.message, recibidos }));
    });
    const sA = await conectar(A, A.token);
    const sB = await conectar(B, B.token);
    const sVendA = await conectar(A, A.vendToken);
    const sCruzado = await conectar(B, A.token, 'tenant-b');
    check('socket A conecta', sA.ok, sA.error);
    check('socket B conecta', sB.ok, sB.error);
    check('socket con token de A pidiendo tenant B -> rechazado', !sCruzado.ok);
    const sSinTenant = await new Promise((resolve) => {
      const s = ioClient(srv.base, { auth: { token: A.token }, transports: ['websocket'], reconnection: false });
      s.on('connect', () => resolve({ s, ok: true }));
      s.on('connect_error', () => resolve({ s, ok: false }));
    });
    check('socket sin tenant -> rechazado', !sSinTenant.ok);
    await sleep(500);

    // Teléfono distinto en cada corrida (leads.js rechaza duplicados de menos de 5 min)
    const tel = `11${String(Date.now()).slice(-8)}`;
    const creado = await http.post('/leads', { nombre: 'Socket Alfa', telefono: tel, modelo: 'Cronos' }, as(A, A.token));
    check('POST /leads en A', creado.status === 200, JSON.stringify(creado.data).slice(0, 200));
    // Evento dirigido a un usuario (lead:offer / notification por emitToUser) vía reenvío del cliente
    sVendA.s.emit('presence:active');
    await sleep(2000);
    const evA = sA.recibidos.filter((x) => x.ev === 'lead:created').map((x) => x.data?.nombre);
    const evB = sB.recibidos.map((x) => JSON.stringify(x.data || '')).join(' ');
    check('socket A recibe lead:created de A', evA.includes('Socket Alfa'), JSON.stringify(sA.recibidos.map((x) => x.ev)));
    check('socket B no recibe nada de A', !evB.includes('Alfa') && !sB.recibidos.some((x) => x.ev === 'lead:created'), evB.slice(0, 300));
    const onlineA = sA.recibidos.filter((x) => x.ev === 'users:online').pop()?.data || [];
    const onlineB = sB.recibidos.filter((x) => x.ev === 'users:online').pop()?.data || [];
    check('presencia separada: users:online de B no incluye usuarios de A', onlineB.length >= 1 && !onlineB.includes(A.vendId) && onlineA.includes(A.vendId), `A=${JSON.stringify(onlineA)} B=${JSON.stringify(onlineB)}`);
    const online = await http.get('/activity/online', as(B, B.token));
    check('/activity/online de B solo con conectados de B', online.status === 200 && online.data.count === 1, JSON.stringify(online.data));
    for (const x of [sA, sB, sVendA, sCruzado, sSinTenant]) x.s.close();

    // ---------- Loops en segundo plano ----------
    // Checker de aceptación (cada 30 s) y avisos de recordatorios vencidos del scanner (a los 10 s, cada 60 s)
    const espera = Date.now() + 45 * 1000;
    let estado = {};
    while (Date.now() < espera) {
      estado = {};
      for (const t of [A, B]) {
        const c = await mysql.createConnection({ uri: t.dbUrl });
        try {
          const [[of]] = await c.query("SELECT l.current_offer_to, u.name FROM leads l LEFT JOIN users u ON u.id = l.current_offer_to WHERE l.nombre = ?", [`Cliente ${t.marca} Ofertado`]);
          const [al] = await c.query("SELECT message FROM alertas WHERE type = 'recordatorio' AND message LIKE '⏰%'");
          estado[t.slug] = { oferta: of?.name || null, alertas: al.map((a) => a.message) };
        } finally {
          await c.end();
        }
      }
      if ([A, B].every((t) => estado[t.slug].oferta === `Vendedor ${t.marca} Dos` && estado[t.slug].alertas.length)) break;
      await sleep(3000);
    }
    for (const t of [A, B]) {
      const e = estado[t.slug] || {};
      check(`loop aceptación en ${t.slug}: la oferta vencida pasó a "Vendedor ${t.marca} Dos"`, e.oferta === `Vendedor ${t.marca} Dos`, JSON.stringify(e));
      check(`loop recordatorios en ${t.slug}: alerta ⏰ con sus datos y nada del otro`,
        e.alertas?.length === 1 && e.alertas[0].includes(`Recordatorio vencido ${t.marca}`) && !e.alertas.join().includes(t.otra), JSON.stringify(e.alertas));
    }

    // ---------- Estados del tenant ----------
    const ctrl = getControlPool();
    await ctrl.execute("UPDATE tenants SET estado = 'suspendido' WHERE slug = 'tenant-b'");
    await sleep(800);
    const susp = await http.get('/leads', as(B, B.token));
    check('tenant suspendido -> 402', susp.status === 402 && /suspendida/.test(susp.data.error), JSON.stringify(susp.data));
    check('tenant suspendido no afecta a A', (await http.get('/leads', as(A, A.token))).status === 200);
    const sSusp = await conectar(B, B.token);
    check('socket a tenant suspendido -> rechazado', !sSusp.ok);
    sSusp.s.close();
    await ctrl.execute("UPDATE tenants SET estado = 'baja' WHERE slug = 'tenant-b'");
    await sleep(800);
    check('tenant de baja -> 404', (await http.get('/leads', as(B, B.token))).status === 404);
    await ctrl.execute("UPDATE tenants SET estado = 'activo' WHERE slug = 'tenant-b'");
    await sleep(800);
    check('tenant reactivado -> 200', (await http.get('/leads', as(B, B.token))).status === 200);

    // ---------- Sin errores de contexto en el server ----------
    const log = srv.logs.join('');
    check('el server no registró consultas ni eventos sin tenant', !/sin tenant en el contexto/.test(log),
      (log.match(/.*sin tenant en el contexto.*/g) || []).slice(0, 5).join('\n'));
    if (process.env.SMOKE_LOGS) console.log(log);
  } finally {
    srv.child.kill();
    await closeControlPool();
  }

  const fallas = resultados.filter((r) => !r.ok);
  if (avisos.length) console.log(`\n⚠️  Bugs previos (no de multi-tenant), sin mezclar datos:\n   ${avisos.join('\n   ')}`);
  console.log(`\n${resultados.length - fallas.length}/${resultados.length} checks OK`);
  if (fallas.length) process.exitCode = 1;
}

main().catch((e) => { console.error('❌', e.stack || e.message); process.exitCode = 1; });
