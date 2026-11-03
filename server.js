/**
 * ============================================
 * SERVER.JS — AUTOATENTO (CRM multi-tenant)
 * Con WebSockets en tiempo real, sin módulo de scoring
 * + Agente IA (carpeta agent/): eventos, bandeja de aprobación y MCP
 *
 * Multi-tenant: una base por tenant. Cada request a /api resuelve su tenant
 * (header X-Tenant o /api/t/<slug>/...) y corre dentro de ese contexto; db.js
 * usa el pool de ese tenant. Ver MULTITENANT.md.
 * ============================================
 */
const express = require('express');
const http = require('http');
const helmet = require('helmet');
const morgan = require('morgan');
const cors = require('cors');
const compression = require('compression');
const cookieParser = require('cookie-parser');
require('dotenv').config();

// Importar socket server
const { initSocketServer } = require('./socket-server');

// Proxy multi-tenant con la misma interfaz que el pool de MySQL de antes
const pool = require('./db');

const { tenantPathRewrite, resolveTenant, publicTenantRouter } = require('./tenancy/middleware');
const { emitTenant, everyTenant, perTenant, nowInTz } = require('./tenancy');
const { authenticateToken } = require('./middleware/auth');

// Importar rutas
const authRouter = require('./routes/auth');
const leadsRouter = require('./routes/leads');
const activityRouter = require('./routes/activity');
const metasRouter = require('./routes/metas');

let usersRouter;
try {
  usersRouter = require('./routes/users');
} catch (_) {
  usersRouter = null;
}

const app = express();
const server = http.createServer(app);

// Guardar pool en app para usar en rutas (es el proxy: resuelve el tenant en cada query)
app.set('db', pool);

// Proxy (necesario para cookie Secure detrás de Railway/similares)
app.set('trust proxy', 1);

// /api/t/<slug>/... -> /api/... (webhooks externos y MCP). Tiene que ir primero.
app.use(tenantPathRewrite);

app.use(helmet());
// 15 MB: el chat de WhatsApp del CRM manda imágenes en base64
app.use(express.json({ limit: '15mb' }));
app.use(cookieParser());
app.use(compression());
app.use(morgan('dev'));

// CORS configuration
const corsOpts = {
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-API-Key', 'Accept', 'X-Tenant'],
  optionsSuccessStatus: 200,
};
app.use(cors(corsOpts));
app.options('*', cors(corsOpts));

// Rutas sin tenant
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.use('/api/public', publicTenantRouter);

// De acá en adelante todo /api corre dentro del contexto de un tenant
app.use('/api', resolveTenant);

// Rutas principales
app.use('/api/auth', authRouter);

// Middleware: auto-emit socket events on lead changes
app.use('/api/leads', (req, res, next) => {
  if (req.method === 'GET') return next();

  const originalJson = res.json.bind(res);

  res.json = function (data) {
    const io = req.app.get('io');
    if (!io) return originalJson(data);

    try {
      // POST /api/leads (solo creación, no búsqueda)
      if (req.method === 'POST' && req.path === '/' && data?.lead && !data?.leads) {
        emitTenant('lead:created', data.lead);
        console.log(`📡 [RT] lead:created #${data.lead.id}`);
      }

      // PUT/PATCH → lead:updated
      if ((req.method === 'PUT' || req.method === 'PATCH') && data?.lead) {
        emitTenant('lead:updated', data.lead);
        console.log(`📡 [RT] lead:updated #${data.lead.id} (${req.method} ${req.path})`);
      }

      // DELETE → lead:deleted
      if (req.method === 'DELETE' && req.path.match(/^\/\d+$/)) {
        const leadId = parseInt(req.path.replace('/', ''));
        emitTenant('lead:deleted', leadId);
        console.log(`📡 [RT] lead:deleted #${leadId}`);
      }

      // Notificación al asignado
      if (req.method === 'POST' && data?.lead?.assigned_to) {
        emitTenant('notification', {
          id: `lead-${data.lead.id}-${Date.now()}`,
          type: 'lead_created',
          title: 'Nuevo lead asignado',
          message: `${data.lead.nombre || 'Lead nuevo'} - ${data.lead.modelo || 'Sin modelo'}`,
          timestamp: new Date().toISOString(),
          read: false,
          severity: 'info',
          leadId: data.lead.id,
          targetUserId: data.lead.assigned_to
        });
      }
    } catch (err) {
      console.error('Socket emit error:', err.message);
    }

    return originalJson(data);
  };

  next();
});

