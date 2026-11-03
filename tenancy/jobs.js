/**
 * Tareas en segundo plano por tenant.
 *
 * forEachTenant(fn)  -> corre fn(tenant) dentro del contexto de cada tenant
 *                       activo. Un tenant que falla no frena a los demás.
 * everyTenant(...)   -> setInterval + forEachTenant, sin solapar corridas
 *                       del mismo tenant si una tarda más que el intervalo.
 */
const registry = require('./registry');
const { runWithTenant } = require('./context');

/**
 * @param {(tenant) => Promise<any>} fn
 * @param {{ name?: string, concurrency?: number, filter?: (tenant) => boolean }} opts
 * @returns {Promise<Array<{slug, ok, result?, error?}>>}
 */
async function forEachTenant(fn, { name = 'tarea', concurrency = 1, filter = null } = {}) {
  let tenants;
  try {
    tenants = await registry.listActive();
  } catch (e) {
    console.error(`[${name}] no se pudo leer la lista de tenants:`, e.message);
    return [];
  }
  if (filter) tenants = tenants.filter(filter);

  const results = new Array(tenants.length);
  let next = 0;
  async function worker() {
    while (next < tenants.length) {
      const i = next++;
      const t = tenants[i];
      try {
        const result = await runWithTenant(t, () => fn(t));
        results[i] = { slug: t.slug, ok: true, result };
      } catch (e) {
        console.error(`[${name}][${t.slug}]`, e.message);
        results[i] = { slug: t.slug, ok: false, error: e.message };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, tenants.length)) }, worker));
  return results;
}

/**
 * @returns {{ stop(): void, tick(): Promise<any> }}
 */
function everyTenant(name, ms, fn, { firstRunMs = null, concurrency = 1, filter = null } = {}) {
  const enCurso = new Set();
  const tick = () => forEachTenant(async (t) => {
    if (enCurso.has(t.id)) return { salteado: 'corrida anterior en curso' };
    enCurso.add(t.id);
    try {
      return await fn(t);
    } finally {
      enCurso.delete(t.id);
    }
  }, { name, concurrency, filter });

  const interval = setInterval(tick, ms);
  const first = firstRunMs !== null ? setTimeout(tick, firstRunMs) : null;
  return {
    tick,
    stop() { clearInterval(interval); if (first) clearTimeout(first); },
  };
}

module.exports = { forEachTenant, everyTenant };
