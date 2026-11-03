/**
 * Uso mensual por tenant, para facturar por usuario.
 *
 *   usuarios_activos = usuarios distintos que en el mes iniciaron sesión
 *                      (user_logins) o usaron el CRM (user_sessions, una
 *                      fila por conexión del socket). No cuenta al usuario
 *                      de sistema del agente ni las sesiones de soporte
 *                      ("entrar como owner").
 *   leads_ingresados = leads con created_at dentro del mes.
 *
 * El mes se corta en la zona horaria del tenant (tenants.config.timezone):
 * el inicio y fin del mes local se pasan al reloj de la base (sea UTC o no)
 * antes de comparar. Se guarda en autoatento_control.uso_mensual.
 */
const axios = require('axios');
const db = require('../db');
const { getControlPool } = require('../tenancy/control');
const { everyTenant } = require('../tenancy/jobs');
const { nowInTz, rangoMesUtc } = require('../tenancy/time');
const { waBot } = require('../tenancy/settings');
const { AGENT_EMAIL } = require('../agent/schema');

const MES_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Bordes del mes 'YYYY-MM' (hora local del tenant) expresados en el reloj de
 * la base del tenant, como 'YYYY-MM-DD HH:MM:SS' para comparar con DATETIME/
 * TIMESTAMP escritos con NOW().
 */
async function rangoMes(mes) {
  if (!MES_RE.test(mes)) throw new Error(`Mes inválido: ${mes} (YYYY-MM)`);
  const { desde, hasta } = rangoMesUtc(mes);
  const [[{ off }]] = await db.query('SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW()) AS off');
  const enBase = (d) => new Date(d.getTime() + Number(off) * 1000).toISOString().slice(0, 19).replace('T', ' ');
  return { desde: enBase(desde), hasta: enBase(hasta) };
}

function mesAnterior(mes) {
  const [y, m] = mes.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

async function tablaExiste(nombre) {
  const [[r]] = await db.query(
    'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [nombre]);
  return r.n > 0;
}

/** Calcula el uso del tenant del contexto. */
async function calcularUso(mes) {
  const { desde, hasta } = await rangoMes(mes);
  const partes = ['SELECT user_id FROM user_sessions WHERE session_start >= ? AND session_start < ?'];
  const params = [desde, hasta];
  if (await tablaExiste('user_logins')) {
    partes.push('SELECT user_id FROM user_logins WHERE created_at >= ? AND created_at < ?');
    params.push(desde, hasta);
  }
  const [[u]] = await db.query(
    `SELECT COUNT(DISTINCT x.user_id) AS n
       FROM (${partes.join(' UNION ')}) x
       JOIN users u ON u.id = x.user_id
      WHERE u.email <> ?`, [...params, AGENT_EMAIL]);
  const [[l]] = await db.query('SELECT COUNT(*) AS n FROM leads WHERE created_at >= ? AND created_at < ?', [desde, hasta]);
  return { mes, usuarios_activos: Number(u.n), leads_ingresados: Number(l.n) };
}

async function guardarUso(tenantId, uso) {
  await getControlPool().execute(
    `INSERT INTO uso_mensual (tenant_id, mes, usuarios_activos, leads_ingresados) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE usuarios_activos = VALUES(usuarios_activos), leads_ingresados = VALUES(leads_ingresados)`,
    [tenantId, uso.mes, uso.usuarios_activos, uso.leads_ingresados]);
}

/** Calcula y guarda el mes actual (y el anterior los primeros 3 días, para cerrarlo). */
async function actualizarUsoTenant(tenant) {
  const ahora = nowInTz();
  const meses = [ahora.monthKey];
  if (ahora.day <= 3) meses.push(mesAnterior(ahora.monthKey));
  const out = [];
  for (const mes of meses) {
    const uso = await calcularUso(mes);
    await guardarUso(tenant.id, uso);
    out.push(uso);
  }
  return out;
}

/** Estado del bot de WhatsApp del tenant del contexto. */
async function estadoBot() {
  const { url, key } = waBot();
  const out = { configurado: !!(url && key), url: url || null, alcanzable: null, http: null, sesiones: [] };
  if (await tablaExiste('wa_sessions')) {
    const [rows] = await db.query('SELECT id AS user_id, supervisor_name, phone, status, bot_enabled, updated_at FROM wa_sessions ORDER BY id');
    out.sesiones = rows;
  }
  if (url) {
    try {
      const r = await axios.get(url, { timeout: 3000, validateStatus: () => true });
      out.alcanzable = true;
      out.http = r.status;
    } catch (e) {
      out.alcanzable = false;
      out.error = e.code || e.message;
    }
  }
  return out;
}

/** Tarea: cada hora actualiza uso_mensual de todos los tenants activos. */
function startUsoJob() {
  return everyTenant('uso-mensual', 60 * 60 * 1000, (t) => actualizarUsoTenant(t), { firstRunMs: 60 * 1000 });
}

module.exports = { calcularUso, guardarUso, actualizarUsoTenant, estadoBot, startUsoJob, rangoMes, MES_RE };
