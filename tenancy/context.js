/**
 * Contexto de tenant por request / por tarea (AsyncLocalStorage).
 *
 * Todo lo que corre "dentro" de runWithTenant (incluyendo awaits, timers y
 * callbacks que se crean ahí) ve el mismo tenant con currentTenant().
 * db.js, emitTenant y la config del agente leen el tenant de acá.
 */
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

function runWithTenant(tenant, fn) {
  if (!tenant || !tenant.id) throw new Error('runWithTenant: tenant inválido');
  // El pool se resuelve en cada uso (pools.js), así un pool cerrado por
  // inactividad o una db_url cambiada se recrea sin reiniciar nada.
  const store = {
    tenant,
    get pool() { return require('./pools').getPool(tenant); },
  };
  return als.run(store, fn);
}

function currentTenant() {
  return als.getStore()?.tenant || null;
}

class NoTenantError extends Error {
  constructor(what = 'operación') {
    super(`[tenancy] ${what} sin tenant en el contexto: falta resolveTenant (request) o forEachTenant/runWithTenant (tarea en segundo plano)`);
    this.code = 'NO_TENANT';
  }
}

function requireTenant(what) {
  const t = currentTenant();
  if (!t) throw new NoTenantError(what);
  return t;
}

module.exports = { runWithTenant, currentTenant, requireTenant, NoTenantError, als };
