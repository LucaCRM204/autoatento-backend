-- ============================================
-- MIGRACIÓN 002 — wa_messages.sent_by (bot / vendedor / agente / cliente)
-- Antes la agregaba agent/schema.js al arrancar (y también el bot de
-- WhatsApp actualizado). Solo se agrega si no existe.
-- Patrón compatible MySQL 8 / MariaDB: chequeo en information_schema +
-- PREPARE (sin ADD COLUMN IF NOT EXISTS).
-- ============================================

SET @existe := (SELECT COUNT(*) FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'wa_messages' AND COLUMN_NAME = 'sent_by');
SET @sql := IF(@existe = 0,
  'ALTER TABLE wa_messages ADD COLUMN sent_by VARCHAR(20) NULL AFTER direction',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
