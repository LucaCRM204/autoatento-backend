/**
 * ============================================
 * AGENTE IA — SCHEMA
 * ============================================
 * Verifica que estén las tablas del agente (las crean las migraciones) y
 * crea el usuario de sistema "Agente IA" con el que se firman notas, recordatorios
 * e historial. Ese usuario queda con active = 0: no puede loguearse y no
 * entra en ningún reparto de leads.
 */
const crypto = require('crypto');
const bcrypt = require('bcrypt');

const AGENT_EMAIL = 'agente-ia@sistema.local';
const AGENT_NAME = 'Agente IA';

// Las tablas (agent_config, agent_events, agent_runs, agent_actions) y la
// columna wa_messages.sent_by ahora vienen de migrations/001 y 002.
const TABLAS = ['agent_config', 'agent_events', 'agent_runs', 'agent_actions'];

async function ensureSchema(pool) {
  const [t] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)`, [TABLAS]);
  if (Number(t[0].n) < TABLAS.length) {
    throw new Error('faltan las tablas del agente: corré las migraciones (npm run migrate)');
  }

  const [rows] = await pool.execute('SELECT id FROM users WHERE email = ? LIMIT 1', [AGENT_EMAIL]);
  if (rows.length) return { id: rows[0].id, name: AGENT_NAME };

  // Password aleatoria que nadie conoce: el usuario existe solo para firmar.
  const hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
  const [r] = await pool.execute(
    "INSERT INTO users (name, email, password, role, active, lead_percentage) VALUES (?, ?, ?, 'supervisor', 0, 0)",
    [AGENT_NAME, AGENT_EMAIL, hash]
  );
  console.log(`🤖 Usuario de sistema creado: ${AGENT_NAME} (#${r.insertId})`);
  return { id: r.insertId, name: AGENT_NAME };
}

module.exports = { ensureSchema, AGENT_EMAIL, AGENT_NAME };
