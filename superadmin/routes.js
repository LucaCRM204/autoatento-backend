/**
 * ============================================
 * PANEL SUPERADMIN — /api/superadmin/*
 * ============================================
 * Para el equipo de AutoAtento (no para los clientes). Login propio
 * (tabla superadmins, SUPERADMIN_JWT_SECRET, scope 'superadmin').
 *
 *   POST  /login
 *   GET   /me
 *   GET   /config                       dominio base de los subdominios y slugs reservados
 *   GET   /tenants                      lista (sin secretos)
 *   POST  /tenants                      alta: schema + migraciones + owner + registro
 *                                       (o "base existente" con db_url)
 *   GET   /tenants/:id                  detalle
 *   PATCH /tenants/:id                  nombre, plan, dominios, branding, modulos, config, db_url
 *   POST  /tenants/:id/suspender        estado suspendido + corta sus sockets
 *   POST  /tenants/:id/reactivar
 *   POST  /tenants/:id/baja             estado baja (404 para todo) + corta sus sockets
 *   GET   /tenants/:id/secretos/:clave  ver un secreto (queda auditado)
 *   POST  /tenants/:id/migrar           aplica migraciones pendientes a ese tenant
 *   GET   /tenants/:id/uso              uso por mes + estado del bot
 *   POST  /tenants/:id/impersonar       token de owner para soporte (auditado)
 *   GET   /uso?mes=YYYY-MM[&recalcular=1]   uso de todos los tenants (facturación)
 *   GET   /auditoria?tenant_id=&limit=
 * Todo lo que cambia algo queda en audit_log.
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const { login, requireSuperadmin } = require('./auth');
const { auditar } = require('./audit');
const uso = require('./uso');
const provision = require('../tenancy/provision');
const registry = require('../tenancy/registry');
const { getControlPool } = require('../tenancy/control');
const { decrypt, decryptJSON } = require('../tenancy/crypto');
const { runWithTenant } = require('../tenancy/context');
const { disconnectTenant } = require('../tenancy/realtime');
const { migrateDatabase } = require('../tenancy/migrate');
const { MODULOS, normalizarModulos } = require('../tenancy/modules');
const { nowInTz } = require('../tenancy/time');
const env = require('../tenancy/env');
const subdominios = require('../tenancy/subdominios');
const db = require('../db');

const router = express.Router();

// Envuelve handlers async: errores con .status (validación) salen tal cual.
const h = (fn) => (req, res) => fn(req, res).catch((e) => {
  if (e.status) return res.status(e.status).json({ ok: false, error: e.message });
  console.error(`[superadmin] ${req.method} ${req.path}:`, e);
  res.status(500).json({ ok: false, error: 'Error interno' });
});

const parseJSON = (v, def) => (v == null ? def : typeof v === 'object' ? v : JSON.parse(v));

/** Tenant para el panel: sin secretos, con qué secretos están cargados. */
function vistaTenant(row) {
  const config = parseJSON(row.config, {});
  const publica = {};
  const secretos = {};
  for (const [k, v] of Object.entries(config)) {
    if (!registry.SECRET_KEYS.includes(k)) publica[k] = v;
  }
  for (const k of registry.SECRET_KEYS) {
    if (k === 'lead_api_keys') {
      let proveedores = [];
      try { proveedores = Object.keys(decryptJSON(config[k]) || {}); } catch { proveedores = ['(no se pudo descifrar)']; }
      secretos[k] = proveedores;
    } else {
      secretos[k] = !!config[k];
    }
  }
  let base = null;
  try { base = provision.maskDbUrl(decrypt(row.db_url_cifrada)); } catch { base = '(no se pudo descifrar: revisar TENANT_DB_KEY)'; }
  return {
    id: row.id,
    slug: row.slug,
    nombre: row.nombre,
    estado: row.estado,
    plan: row.plan,
    dominios: parseJSON(row.dominios, []),
    url: subdominios.urlDeSlug(row.slug),
    modulos: normalizarModulos(parseJSON(row.modulos, {})),
    branding: parseJSON(row.branding, {}),
    config: publica,
    secretos,
    base,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function filaTenant(id) {
  const [[row]] = await getControlPool().execute('SELECT * FROM tenants WHERE id = ?', [Number(id)]);
  if (!row) {
    const e = new Error('Tenant inexistente');
    e.status = 404;
    throw e;
  }
  return row;
}

/** Tenant del registro (con secretos) para correr cosas en su contexto. */
async function tenantVivo(id) {
  registry.invalidate();
  const t = await registry.getById(Number(id));
  if (!t) {
    const e = new Error('Tenant inexistente');
    e.status = 404;
    throw e;
  }
  return t;
}

// ---------- auth ----------
router.post('/login', h(login));
router.use(requireSuperadmin);
router.get('/me', (req, res) => res.json({ ok: true, superadmin: req.superadmin, modulos: Object.keys(MODULOS) }));
router.get('/config', (_req, res) => res.json({
  ok: true,
  base_domain: env.BASE_DOMAIN || null,
  slugs_reservados: subdominios.RESERVADOS,
}));

// ---------- tenants ----------
router.get('/tenants', h(async (_req, res) => {
  const [rows] = await getControlPool().query('SELECT * FROM tenants ORDER BY nombre');
  const mes = nowInTz().monthKey;
  const [usos] = await getControlPool().execute('SELECT * FROM uso_mensual WHERE mes = ?', [mes]);
  const porTenant = new Map(usos.map((u) => [u.tenant_id, u]));
  res.json({
    ok: true,
    mes,
    tenants: rows.map((r) => ({ ...vistaTenant(r), uso_mes: porTenant.get(r.id) || null })),
  });
}));

router.post('/tenants', h(async (req, res) => {
  const b = req.body || {};
  const owner = b.owner && b.owner.email ? {
    email: String(b.owner.email).trim().toLowerCase(),
    password: b.owner.password,
    name: b.owner.name || b.owner.nombre,
  } : null;
  const r = await provision.crearTenant({
    slug: String(b.slug || '').trim().toLowerCase(),
    nombre: b.nombre,
    plan: b.plan,
    dominios: b.dominios || [],
    modulos: b.modulos || {},
    branding: b.branding || {},
    config: b.config || {},
    dbUrl: b.db_url || null,
    migrar: b.migrar !== false,
    owner,
  });
  await auditar(req, 'crear_tenant', r.id, {
    slug: r.slug, base_existente: !!b.db_url, schema_creado: r.schemaCreado,
    migraciones: r.migraciones.aplicadas, owner: owner?.email || null,
  });
  res.status(201).json({ ok: true, ...r, tenant: vistaTenant(await filaTenant(r.id)) });
}));

router.get('/tenants/:id', h(async (req, res) => {
  res.json({ ok: true, tenant: vistaTenant(await filaTenant(req.params.id)) });
}));

router.patch('/tenants/:id', h(async (req, res) => {
  const row = await filaTenant(req.params.id);
  const b = req.body || {};
  if ('estado' in b) return res.status(400).json({ ok: false, error: 'El estado se cambia con /suspender, /reactivar o /baja' });
  const tocados = await provision.actualizarTenant(row.id, {
    nombre: b.nombre, plan: b.plan, dominios: b.dominios, modulos: b.modulos,
    branding: b.branding, config: b.config, dbUrl: b.db_url,
  });
  if (tocados.length) await auditar(req, 'editar_tenant', row.id, { slug: row.slug, campos: tocados });
  res.json({ ok: true, cambios: tocados, tenant: vistaTenant(await filaTenant(row.id)) });
}));

async function cambiarEstado(req, res, estado, accion) {
  const row = await filaTenant(req.params.id);
  if (row.estado === estado) return res.json({ ok: true, sin_cambios: true, tenant: vistaTenant(row) });
  await provision.actualizarTenant(row.id, { estado });
  let sockets = 0;
  if (estado !== 'activo') sockets = await disconnectTenant(row.id, estado);
  await auditar(req, accion, row.id, { slug: row.slug, de: row.estado, a: estado, motivo: req.body?.motivo || null, sockets_cortados: sockets });
  res.json({ ok: true, sockets_cortados: sockets, tenant: vistaTenant(await filaTenant(row.id)) });
}
router.post('/tenants/:id/suspender', h((req, res) => cambiarEstado(req, res, 'suspendido', 'suspender_tenant')));
router.post('/tenants/:id/reactivar', h((req, res) => cambiarEstado(req, res, 'activo', 'reactivar_tenant')));
router.post('/tenants/:id/baja', h((req, res) => cambiarEstado(req, res, 'baja', 'baja_tenant')));

router.get('/tenants/:id/secretos/:clave', h(async (req, res) => {
  const row = await filaTenant(req.params.id);
  const clave = req.params.clave;
  if (!registry.SECRET_KEYS.includes(clave)) return res.status(400).json({ ok: false, error: 'Clave desconocida' });
  const config = parseJSON(row.config, {});
  if (!config[clave]) return res.status(404).json({ ok: false, error: 'No está cargada' });
  const valor = clave === 'lead_api_keys' ? decryptJSON(config[clave]) : decrypt(config[clave]);
  await auditar(req, 'ver_secreto', row.id, { slug: row.slug, clave });
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, clave, valor });
}));

