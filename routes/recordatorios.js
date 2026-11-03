const router = require('express').Router();
const pool = require('../db');
const { authenticateToken } = require('../middleware/auth');
const { nowInTz } = require('../tenancy/time');

// ========================================
// RECORDATORIOS - Sistema de recordatorios con notificaciones
// ========================================

// GET recordatorios de un lead
router.get('/leads/:leadId/recordatorios', authenticateToken, async (req, res) => {
  try {
    const { leadId } = req.params;

    const [recordatorios] = await pool.execute(
      `SELECT r.*, u.name as creado_por_nombre
       FROM recordatorios r
       LEFT JOIN users u ON r.created_by = u.id
       WHERE r.lead_id = ?
       ORDER BY r.fecha ASC, r.hora ASC`,
      [leadId]
    );

    res.json({ ok: true, recordatorios });
  } catch (error) {
    console.error('Error GET /leads/:leadId/recordatorios:', error);
    res.status(500).json({ error: 'Error al obtener recordatorios' });
  }
});

// GET recordatorios pendientes del usuario
router.get('/recordatorios/pendientes', authenticateToken, async (req, res) => {
  try {
    // Obtener recordatorios donde el usuario es el creador o el vendedor asignado al lead
    const [recordatorios] = await pool.execute(
      `SELECT 
        r.*,
        l.nombre as lead_nombre,
        l.telefono as lead_telefono,
        l.modelo as lead_modelo,
        l.assigned_to as lead_vendedor,
        u.name as creado_por_nombre
       FROM recordatorios r
       INNER JOIN leads l ON r.lead_id = l.id
       LEFT JOIN users u ON r.created_by = u.id
       WHERE r.completado = FALSE
         AND (r.created_by = ? OR l.assigned_to = ?)
       ORDER BY r.fecha ASC, r.hora ASC`,
      [req.user.id, req.user.id]
    );

    res.json({ ok: true, recordatorios });
  } catch (error) {
    console.error('Error GET /recordatorios/pendientes:', error);
    res.status(500).json({ error: 'Error al obtener recordatorios pendientes' });
  }
});

// POST crear recordatorio
router.post('/recordatorios', authenticateToken, async (req, res) => {
  try {
    const { leadId, fecha, hora, descripcion } = req.body;

    // Validaciones
    if (!leadId || !fecha || !hora || !descripcion) {
      return res.status(400).json({ 
        error: 'Campos requeridos: leadId, fecha, hora, descripcion' 
      });
    }

    // Verificar que el lead existe
    const [leads] = await pool.execute('SELECT id FROM leads WHERE id = ?', [leadId]);
    if (leads.length === 0) {
      return res.status(404).json({ error: 'Lead no encontrado' });
    }

    const [result] = await pool.execute(
      `INSERT INTO recordatorios (lead_id, fecha, hora, descripcion, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [leadId, fecha, hora, descripcion, req.user.id]
    );

    const [nuevoRecordatorio] = await pool.execute(
      `SELECT r.*, u.name as creado_por_nombre
       FROM recordatorios r
       LEFT JOIN users u ON r.created_by = u.id
       WHERE r.id = ?`,
      [result.insertId]
    );

    console.log(`⏰ Recordatorio creado - Lead ${leadId}, Fecha: ${fecha} ${hora}`);

    // Opcional: Crear alerta
    try {
      await pool.execute(
        `INSERT INTO alertas (user_id, type, message, lead_id, related_id)
         VALUES (?, 'recordatorio', ?, ?, ?)`,
        [
          req.user.id,
          `Recordatorio creado para ${fecha} ${hora}: ${descripcion}`,
          leadId,
          result.insertId
        ]
      );
    } catch (alertError) {
      console.error('Error al crear alerta de recordatorio:', alertError);
      // No detener el proceso si falla la alerta
    }

    res.json({ ok: true, recordatorio: nuevoRecordatorio[0] });
  } catch (error) {
    console.error('Error POST /recordatorios:', error);
    res.status(500).json({ error: 'Error al crear recordatorio' });
  }
});

// PUT actualizar recordatorio (completar)
router.put('/recordatorios/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { completado } = req.body;

    // Verificar que el recordatorio existe
    const [recordatorios] = await pool.execute(
      'SELECT * FROM recordatorios WHERE id = ?',
      [id]
    );

    if (recordatorios.length === 0) {
      return res.status(404).json({ error: 'Recordatorio no encontrado' });
    }

    // completed_at con NOW() de MySQL (no la hora del proceso de Node)
    await pool.execute(
      `UPDATE recordatorios SET completado = ?, completed_at = ${completado ? 'NOW()' : 'NULL'} WHERE id = ?`,
      [completado, id]
    );

    const [recordatorioActualizado] = await pool.execute(
      `SELECT r.*, u.name as creado_por_nombre
       FROM recordatorios r
       LEFT JOIN users u ON r.created_by = u.id
       WHERE r.id = ?`,
      [id]
    );

    console.log(`✅ Recordatorio ${completado ? 'completado' : 'reabierto'} - ID ${id}`);

    res.json({ ok: true, recordatorio: recordatorioActualizado[0] });
  } catch (error) {
    console.error('Error PUT /recordatorios/:id:', error);
    res.status(500).json({ error: 'Error al actualizar recordatorio' });
  }
});

// DELETE eliminar recordatorio
router.delete('/recordatorios/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Verificar que el recordatorio existe
    const [recordatorios] = await pool.execute(
      'SELECT * FROM recordatorios WHERE id = ?',
      [id]
    );

    if (recordatorios.length === 0) {
      return res.status(404).json({ error: 'Recordatorio no encontrado' });
    }

    const recordatorio = recordatorios[0];

    // Solo el creador o admin pueden eliminar
    if (recordatorio.created_by !== req.user.id && !['owner', 'director'].includes(req.user.role)) {
      return res.status(403).json({ error: 'No tienes permiso para eliminar este recordatorio' });
    }

    await pool.execute('DELETE FROM recordatorios WHERE id = ?', [id]);

    console.log(`🗑️ Recordatorio eliminado - ID ${id}`);

    res.json({ ok: true, message: 'Recordatorio eliminado' });
  } catch (error) {
    console.error('Error DELETE /recordatorios/:id:', error);
    res.status(500).json({ error: 'Error al eliminar recordatorio' });
  }
});

// GET verificar recordatorios que deben notificarse
router.get('/recordatorios/verificar', authenticateToken, async (req, res) => {
  try {
    // fecha y hora de los recordatorios están en la hora local del tenant
    const ahora = nowInTz();

    const [recordatoriosPendientes] = await pool.execute(
      `SELECT 
        r.*,
        l.nombre as lead_nombre,
        l.telefono as lead_telefono,
        l.assigned_to as lead_vendedor
       FROM recordatorios r
       INNER JOIN leads l ON r.lead_id = l.id
       WHERE r.completado = FALSE
         AND TIMESTAMP(r.fecha, r.hora) <= ?
         AND (r.created_by = ? OR l.assigned_to = ?)`,
      [`${ahora.iso}:00`, req.user.id, req.user.id]
    );

    res.json({ ok: true, recordatorios: recordatoriosPendientes });
  } catch (error) {
    console.error('Error GET /recordatorios/verificar:', error);
    res.status(500).json({ error: 'Error al verificar recordatorios' });
  }
});

module.exports = router;
