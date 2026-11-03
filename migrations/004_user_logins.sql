-- ============================================
-- MIGRACIÓN 004 — user_logins
-- Un registro por login exitoso. Junto con user_sessions (conexiones del
-- socket) define los "usuarios activos del mes" para facturar.
-- Sin FK a users para no frenar logins si algo raro pasa con la tabla.
-- ============================================

CREATE TABLE IF NOT EXISTS user_logins (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  ip VARCHAR(64) NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_logins_created (created_at),
  INDEX idx_user_logins_user (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