router.post('/tenants/:id/migrar', h(async (req, res) => {
  const t = await tenantVivo(req.params.id);
  try {
    const r = await migrateDatabase(registry.dbUrlOf(t), { dryRun: !!req.body?.dry_run });
    if (!req.body?.dry_run) await auditar(req, 'migrar_tenant', t.id, { slug: t.slug, aplicadas: r.aplicadas });
    res.json({ ok: true, slug: t.slug, ...r });
  } catch (e) {
    await auditar(req, 'migrar_tenant_error', t.id, { slug: t.slug, error: e.message });
    res.status(500).json({ ok: false, slug: t.slug, error: e.message, aplicadas: e.aplicadas || [] });
  }
}));

router.get('/tenants/:id/uso', h(async (req, res) => {
  const t = await tenantVivo(req.params.id);
  const meses = Math.min(Math.max(parseInt(req.query.meses, 10) || 6, 1), 24);
  const [historial] = await getControlPool().execute(
    `SELECT mes, usuarios_activos, leads_ingresados, updated_at FROM uso_mensual
      WHERE tenant_id = ? ORDER BY mes DESC LIMIT ${meses}`, [t.id]);
  let actual = null;
  let bot = null;
  let error = null;
  try {
    await runWithTenant(t, async () => {
      [actual] = await uso.actualizarUsoTenant(t);
      bot = await uso.estadoBot();
    });
  } catch (e) {
    error = `No se pudo leer la base del tenant: ${e.code || e.message}`;
  }
  res.json({ ok: true, slug: t.slug, actual, historial, bot, error });
}));

