// db.js — proxy multi-tenant.
//
// Misma interfaz que el pool de antes (execute, query, getConnection), así las
// rutas siguen con `require('../db')` sin cambios. Cada llamada va al pool del
// tenant del contexto actual (tenancy/context.js). Sin tenant en el contexto
// tira un error claro: NUNCA hay un pool por defecto.
const mysql = require('mysql2/promise');
const { requireTenant } = require('./tenancy/context');
const { getPool } = require('./tenancy/pools');

const current = (what) => getPool(requireTenant(`db.${what}()`));

const db = {
  async execute(...args) { return current('execute').execute(...args); },
  async query(...args) { return current('query').query(...args); },
  async getConnection() { return current('getConnection').getConnection(); },
  escape: (value) => mysql.escape(value),
  escapeId: (value) => mysql.escapeId(value),
  format: (sql, values) => mysql.format(sql, values),
  /** El pool real del tenant actual (para casos puntuales). */
  currentPool: () => current('currentPool'),
};

module.exports = db;
