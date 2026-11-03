/** Log de auditoría de acciones del panel superadmin (autoatento_control.audit_log). */
const { getControlPool } = require('../tenancy/control');

async function auditar(req, accion, tenantId = null, detalle = null) {
  try {
    await getControlPool().execute(
      `INSERT INTO audit_log (actor_tipo, actor_id, actor_email, tenant_id, accion, detalle, ip)
       VALUES ('superadmin', ?, ?, ?, ?, ?, ?)`,
      [req.superadmin?.id || null, req.superadmin?.email || null, tenantId, accion,
        detalle ? JSON.stringify(detalle) : null, String(req.ip || '').slice(0, 64)]);
  } catch (e) {
    // La auditoría no puede perderse en silencio, pero tampoco tirar la acción ya hecha.
    console.error(`[auditoria] no se pudo registrar "${accion}":`, e.message);
  }
}

module.exports = { auditar };
