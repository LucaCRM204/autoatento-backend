/**
 * Pools de MySQL por tenant, creados recién cuando se usan (lazy).
 *
 * - connectionLimit chico (TENANT_POOL_LIMIT, default 4): con decenas de
 *   tenants en un mismo servidor no se agotan las conexiones.
 * - Un pool sin uso por TENANT_POOL_IDLE_MS (default 30 min) se cierra.
 * - Si la db_url del tenant cambia (ej. se lo apunta a otra base), el pool
 *   viejo se cierra y se crea uno nuevo.
 */
const mysql = require('mysql2/promise');
const env = require('./env');
const registry = require('./registry');

const pools = new Map(); // tenantId -> { pool, url, lastUsed }

function createPool(url) {
  return mysql.createPool({
    uri: url,
    waitForConnections: true,
    connectionLimit: env.TENANT_POOL_LIMIT,
    queueLimit: 0,
    enableKeepAlive: true,
    // Las bases guardan UTC (NOW() de MySQL en Railway). Con 'Z', mysql2 lee y
    // escribe las fechas de JS en UTC sin depender de la zona horaria del
    // proceso (antes: 'local', que solo coincidía si el proceso corría en UTC).
    timezone: 'Z',
  });
}

function closeEntry(id, entry, motivo) {
  pools.delete(id);
  entry.pool.end().catch((e) => console.error(`[pools] cerrando pool del tenant #${id}:`, e.message));
  if (process.env.TENANCY_DEBUG) console.log(`[pools] pool del tenant #${id} cerrado (${motivo})`);
}

function getPool(tenant) {
  const url = registry.dbUrlOf(tenant);
  if (!url) throw new Error(`El tenant "${tenant.slug}" no tiene connection string utilizable`);
  let entry = pools.get(tenant.id);
  if (entry && entry.url !== url) {
    closeEntry(tenant.id, entry, 'cambió la db_url');
    entry = null;
  }
  if (!entry) {
    entry = { pool: createPool(url), url, lastUsed: Date.now() };
    pools.set(tenant.id, entry);
  }
  entry.lastUsed = Date.now();
  return entry.pool;
}

function sweepIdle(now = Date.now()) {
  for (const [id, entry] of pools) {
    if (now - entry.lastUsed > env.TENANT_POOL_IDLE_MS) closeEntry(id, entry, 'inactivo');
  }
}

const sweeper = setInterval(sweepIdle, Math.min(5 * 60 * 1000, env.TENANT_POOL_IDLE_MS));
sweeper.unref();

async function closeAll() {
  const all = [...pools.entries()];
  pools.clear();
  await Promise.allSettled(all.map(([, e]) => e.pool.end()));
}

const stats = () => [...pools.entries()].map(([id, e]) => ({ tenantId: id, lastUsed: new Date(e.lastUsed).toISOString() }));

module.exports = { getPool, closeAll, sweepIdle, stats };
