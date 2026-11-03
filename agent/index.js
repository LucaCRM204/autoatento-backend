/**
 * ============================================
 * AGENTE IA — PUNTO DE ENTRADA
 * ============================================
 * Uso en server.js:
 *   const agent = require('./agent');
 *   agent.mount(app);                 // rutas (antes de levantar el server)
 *   await agent.start({ pool, io });  // loops (después del bootstrap)
 *
 * Multi-tenant:
 *   - tablas + usuario del agente se crean por tenant la primera vez (state.js)
 *   - scanner y worker recorren los tenants activos (everyTenant); el análisis
 *     con IA solo corre en tenants con el módulo agente_ia prendido. El aviso
 *     de recordatorios vencidos (sin IA) corre en todos.
 *   - key del LLM, proveedor y modelo: tenants.config con fallback al env
 *   - MCP: /api/t/<slug>/mcp con la agent_mcp_key del tenant
 *
 * Variables de entorno (fallback global):
 *   OPENAI_API_KEY     la misma de los bots (o ANTHROPIC_API_KEY); ver llm.js
 *   AGENT_PROVIDER     opcional: 'openai' | 'anthropic' (si están las dos)
 *   AGENT_MODEL        opcional (default gpt-4o-mini / claude-sonnet-5-5)
 *   AGENT_DISABLED=1   apaga los loops (útil en entornos de prueba)
 *   AGENT_CONCURRENCY  tenants procesados en paralelo por el worker (default 4)
 */
const config = require('./config');
const tools = require('./tools');
const runner = require('./runner');
const scanner = require('./scanner');
const worker = require('./worker');
const llm = require('./llm');
const { ensureReady } = require('./state');
const { everyTenant } = require('../tenancy/jobs');
const { resolveTenant } = require('../tenancy/middleware');

let listo = false;
const guard = (_req, res, next) => {
  if (!listo) return res.status(503).json({ ok: false, error: 'El agente todavía no arrancó' });
  ensureReady()
    .then(() => next())
    .catch((e) => {
      console.error('[agente] preparando tenant:', e.message);
      res.status(503).json({ ok: false, error: 'El agente no pudo prepararse para esta cuenta' });
    });
};

function mount(app) {
  // Ambas quedan detrás de resolveTenant (todo /api lo tiene en server.js)
  app.use('/api/agent', guard, require('./routes'));
  app.use('/api/mcp', guard, require('./mcp'));
  // Compatibilidad: /mcp con header X-Tenant
  app.use('/mcp', resolveTenant, guard, require('./mcp'));
}

let loops = [];

async function start() {
  try {
    config.init();
    tools.init();
    runner.init();
    scanner.init();
    worker.init();
    listo = true;

    if (process.env.AGENT_DISABLED === '1') {
      console.log('🤖 Agente IA: loops desactivados (AGENT_DISABLED=1)');
      return;
    }

    const preparar = () => ensureReady({ recuperar: worker.recuperarColgados });
    loops = [
      everyTenant('agente-scanner', 60 * 1000, async () => { await preparar(); return scanner.tick(); }, { firstRunMs: 10 * 1000 }),
      everyTenant('agente-worker', 5 * 1000, async () => { await preparar(); return worker.tick(); }, {
        filter: (t) => t.modulos.agente_ia,
        concurrency: Number(process.env.AGENT_CONCURRENCY) || 4,
      }),
    ];

    console.log(`🤖 Agente IA activo por tenant — default ${llm.PROVIDER}/${llm.MODEL}${llm.hasKey() ? '' : ` (sin ${llm.KEY_VAR} global)`}`);
  } catch (e) {
    // El CRM tiene que seguir andando aunque el agente no arranque.
    console.error('❌ Agente IA no arrancó:', e.message);
  }
}

function stop() {
  loops.forEach((l) => l.stop());
  loops = [];
}

module.exports = { mount, start, stop };
