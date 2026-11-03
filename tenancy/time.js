/**
 * Hora local del tenant (tenants.config.timezone, default Buenos Aires).
 * Reemplaza el "UTC-3 fijo" y la hora del servidor (que en Railway es UTC).
 */
const { currentTenant } = require('./context');
const { DEFAULT_TIMEZONE } = require('./registry');

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map();
const avisados = new Set();

function formatter(tz) {
  if (!formatters.has(tz)) {
    formatters.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return formatters.get(tz);
}

function tenantTimezone(tenant = currentTenant()) {
  const tz = tenant?.config?.timezone || DEFAULT_TIMEZONE;
  try {
    formatter(tz);
    return tz;
  } catch {
    if (!avisados.has(tz)) { avisados.add(tz); console.error(`[time] zona horaria inválida "${tz}", uso ${DEFAULT_TIMEZONE}`); }
    return DEFAULT_TIMEZONE;
  }
}

/**
 * Misma forma que el viejo agent/config.nowArg():
 *   { date: 'YYYY-MM-DD', time: 'HH:MM', hour, minute, weekday (0=domingo), iso: 'YYYY-MM-DD HH:MM', monthKey: 'YYYY-MM', day }
 */
function nowInTz(tz = tenantTimezone(), date = new Date()) {
  const p = {};
  for (const part of formatter(tz).formatToParts(date)) p[part.type] = part.value;
  const d = `${p.year}-${p.month}-${p.day}`;
  const time = `${p.hour}:${p.minute}`;
  return {
    date: d,
    time,
    hour: Number(p.hour),
    minute: Number(p.minute),
    weekday: WEEKDAYS[p.weekday],
    day: Number(p.day),
    iso: `${d} ${time}`,
    monthKey: `${p.year}-${p.month}`,
    tz,
  };
}

/** Diferencia (ms) entre la hora local de tz y UTC en ese instante. */
function offsetMs(tz, date) {
  const p = {};
  for (const part of formatter(tz).formatToParts(date)) p[part.type] = part.value;
  const comoUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return comoUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Instante (Date) de la medianoche local del día y/m/d en tz. */
function medianocheUtc(y, m, d, tz) {
  const guess = Date.UTC(y, m - 1, d);
  const off1 = offsetMs(tz, new Date(guess));
  let utc = guess - off1;
  const off2 = offsetMs(tz, new Date(utc));
  if (off2 !== off1) utc = guess - off2; // cambio de horario justo en el borde
  return new Date(utc);
}

/** [desde, hasta) del mes 'YYYY-MM' en la zona horaria tz, como instantes UTC. */
function rangoMesUtc(mes, tz = tenantTimezone()) {
  const [y, m] = mes.split('-').map(Number);
  const [y2, m2] = m === 12 ? [y + 1, 1] : [y, m + 1];
  return { desde: medianocheUtc(y, m, 1, tz), hasta: medianocheUtc(y2, m2, 1, tz) };
}

module.exports = { nowInTz, tenantTimezone, rangoMesUtc, medianocheUtc, DEFAULT_TIMEZONE };
