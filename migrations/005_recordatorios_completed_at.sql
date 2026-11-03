-- ============================================
-- MIGRACIÓN 005 — recordatorios.completed_at
-- routes/recordatorios.js la usa al marcar un recordatorio como completado,
-- pero el esquema base no la tenía (en una base nueva el PUT fallaba con
-- "Unknown column"). Solo se agrega si no existe.
-- ============================================

SET @existe := (SELECT COUNT(*) FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'recordatorios' AND COLUMN_NAME = 'completed_at');
SET @sql := IF(@existe = 0,
  'ALTER TABLE recordatorios ADD COLUMN completed_at DATETIME NULL AFTER completado',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