router.post('/tenants/:id/impersonar', h(async (req, res) => {
  const t = await tenantVivo(req.params.id);
  if (t.estado !== 'activo') return res.status(409).json({ ok: false, error: `El tenant está ${t.estado}: reactivalo para entrar` });
  const userId = req.body?.user_id ? Number(req.body.user_id) : null;
  const user = await runWithTenant(t, async () => {
    const [rows] = userId
      ? await db.execute('SELECT id, name, email, role, active, reportsTo FROM users WHERE id = ? AND active = 1', [userId])
      : await db.query("SELECT id, name, email, role, active, reportsTo FROM users WHERE role = 'owner' AND active = 1 ORDER BY id LIMIT 1");
    return rows[0] || null;
  });
  if (!user) return res.status(404).json({ ok: false, error: userId ? 'Usuario inexistente o inactivo' : 'El tenant no tiene un owner activo' });

  // Mismo formato que el login del CRM + imp (quién entró) y vencimiento corto.
  const token = jwt.sign(
    { uid: user.id, role: user.role, id: user.id, email: user.email, active: user.active, tid: t.id, imp: { sid: req.superadmin.id, email: req.superadmin.email } },
    process.env.JWT_SECRET,
    { expiresIn: '1h' });
  await auditar(req, 'impersonar', t.id, { slug: t.slug, user_id: user.id, user_email: user.email, motivo: req.body?.motivo || null });
  res.json({ ok: true, slug: t.slug, dominios: t.dominios, url: subdominios.urlDeSlug(t.slug), token, expira_en: '1h', user });
}));

// ---------- uso de todos (facturación) ----------
router.get('/uso', h(async (req, res) => {
  const mes = String(req.query.mes || nowInTz().monthKey);
  if (!uso.MES_RE.test(mes)) return res.status(400).json({ ok: false, error: 'mes tiene que ser YYYY-MM' });
  const errores = [];
  if (req.query.recalcular === '1') {
    registry.invalidate();
    for (const t of await registry.listAll()) {
      if (t.estado === 'baja') continue;
      try {
        await runWithTenant(t, async () => uso.guardarUso(t.id, await uso.calcularUso(mes)));
      } catch (e) {
        errores.push({ slug: t.slug, error: e.code || e.message });
      }
    }
  }
  const [rows] = await getControlPool().execute(
    `SELECT t.id, t.slug, t.nombre, t.plan, t.estado, u.usuarios_activos, u.leads_ingresados, u.updated_at
       FROM tenants t LEFT JOIN uso_mensual u ON u.tenant_id = t.id AND u.mes = ?
      WHERE t.estado <> 'baja' ORDER BY t.nombre`, [mes]);
  res.json({ ok: true, mes, tenants: rows, errores });
}));

router.get('/auditoria', h(async (req, res) => {
  const lim = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const params = [];
  let where = '';
  if (req.query.tenant_id) { where = 'WHERE a.tenant_id = ?'; params.push(Number(req.query.tenant_id)); }
  const [rows] = await getControlPool().execute(
    `SELECT a.*, t.slug FROM audit_log a LEFT JOIN tenants t ON t.id = a.tenant_id ${where}
      ORDER BY a.id DESC LIMIT ${lim}`, params);
  res.json({ ok: true, eventos: rows.map((r) => ({ ...r, detalle: parseJSON(r.detalle, null) })) });
}));

module.exports = router;
