/**
 * ============================================
 * AGENTE IA — CONFIGURACIÓN
 * ============================================
 * Se guarda en agent_config (clave/valor) y se edita desde el panel.
 *
 * mode:
 *   off    -> el agente no hace nada (los cursores igual avanzan, así al
 *             prenderlo no procesa todo lo viejo de golpe)
 *   shadow -> analiza todo pero NINGUNA acción se ejecuta sola: todo queda
 *             pendiente de aprobación. Es el modo para arrancar.
 *   auto   -> ejecuta solo las acciones de bajo riesgo; las de
 *             tools_con_aprobacion siguen pasando por la bandeja.
 */
const DEFAULTS = {
  mode: 'shadow',
  sla_nuevo_min: '60',
  estancado_dias: '3',
  horario_inicio: '9',
  horario_fin: '20',
  dias_laborales: '1,2,3,4,5,6', // 0 = domingo
  max_runs_dia: '300',
  tools_con_aprobacion: 'update_lead_estado,reassign_lead',
  whatsapp_automatico: '0', // 1 = en modo auto, los WhatsApp a clientes salen sin aprobación
  max_acciones_corrida: '2',
  instrucciones_extra: '',
};

const VALIDATORS = {
  mode: (v) => ['off', 'shadow', 'auto'].includes(v),
  sla_nuevo_min: (v) => Number.isInteger(+v) && +v >= 5 && +v <= 1440,
  estancado_dias: (v) => Number.isInteger(+v) && +v >= 1 && +v <= 30,
  horario_inicio: (v) => Number.isInteger(+v) && +v >= 0 && +v <= 23,
  horario_fin: (v) => Number.isInteger(+v) && +v >= 1 && +v <= 24,
  dias_laborales: (v) => /^[0-6](,[0-6])*$/.test(v),
  max_runs_dia: (v) => Number.isInteger(+v) && +v >= 0 && +v <= 5000,
  tools_con_aprobacion: (v) => /^[a-z_,]*$/.test(v),
  whatsapp_automatico: (v) => ['0', '1', 'true', 'false'].includes(v),
  max_acciones_corrida: (v) => Number.isInteger(+v) && +v >= 1 && +v <= 5,
  instrucciones_extra: (v) => typeof v === 'string' && v.length <= 2000,
};

// Multi-tenant: pool es el proxy (base del tenant actual) y la caché es por tenant.
const pool = require('../db');
const { perTenant } = require('../tenancy/state');
const { nowInTz } = require('../tenancy/time');

const cacheDe = perTenant('agent.config', () => ({ value: null, at: 0 }));
const TTL = 15 * 1000;

function init() { /* compatibilidad: ya no hace falta pasar el pool */ }

async function get() {
  const c = cacheDe();
  if (c.value && Date.now() - c.at < TTL) return c.value;
  const [rows] = await pool.query('SELECT k, v FROM agent_config');
  const cfg = { ...DEFAULTS };
  for (const r of rows) if (r.k in DEFAULTS && r.v !== null) cfg[r.k] = r.v;
  c.value = parse(cfg);
  c.at = Date.now();
  return c.value;
}

function parse(raw) {
  return {
    mode: raw.mode,
    sla_nuevo_min: +raw.sla_nuevo_min,
    estancado_dias: +raw.estancado_dias,
    horario_inicio: +raw.horario_inicio,
    horario_fin: +raw.horario_fin,
    dias_laborales: raw.dias_laborales.split(',').map(Number),
    max_runs_dia: +raw.max_runs_dia,
    tools_con_aprobacion: raw.tools_con_aprobacion.split(',').map((s) => s.trim()).filter(Boolean),
    whatsapp_automatico: raw.whatsapp_automatico === '1' || raw.whatsapp_automatico === 'true',
    max_acciones_corrida: +raw.max_acciones_corrida,
    instrucciones_extra: raw.instrucciones_extra || '',
  };
}

/** Guarda solo las claves válidas. Devuelve { ok, errors, config } */
async function set(partial, userId) {
  const errors = {};
  const toSave = [];
  for (const [k, val] of Object.entries(partial || {})) {
    if (!(k in DEFAULTS)) continue;
    const v = Array.isArray(val) ? val.join(',') : typeof val === 'boolean' ? (val ? '1' : '0') : String(val ?? '');
    if (!VALIDATORS[k](v)) { errors[k] = 'Valor inválido'; continue; }
    toSave.push([k, v]);
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  for (const [k, v] of toSave) {
    await pool.execute(
      'INSERT INTO agent_config (k, v, updated_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v), updated_by = VALUES(updated_by)',
      [k, v, userId || null]
    );
  }
  cacheDe().value = null;
  return { ok: true, config: await get() };
}

async function getCursor(name) {
  const [rows] = await pool.execute('SELECT v FROM agent_config WHERE k = ?', [`cursor_${name}`]);
  return rows.length ? Number(rows[0].v) : null;
}

async function setCursor(name, value) {
  await pool.execute(
    'INSERT INTO agent_config (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)',
    [`cursor_${name}`, String(value)]
  );
}

/**
 * Hora local del tenant (tenants.config.timezone, default Buenos Aires).
 * Mantiene el nombre nowArg() por compatibilidad: { date, time, hour, weekday, iso }.
 */
function nowArg() {
  return nowInTz();
}

function enHorario(cfg) {
  const n = nowArg();
  return cfg.dias_laborales.includes(n.weekday) && n.hour >= cfg.horario_inicio && n.hour < cfg.horario_fin;
}

module.exports = { init, get, set, getCursor, setCursor, nowArg, enHorario, DEFAULTS };
