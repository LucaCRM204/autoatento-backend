-- ============================================
-- AUTOATENTO — Base de control (autoatento_control)
-- ============================================
-- Una sola por instalación. Guarda los tenants (clientes), los usuarios del
-- panel superadmin, el uso mensual para facturar y el log de auditoría.
-- Idempotente: se puede correr en cada arranque. Compatible MySQL 8 y MariaDB.
-- Las columnas JSON en MariaDB son LONGTEXT con CHECK: el código parsea
-- los dos casos (objeto o string).

CREATE TABLE IF NOT EXISTS tenants (
  id INT AUTO_INCREMENT PRIMARY KEY,
  slug VARCHAR(60) NOT NULL,
  nombre VARCHAR(150) NOT NULL,
  estado ENUM('activo','suspendido','baja') NOT NULL DEFAULT 'activo',
  plan ENUM('esencial','pro','arm') NOT NULL DEFAULT 'esencial',
  db_url_cifrada TEXT NOT NULL,          -- AES-256-GCM con TENANT_DB_KEY
  dominios JSON NULL,                    -- ["crm5alluma.com.ar"]
  modulos JSON NULL,                     -- {"agente_ia": true, ...}
  branding JSON NULL,                    -- {"nombre": "...", "logo_url": "...", "color_primario": "#..."}
  config JSON NULL,                      -- {"wa_bot_url": "...", "wa_bot_key": "v1:...", "timezone": "...", ...}
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tenants_slug (slug),
  INDEX idx_tenants_estado (estado)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS superadmins (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(120) NOT NULL,
  password VARCHAR(255) NOT NULL,        -- bcrypt
  nombre VARCHAR(100) NULL,
  activo TINYINT(1) NOT NULL DEFAULT 1,
  last_login_at DATETIME NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_superadmins_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS uso_mensual (
  tenant_id INT NOT NULL,
  mes CHAR(7) NOT NULL,                  -- 'YYYY-MM'
  usuarios_activos INT NOT NULL DEFAULT 0,
  leads_ingresados INT NOT NULL DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, mes),
  CONSTRAINT fk_uso_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Acciones de superadmins (alta/edición/suspensión de tenants, "entrar como owner").
CREATE TABLE IF NOT EXISTS audit_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  actor_tipo ENUM('superadmin','sistema') NOT NULL DEFAULT 'superadmin',
  actor_id INT NULL,
  actor_email VARCHAR(120) NULL,
  tenant_id INT NULL,
  accion VARCHAR(60) NOT NULL,
  detalle JSON NULL,
  ip VARCHAR(64) NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_audit_tenant (tenant_id, created_at),
  INDEX idx_audit_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
