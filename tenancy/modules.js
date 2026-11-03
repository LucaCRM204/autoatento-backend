/**
 * Módulos (feature flags) por tenant. Lo que no está en tenants.modulos
 * toma el default de acá. Las funcionalidades específicas de un cliente se
 * agregan como módulo nuevo, no se borran.
 */
const MODULOS = {
  agente_ia: { default: true, nombre: 'Agente IA' },
  whatsapp_bot: { default: true, nombre: 'Bot de WhatsApp' },
  chat_whatsapp: { default: true, nombre: 'Chat de WhatsApp en el CRM' },
  presupuestos: { default: true, nombre: 'Presupuestos' },
  metas: { default: true, nombre: 'Metas' },
  ranking: { default: true, nombre: 'Ranking' },
  analytics: { default: true, nombre: 'Analytics' },
  asignar_tareas: { default: true, nombre: 'Asignar tareas' },
  multi_marca: { default: false, nombre: 'Multi marca' },
  motos: { default: false, nombre: 'Motos' },
  scoring: { default: false, nombre: 'Scoring de leads' },
};

/** Devuelve todos los módulos con valor booleano (defaults + lo guardado). */
function normalizarModulos(guardados) {
  const out = {};
  const src = guardados && typeof guardados === 'object' ? guardados : {};
  for (const [k, def] of Object.entries(MODULOS)) {
    out[k] = k in src ? !!src[k] : def.default;
  }
  return out;
}

module.exports = { MODULOS, normalizarModulos };
