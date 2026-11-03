/**
 * Conexión a la base de control (autoatento_control): tenants, superadmins,
 * uso mensual y auditoría. Es la ÚNICA base que no depende del tenant.
 */
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const env = require('./env');

let pool = null;

function getControlPool() {
  if (!pool) {
    pool = mysql.createPool({
      uri: env.controlDbUrl(),
      waitForConnections: true,
      connectionLimit: Number(process.env.CONTROL_POOL_LIMIT) || 5,
      queueLimit: 0,
      enableKeepAlive: true,
    });
  }
  return pool;
}

/** Corre control/schema.sql (idempotente). La base tiene que existir. */
async function ensureControlSchema() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'control', 'schema.sql'), 'utf8');
  const conn = await mysql.createConnection({ uri: env.controlDbUrl(), multipleStatements: true });
  try {
    await conn.query(sql);
  } finally {
    await conn.end().catch(() => {});
  }
}

/** Crea la base de control si no existe (necesita permisos de CREATE en el servidor). */
async function createControlDatabase() {
  const url = new URL(env.controlDbUrl());
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, '')) || env.CONTROL_DB_NAME;
  const conn = await mysql.createConnection({ uri: env.withDatabase(url.toString(), null) });
  try {
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName.replace(/`/g, '')}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  } finally {
    await conn.end().catch(() => {});
  }
  return dbName;
}

async function closeControlPool() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end().catch(() => {});
  }
}

module.exports = { getControlPool, ensureControlSchema, createControlDatabase, closeControlPool };
