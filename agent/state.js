/**
 * ============================================
 * AGENTE IA — ESTADO POR TENANT
 * ============================================
 * Cada tenant tiene su propia base, así que las tablas del agente y el
 * usuario de sistema "Agente IA" (con un id distinto en cada base) se
 * preparan una vez por tenant, la primera vez que se usa el agente ahí.
 */
const db = require('../db');
const { perTenant } = require('../tenancy/state');
const { ensureSchema } = require('./schema');

const estado = perTenant('agent.ready', () => ({ promise: null, user: null, recuperado: false }));

/**
 * Asegura tablas + usuario del agente en el tenant actual.
 * @param {{ recuperar?: () => Promise<void> }} opts  recuperar: se corre una
 *   sola vez por tenant (devolver a la cola lo que quedó a medias).
 */
async function ensureReady({ recuperar = null } = {}) {
  const st = estado();
  if (!st.promise) {
    st.promise = ensureSchema(db)
      .then((user) => { st.user = user; return user; })
      .catch((e) => { st.promise = null; throw e; });
  }
  const user = await st.promise;
  if (recuperar && !st.recuperado) {
    st.recuperado = true;
    await recuperar().catch((e) => { st.recuperado = false; throw e; });
  }
  return user;
}

/** Usuario de sistema del agente en el tenant actual ({ id, name }). */
function agentUser() {
  const u = estado().user;
  if (!u) throw new Error('Agente IA: el tenant todavía no está inicializado (falta ensureReady)');
  return u;
}

module.exports = { ensureReady, agentUser };
