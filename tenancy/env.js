/**
 * Variables de entorno de la capa multi-tenant.
 *
 * En desarrollo alcanza con DEV_MYSQL_URL: si CONTROL_DB_URL o
 * TENANT_DB_SERVER_URL están vacías, se arman a partir de ella
 * (mismo servidor, base autoatento_control / sin base).
 */
require('dotenv').config();

const CONTROL_DB_NAME = process.env.CONTROL_DB_NAME || 'autoatento_control';

/** Cambia (o saca) la base de una connection string mysql://... */
function withDatabase(url, database) {
  const u = new URL(url);
  u.pathname = database ? `/${encodeURIComponent(database)}` : '/';
  return u.toString();
}

function controlDbUrl() {
  if (process.env.CONTROL_DB_URL) return process.env.CONTROL_DB_URL;
  if (process.env.DEV_MYSQL_URL) return withDatabase(process.env.DEV_MYSQL_URL, CONTROL_DB_NAME);
  throw new Error('Falta CONTROL_DB_URL (o DEV_MYSQL_URL en desarrollo)');
}

/** Servidor MySQL donde se crean los schemas crm_<slug> de tenants nuevos. */
function tenantServerUrl() {
  if (process.env.TENANT_DB_SERVER_URL) return process.env.TENANT_DB_SERVER_URL;
  if (process.env.DEV_MYSQL_URL) return withDatabase(process.env.DEV_MYSQL_URL, null);
  throw new Error('Falta TENANT_DB_SERVER_URL (o DEV_MYSQL_URL en desarrollo)');
}

/**
 * Dominio base de los subdominios automáticos: con BASE_DOMAIN=autoatento.com.ar,
 * <slug>.autoatento.com.ar resuelve el tenant por slug sin cargarlo en "dominios".
 * Se normaliza: minúsculas, sin "*." ni puntos sobrantes ni esquema.
 */
const BASE_DOMAIN = String(process.env.BASE_DOMAIN || '').trim().toLowerCase()
  .replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^\*?\.+/, '').replace(/\.+$/, '');

const num = (v, def) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : def);

module.exports = {
  CONTROL_DB_NAME,
  withDatabase,
  controlDbUrl,
  tenantServerUrl,
  BASE_DOMAIN,
  TENANT_POOL_LIMIT: Math.max(1, num(process.env.TENANT_POOL_LIMIT, 2)),
  TENANT_POOL_IDLE_MS: num(process.env.TENANT_POOL_IDLE_MS, 30 * 60 * 1000),
  TENANT_CACHE_TTL_MS: num(process.env.TENANT_CACHE_TTL_MS, 30 * 1000),
};