app.use('/api/leads', leadsRouter);
app.use('/api/presupuestos', require('./routes/presupuestos'));
app.use('/api/webhooks', require('./routes/webhooks')); // whatsapp-bot y zapier-formularios (emiten sockets internamente)
app.use('/api/activity', activityRouter);
// calls, metas y users no tenían auth: ahora piden token (el front ya lo manda)
app.use('/api/metas', authenticateToken, metasRouter(pool));
app.use('/api/distribution', require('./routes/distribution'));
app.use('/api/calls', authenticateToken, require('./routes/calls'));
app.use('/api/notas', require('./routes/notas'));
app.use('/api/recordatorios', require('./routes/recordatorios'));
app.use('/api/cotizaciones', require('./routes/cotizaciones'));
app.use('/api/alertas', require('./routes/alertas'));
if (usersRouter) app.use('/api/users', authenticateToken, usersRouter);

// Tareas que supervisores/gerentes asignan a vendedores
app.use('/api/tareas', require('./routes/tareas'));

// Chat de WhatsApp de cada lead (lee la base y manda por el bot)
app.use('/api/whatsapp', require('./routes/whatsapp'));

// Agente IA: bandeja/aprobaciones en /api/agent y servidor MCP en /api/mcp
// (externos: /api/t/<slug>/mcp)
const agent = require('./agent');
agent.mount(app);

// Ruta raíz
app.get('/', (_req, res) => res.json({
  message: 'AutoAtento Backend API',
  version: '2.0.0',
  features: ['multi-tenant', 'realtime', 'presence', 'activity-tracking', 'auto-reassignment', 'metas', 'distribucion-ponderada']
}));

// Inicializar WebSockets
const io = initSocketServer(server, pool);
app.set('io', io);

// ============================================
// TAREAS PROGRAMADAS: distribución de leads (por tenant)
// ============================================
const dist = require('./services/distribucion.service');

const MIN = 60 * 1000;

// Cada 15 min: realinea los equipos por si algún cambio de jerarquía
// se escapó (edición directa en la base, deploy a mitad de camino, etc).
// Primer realineado 30s después de arrancar, ya con todo levantado.
everyTenant('distribucion', 15 * MIN, async (t) => {
  const n = await dist.sincronizarTodos();
  if (n) console.log(`⚖️  [${t.slug}] Distribución: ${n} equipos realineados`);
  return n;
}, { firstRunMs: 30 * 1000 });

// Reset del contador "recibidos este mes".
// Se chequea cada hora; corre el día 1 en la zona horaria de cada tenant.
const resetMensual = perTenant('distribucion.resetMensual', () => ({ ultimo: null }));
everyTenant('reset-mensual', 60 * MIN, async (t) => {
  const ahora = nowInTz();
  const estado = resetMensual();
  if (ahora.day !== 1 || estado.ultimo === ahora.monthKey) return;

  estado.ultimo = ahora.monthKey;
  try {
    await dist.resetMensual();
    console.log(`⚖️  [${t.slug}] Distribución: contadores mensuales reseteados`);
  } catch (e) {
    estado.ultimo = null; // que reintente en la próxima hora
    throw e;
  }
});

const PORT = process.env.PORT || 3001;

require('./bootstrap')()
  .finally(() => agent.start({ pool, io }))
  .finally(() => server.listen(PORT, () => {
    console.log(`\n🚀 AutoAtento backend escuchando en puerto ${PORT}`);
    console.log(`🏢 Multi-tenant: header X-Tenant o /api/t/<slug>/...`);
    console.log(`⚡ WebSockets habilitados (rooms por tenant)`);
    console.log(`⚖️  Distribución ponderada activa`);
    console.log(`📥 Webhooks: /api/t/<slug>/webhooks/whatsapp-bot | zapier-formularios | sheets\n`);
  }));

module.exports = { app, server };
