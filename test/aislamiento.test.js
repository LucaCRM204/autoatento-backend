/**
 * Tests de aislamiento multi-tenant (Fase 4).
 *
 *   npm test        (Linux / bash)
 *   npm.cmd test    (Windows PowerShell)
 *
 * Levanta el server real en un puerto libre contra la MySQL de desarrollo, con
 * dos tenants de prueba propios (crm_test_<run>_a / _b) que crea y borra
 * (ver testing/entorno.js). Usa node:test + supertest + socket.io-client.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { io: ioClient } = require('socket.io-client');
const E = require('../testing/entorno');
const { levantarServer } = require('../scripts/lib/test-server');

let srv;
let A; // tenant con todos los módulos
let B; // tenant con el módulo metas apagado
const tok = {}; // tokens: tok.A, tok.B, tok.vendA, ...

const api = () => request(srv.base);
const comoA = (r) => r.set('X-Tenant', A.slug).set('Authorization', `Bearer ${tok.A}`);
const comoB = (r) => r.set('X-Tenant', B.slug).set('Authorization', `Bearer ${tok.B}`);
const como = (t) => (t === A ? comoA : comoB);
const otro = (t) => (t === A ? B : A);
const txt = (res) => JSON.stringify(res.body);

async function login(t, email = 'owner@test.local') {
  const r = await api().post('/api/auth/login').set('X-Tenant', t.slug).send({ email, password: E.PASSWORD });
  assert.equal(r.status, 200, `login ${email} en ${t.slug}: ${txt(r)}`);
  return r.body;
}

function conectar(token, slug) {
  return new Promise((resolve) => {
    const s = ioClient(srv.base, { auth: { token, tenant: slug }, transports: ['websocket'], reconnection: false, timeout: 5000 });
    const st = { s, ok: false, eventos: [], desconectado: false };
    s.onAny((ev, data) => st.eventos.push({ ev, data }));
    s.on('disconnect', () => { st.desconectado = true; });
    s.on('connect', () => { st.ok = true; resolve(st); });
    s.on('connect_error', (e) => { st.error = e.message; resolve(st); });
  });
}

before(async () => {
  await E.preparar();
  A = await E.crearTenant('a');
  B = await E.crearTenant('b', { modulos: { metas: false }, tz: 'America/Montevideo' });
  await E.crearSuperadmin();
  srv = await levantarServer({
    TENANTS_SOLO_PREFIJO: E.PREFIJO, // los loops solo procesan los tenants de esta corrida
    ACCEPTANCE_CHECK_MS: '2000',
    SUSPENSION_WATCH_MS: '1500',
    TENANT_CACHE_TTL_MS: '500',
    AGENT_DISABLED: '0',
  });
  tok.A = (await login(A)).token;
  tok.B = (await login(B)).token;
  const vA = await login(A, 'vend1@test.local');
  tok.vendA = vA.token;
});

after(async () => {
  if (srv) await srv.stop();
  await E.limpiar();
});

describe('setup', () => {
  it('cada tenant de prueba se creó con todas las migraciones y su owner', () => {
    assert.equal(A.migraciones.aplicadas.length, 5);
    assert.equal(B.migraciones.aplicadas.length, 5);
  });
});

describe('resolución de tenant', () => {
  it('sin X-Tenant -> 400', async () => {
    assert.equal((await api().get('/api/leads')).status, 400);
  });
  it('tenant inexistente -> 404', async () => {
    assert.equal((await api().get('/api/leads').set('X-Tenant', `${E.PREFIJO}nada`)).status, 404);
  });
  it('/api/public/tenant devuelve branding y módulos sin secretos', async () => {
    const r = await api().get('/api/public/tenant').query({ host: `${A.slug}.localhost` });
    assert.equal(r.status, 200);
    assert.equal(r.body.slug, A.slug);
    const s = txt(r);
    for (const k of Object.values(A.keys)) assert.ok(!s.includes(k), 'no expone lead_api_keys');
    assert.ok(!/mysql:|v1:|wa_bot_key|password/i.test(s), s);
  });
});

describe('JWT con tid', () => {
  it('el login firma el tid del tenant', () => {
    assert.equal(jwt.decode(tok.A).tid, A.id);
    assert.equal(jwt.decode(tok.B).tid, B.id);
  });
  it('token de A usado en B -> 401', async () => {
    const r = await api().get('/api/leads').set('X-Tenant', B.slug).set('Authorization', `Bearer ${tok.A}`);
    assert.equal(r.status, 401);
  });
  it('token de B usado en A -> 401', async () => {
    const r = await api().get('/api/leads').set('X-Tenant', A.slug).set('Authorization', `Bearer ${tok.B}`);
    assert.equal(r.status, 401);
  });
  it('token sin tid -> 401', async () => {
    const sinTid = jwt.sign({ id: A.ids.owner, uid: A.ids.owner, role: 'owner' }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const r = await api().get('/api/leads').set('X-Tenant', A.slug).set('Authorization', `Bearer ${sinTid}`);
    assert.equal(r.status, 401);
  });
  it('mismo email y contraseña: cada login da el usuario de su base', async () => {
    const a = await login(A);
    const b = await login(B);
    assert.notEqual(jwt.decode(a.token).tid, jwt.decode(b.token).tid);
    assert.match(a.user.name, new RegExp(A.marca));
    assert.match(b.user.name, new RegExp(B.marca));
  });
});

describe('A no ve datos de B (y viceversa)', () => {
  // [descripción, ruta(t), conDatos]
  const recursos = [
    ['leads', () => '/api/leads'],
    ['lead por id', (t) => `/api/leads/${t.ids.lead}`],
    ['notas', (t) => `/api/notas/leads/${t.ids.lead}/notas`],
    ['alertas', () => '/api/alertas'],
    ['tareas', () => '/api/tareas'],
    ['mensajes de WhatsApp', (t) => `/api/whatsapp/leads/${t.ids.lead}`],
    ['recordatorios', (t) => `/api/recordatorios/leads/${t.ids.lead}/recordatorios`],
    ['acciones del agente', () => '/api/agent/actions?estado=pending'],
    ['usuarios', () => '/api/users'],
  ];
  for (const [nombre, ruta] of recursos) {
    for (const lado of ['A', 'B']) {
      it(`${nombre}: ${lado} ve lo suyo y nada del otro`, async () => {
        const t = lado === 'A' ? A : B;
        const r = await como(t)(api().get(ruta(t)));
        assert.equal(r.status, 200, `${ruta(t)} -> ${r.status} ${txt(r).slice(0, 200)}`);
        assert.ok(txt(r).includes(t.marca), `${ruta(t)} no trae datos de ${t.slug}`);
        assert.ok(!txt(r).includes(otro(t).marca), `${ruta(t)} trae datos del otro tenant`);
      });
    }
  }

  it('un id que solo existe en B da 404 en A', async () => {
    const [{ id }] = await E.enBase(B, "SELECT MAX(id) + 1000 AS id FROM leads");
    await E.enBase(B, "INSERT INTO leads (id, nombre, telefono, modelo) VALUES (?, ?, '1', 'X')", [id, `Solo ${B.marca}`]);
    assert.equal((await comoA(api().get(`/api/leads/${id}`))).status, 404);
    assert.equal((await comoB(api().get(`/api/leads/${id}`))).status, 200);
  });

  it('una nota creada en A no aparece en B aunque el lead tenga el mismo id', async () => {
    assert.equal(A.ids.lead, B.ids.lead, 'los dos tenants tienen ids iguales (bases separadas)');
    const r = await comoA(api().post(`/api/notas/leads/${A.ids.lead}/notas`)).send({ texto: `Nueva ${A.marca}` });
    assert.equal(r.status, 200, txt(r));
    const enB = await comoB(api().get(`/api/notas/leads/${B.ids.lead}/notas`));
    assert.ok(!txt(enB).includes(`Nueva ${A.marca}`));
  });

  it('webhook: la key de A solo sirve en A', async () => {
    const ok = await api().post(`/api/t/${A.slug}/webhooks/whatsapp-bot`).set('x-api-key', A.keys['whatsapp-bot'])
      .send({ nombre: `Webhook ${A.marca}`, telefono: '1144440000' });
    assert.equal(ok.status, 200, txt(ok));
    const cruzada = await api().post(`/api/t/${B.slug}/webhooks/whatsapp-bot`).set('x-api-key', A.keys['whatsapp-bot'])
      .send({ nombre: 'X', telefono: '1' });
    assert.equal(cruzada.status, 401);
    const leadsB = await comoB(api().get('/api/leads'));
    assert.ok(!txt(leadsB).includes(`Webhook ${A.marca}`));
  });
});

describe('sockets aislados', () => {
  let sA;
  let sB;
  before(async () => {
    sA = await conectar(tok.A, A.slug);
    sB = await conectar(tok.B, B.slug);
  });
  after(() => { sA?.s.close(); sB?.s.close(); });

  it('cada uno conecta a su tenant', () => {
    assert.ok(sA.ok, sA.error);
    assert.ok(sB.ok, sB.error);
  });
  it('token de A pidiendo el tenant B -> rechazado', async () => {
    const x = await conectar(tok.A, B.slug);
    x.s.close();
    assert.equal(x.ok, false);
  });
  it('sin tenant -> rechazado', async () => {
    const x = await conectar(tok.A, '');
    x.s.close();
    assert.equal(x.ok, false);
  });
  it('un lead creado en A llega a A y no a B', async () => {
    const r = await comoA(api().post('/api/leads')).send({ nombre: `Socket ${A.marca}`, telefono: `11${Date.now() % 1e8}`, modelo: 'Cronos' });
    assert.equal(r.status, 200, txt(r));
    const llego = await E.esperar(() => sA.eventos.some((e) => e.ev === 'lead:created' && e.data?.nombre === `Socket ${A.marca}`), { ms: 5000, cada: 100 });
    assert.ok(llego, 'A no recibió lead:created');
    await new Promise((res) => setTimeout(res, 800));
    assert.ok(!sB.eventos.some((e) => JSON.stringify(e.data ?? '').includes(A.marca)), 'B recibió un evento de A');
    assert.ok(!sB.eventos.some((e) => e.ev === 'lead:created'));
  });
  it('presencia separada: users:online de B no incluye usuarios de A', async () => {
    const vend = await conectar(tok.vendA, A.slug);
    await new Promise((res) => setTimeout(res, 600));
    vend.s.close();
    const r = await comoB(api().get('/api/activity/online'));
    assert.equal(r.status, 200);
    assert.ok(r.body.users.every((u) => !String(u.odUserName || '').includes(A.marca)), txt(r));
  });
});

describe('loops en segundo plano por tenant', () => {
  it('checker de aceptación: cada oferta vencida pasa al otro vendedor de su propio tenant', async () => {
    let estado = {};
    const listo = await E.esperar(async () => {
      const [a] = await E.enBase(A, 'SELECT current_offer_to, pending_acceptance, acceptance_attempts, acceptance_expires_at FROM leads WHERE id = ?', [A.ids.ofertado]);
      const [b] = await E.enBase(B, 'SELECT current_offer_to, pending_acceptance, acceptance_attempts, acceptance_expires_at FROM leads WHERE id = ?', [B.ids.ofertado]);
      estado = { a, b, v2A: A.ids.v2, v2B: B.ids.v2 };
      return a.current_offer_to === A.ids.v2 && b.current_offer_to === B.ids.v2;
    }, { ms: 30000 });
    assert.ok(listo, `la oferta vencida no pasó a vend2 en los dos tenants: ${JSON.stringify(estado)}`);
    const logA = await E.enBase(A, "SELECT COUNT(*) AS n FROM lead_acceptance_log WHERE lead_id = ? AND action = 'timeout'", [A.ids.ofertado]);
    const logB = await E.enBase(B, "SELECT COUNT(*) AS n FROM lead_acceptance_log WHERE lead_id = ? AND action = 'timeout'", [B.ids.ofertado]);
    assert.ok(logA[0].n >= 1 && logB[0].n >= 1);
  });
  it('scanner: el recordatorio vencido genera la alerta en su tenant y con sus datos', async () => {
    const alertas = await E.esperar(async () => {
      const a = await E.enBase(A, "SELECT message FROM alertas WHERE type = 'recordatorio' AND message LIKE '⏰%'");
      const b = await E.enBase(B, "SELECT message FROM alertas WHERE type = 'recordatorio' AND message LIKE '⏰%'");
      return a.length && b.length ? { a, b } : null;
    }, { ms: 40000 });
    assert.ok(alertas, 'no se generaron las alertas de recordatorio');
    assert.equal(alertas.a.length, 1);
    assert.equal(alertas.b.length, 1);
    assert.ok(alertas.a[0].message.includes(`Vencido ${A.marca}`) && !alertas.a[0].message.includes(B.marca));
    assert.ok(alertas.b[0].message.includes(`Vencido ${B.marca}`) && !alertas.b[0].message.includes(A.marca));
  });
});

describe('módulos', () => {
  it('módulo apagado (metas en B) -> 403', async () => {
    const r = await comoB(api().get('/api/metas'));
    assert.equal(r.status, 403);
    assert.equal(r.body.modulo, 'metas');
  });
  it('el mismo módulo prendido en A responde', async () => {
    assert.equal((await comoA(api().get('/api/metas'))).status, 200);
  });
  it('/api/public/tenant informa el módulo apagado', async () => {
    const r = await api().get('/api/public/tenant').query({ slug: B.slug });
    assert.equal(r.body.modulos.metas, false);
    assert.equal(r.body.modulos.agente_ia, true);
  });
});

describe('panel superadmin', () => {
  let saToken;
  before(async () => {
    const r = await api().post('/api/superadmin/login').send({ email: E.SA_EMAIL, password: E.SA_PASSWORD });
    assert.equal(r.status, 200, txt(r));
    saToken = r.body.token;
  });

  it('sin token de superadmin no entra -> 401', async () => {
    assert.equal((await api().get('/api/superadmin/tenants')).status, 401);
  });
  it('contraseña mala -> 401', async () => {
    assert.equal((await api().post('/api/superadmin/login').send({ email: E.SA_EMAIL, password: 'mala-mala-mala' })).status, 401);
  });
  it('el token de un owner de un tenant no sirve en /api/superadmin -> 401', async () => {
    const r = await api().get('/api/superadmin/tenants').set('Authorization', `Bearer ${tok.A}`);
    assert.equal(r.status, 401);
  });
  it('el owner tampoco pasa mandando X-Tenant', async () => {
    const r = await api().get('/api/superadmin/tenants').set('X-Tenant', A.slug).set('Authorization', `Bearer ${tok.A}`);
    assert.equal(r.status, 401);
  });
  it('el token de superadmin no sirve como sesión de un CRM', async () => {
    const r = await api().get('/api/leads').set('X-Tenant', A.slug).set('Authorization', `Bearer ${saToken}`);
    assert.notEqual(r.status, 200);
  });
  it('con token de superadmin ve los tenants sin secretos', async () => {
    const r = await api().get('/api/superadmin/tenants').set('Authorization', `Bearer ${saToken}`);
    assert.equal(r.status, 200);
    const s = txt(r);
    assert.ok(s.includes(A.slug) && s.includes(B.slug));
    for (const k of [...Object.values(A.keys), ...Object.values(B.keys)]) assert.ok(!s.includes(k));
  });

  describe('suspensión', () => {
    after(async () => {
      await api().post(`/api/superadmin/tenants/${B.id}/reactivar`).set('Authorization', `Bearer ${saToken}`);
    });
    it('suspender B: HTTP 402, sockets de B cortados y A sigue andando', async () => {
      const sB = await conectar(tok.B, B.slug);
      assert.ok(sB.ok, sB.error);
      const r = await api().post(`/api/superadmin/tenants/${B.id}/suspender`).set('Authorization', `Bearer ${saToken}`).send({ motivo: 'test' });
      assert.equal(r.status, 200, txt(r));
      assert.ok(r.body.sockets_cortados >= 1);
      const cortado = await E.esperar(() => sB.desconectado, { ms: 3000, cada: 100 });
      assert.ok(cortado, 'el socket de B no se cortó');
      assert.ok(sB.eventos.some((e) => e.ev === 'tenant:estado' && e.data.estado === 'suspendido'));

      const susp = await comoB(api().get('/api/leads'));
      assert.equal(susp.status, 402);
      assert.match(susp.body.error, /suspendida/i);
      assert.equal((await comoA(api().get('/api/leads'))).status, 200);

      const reco = await conectar(tok.B, B.slug);
      reco.s.close();
      assert.equal(reco.ok, false, 'el socket de un tenant suspendido no puede reconectar');
    });
    it('reactivar B vuelve a dar 200', async () => {
      const r = await api().post(`/api/superadmin/tenants/${B.id}/reactivar`).set('Authorization', `Bearer ${saToken}`);
      assert.equal(r.status, 200);
      const ok = await E.esperar(async () => (await comoB(api().get('/api/leads'))).status === 200, { ms: 3000, cada: 200 });
      assert.ok(ok);
    });
  });
});

describe('capa de tenancy (sin HTTP)', () => {
  it('db sin tenant en el contexto tira NO_TENANT (nunca usa un pool por defecto)', async () => {
    const db = require('../db');
    await assert.rejects(() => db.query('SELECT 1'), (e) => e.code === 'NO_TENANT');
  });
  it('emitTenant sin tenant descarta el evento', () => {
    const { emitTenant } = require('../tenancy/realtime');
    const errorOriginal = console.error;
    console.error = () => {};
    try {
      assert.equal(emitTenant('x', {}), false);
    } finally {
      console.error = errorOriginal;
    }
  });
  it('el server no registró consultas ni eventos sin tenant', () => {
    assert.ok(!/sin tenant en el contexto/.test(srv.logs.join('')), srv.logs.join('').match(/.*sin tenant en el contexto.*/g)?.slice(0, 3).join('\n'));
  });
});
