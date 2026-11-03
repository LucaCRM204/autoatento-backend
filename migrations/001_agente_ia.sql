-- ============================================
-- MIGRACIÓN 001 — Tablas del Agente IA
-- Antes las creaba agent/schema.js en cada arranque. Mismas definiciones,
-- con IF NOT EXISTS: en bases que ya las tienen (Fiat) no cambia nada.
-- ============================================

CREATE TABLE IF NOT EXISTS agent_config (
  k VARCHAR(60) NOT NULL PRIMARY KEY,
  v TEXT NULL,
  updated_by INT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS agent_events (
  id INT AUTO_INCREMENT PRIMARY KEY,
  type VARCHAR(40) NOT NULL,
  lead_id INT NULL,
  payload TEXT NULL,
  dedupe_key VARCHAR(120) NOT NULL,
  status ENUM('pending','processing','done','error','skipped') DEFAULT 'pending',
  attempts INT DEFAULT 0,
  next_attempt_at DATETIME NULL,
  error TEXT NULL,
  run_id INT NULL,
  created_by INT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  processed_at DATETIME NULL,
  UNIQUE KEY uq_agent_event_dedupe (dedupe_key),
  INDEX idx_agent_events_status (status, next_attempt_at),
  INDEX idx_agent_events_lead (lead_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS agent_runs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  event_id INT NULL,
  lead_id INT NULL,
  trigger_type VARCHAR(40) NULL,
  model VARCHAR(60) NULL,
  status ENUM('running','done','error') DEFAULT 'running',
  steps INT DEFAULT 0,
  input_tokens INT DEFAULT 0,
  output_tokens INT DEFAULT 0,
  summary TEXT NULL,
  transcript MEDIUMTEXT NULL,
  error TEXT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME NULL,
  INDEX idx_agent_runs_lead (lead_id),
  INDEX idx_agent_runs_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS agent_actions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  run_id INT NULL,
  event_id INT NULL,
  lead_id INT NULL,
  tool VARCHAR(60) NOT NULL,
  args TEXT NULL,
  reason TEXT NULL,
  status ENUM('executed','pending','approved','rejected','failed') NOT NULL,
  result TEXT NULL,
  source ENUM('agent','mcp') DEFAULT 'agent',
  decided_by INT NULL,
  decided_at DATETIME NULL,
  decision_note VARCHAR(255) NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  executed_at DATETIME NULL,
  INDEX idx_agent_actions_status (status, created_at),
  INDEX idx_agent_actions_lead (lead_id),
  INDEX idx_agent_actions_run (run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
