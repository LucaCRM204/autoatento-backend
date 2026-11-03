/**
 * Socket.io por tenant. Cada socket entra a:
 *   tenant:<id>               -> todos los usuarios conectados de ese tenant
 *   tenant:<id>:user:<uid>    -> las pestañas de un usuario de ese tenant
 * Ningún evento sale sin tenant: si no hay tenant en el contexto se
 * descarta y se loguea el error (nunca se hace un io.emit global).
 */
const { currentTenant } = require('./context');

let io = null;

const tenantRoom = (tenantId) => `tenant:${tenantId}`;
const userRoom = (tenantId, userId) => `tenant:${tenantId}:user:${userId}`;

function setIO(instance) { io = instance; }
function getIO() { return io; }

function sinTenant(evento) {
  console.error(`[realtime] evento "${evento}" sin tenant en el contexto: descartado`);
  return false;
}

/** Emite a todos los conectados del tenant actual. */
function emitTenant(evento, data) {
  const t = currentTenant();
  if (!t) return sinTenant(evento);
  if (!io) return false;
  io.to(tenantRoom(t.id)).emit(evento, data);
  return true;
}

/** Emite a un usuario del tenant actual (todas sus pestañas). */
function emitTenantUser(userId, evento, data) {
  const t = currentTenant();
  if (!t) return sinTenant(evento);
  if (!io || userId === null || userId === undefined) return false;
  io.to(userRoom(t.id, userId)).emit(evento, data);
  return true;
}

/**
 * Corta todos los sockets de un tenant (al suspenderlo o darlo de baja).
 * Antes les avisa con 'tenant:estado' para que el front muestre el motivo.
 * El handshake rechaza la reconexión mientras no esté activo.
 * Devuelve cuántos sockets cortó (en esta instancia).
 */
async function disconnectTenant(tenantId, estado = 'suspendido') {
  if (!io) return 0;
  const room = tenantRoom(tenantId);
  const sockets = await io.in(room).fetchSockets();
  if (!sockets.length) return 0;
  io.to(room).emit('tenant:estado', {
    estado,
    mensaje: estado === 'suspendido' ? 'Cuenta suspendida, contactá a AutoAtento' : 'Cuenta dada de baja',
  });
  io.in(room).disconnectSockets(true);
  return sockets.length;
}

/**
 * Cada `ms` revisa el registro y corta los sockets de tenants que ya no
 * están activos. Cubre suspensiones hechas desde otra instancia o
 * directo en la base (el panel además corta en el momento).
 */
function startSuspensionWatcher(ms = 30 * 1000) {
  const registry = require('./registry');
  const timer = setInterval(async () => {
    if (!io) return;
    try {
      for (const t of await registry.listAll()) {
        if (t.estado === 'activo') continue;
        const n = await disconnectTenant(t.id, t.estado);
        if (n) console.log(`🔌 [${t.slug}] ${n} sockets desconectados (tenant ${t.estado})`);
      }
    } catch (e) {
      console.error('[realtime] vigilante de suspensiones:', e.message);
    }
  }, ms);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = {
  setIO, getIO, emitTenant, emitTenantUser, tenantRoom, userRoom,
  disconnectTenant, startSuspensionWatcher,
};
