/**
 * Estado en memoria separado por tenant (índices de round-robin, cachés,
 * flags de "ya corrió"). Reemplaza los `let x = ...` a nivel de módulo, que
 * con varios tenants se compartirían.
 *
 *   const rr = perTenant('webhooks.rr', () => ({ index: 0 }));
 *   rr().index++;            // usa el tenant del contexto
 */
const { requireTenant } = require('./context');

const stores = new Map(); // nombre -> Map(tenantId -> estado)

function perTenant(name, init = () => ({})) {
  if (!stores.has(name)) stores.set(name, new Map());
  const map = stores.get(name);
  const get = (tenant = requireTenant(`estado "${name}"`)) => {
    if (!map.has(tenant.id)) map.set(tenant.id, init(tenant));
    return map.get(tenant.id);
  };
  get.reset = (tenant) => (tenant ? map.delete(tenant.id) : map.clear());
  return get;
}

module.exports = { perTenant };
