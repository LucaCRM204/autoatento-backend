-- ============================================
-- MIGRACIÓN 003 — leads.marca: ENUM('fiat') -> VARCHAR(30)
-- Para multi_marca / motos y para clones con otras marcas. Los valores
-- existentes se conservan (el texto del ENUM pasa tal cual). Sin default:
-- la marca la pone el backend (tenants.config.marcas / marca_default).
-- Solo se aplica si la columna sigue siendo ENUM (idempotente).
-- OJO: en MySQL cambiar el tipo reconstruye la tabla (copia de leads);
-- en bases grandes correrlo fuera de horario.
-- ============================================

SET @tipo := (SELECT DATA_TYPE FROM information_schema.COLUMNS
               WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leads' AND COLUMN_NAME = 'marca');
SET @sql := IF(@tipo = 'enum',
  'ALTER TABLE leads MODIFY COLUMN marca VARCHAR(30) NULL DEFAULT NULL',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
