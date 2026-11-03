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

module.exports = { setIO, getIO, emitTenant, emitTenantUser, tenantRoom, userRoom };
