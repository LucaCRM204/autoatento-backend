/**
 * Runner de migraciones por tenant.
 *
 * - Archivos: migrations/NNN_descripcion.sql, en orden. 000_baseline = el
 *   database.sql original.
 * - Cada base de tenant tiene su tabla schema_migrations (version, checksum,
 *   applied_at, duration_ms).
 * - Idempotente: lo aplicado no se vuelve a correr, y cada archivo está
 *   escrito para poder re-ejecutarse (IF NOT EXISTS / chequeos contra
 *   information_schema) por si una corrida se corta a la mitad (el DDL de
 *   MySQL no es transaccional).
 * - Un tenant que falla no frena a los demás: el reporte dice qué pasó en cada uno.
 * - GET_LOCK por base: dos instancias no migran el mismo tenant a la vez.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const registry = require('./registry');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const FILE_RE = /^(\d{3})_([a-z0-9_]+)\.sql$/;

function listMigrations(dir = MIGRATIONS_DIR) {
  const files = fs.readdirSync(dir).filter((f) => FILE_RE.test(f)).sort();
  const vistos = new Set();
  return files.map((file) => {
    const [, num] = file.match(FILE_RE);
    if (vistos.has(num)) throw new Error(`Hay dos migraciones con el número ${num}`);
    vistos.add(num);
    // Checksum sobre el texto con fin de línea normalizado (Windows/Linux dan lo mismo)
    const sql = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n');
    return {
      version: file.replace(/\.sql$/, ''),
      file,
      sql,
      checksum: crypto.createHash('sha256').update(sql).digest('hex'),
    };
  });
}

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(100) NOT NULL PRIMARY KEY,
  checksum CHAR(64) NOT NULL,
  applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  duration_ms INT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

/**
 * Migra una base. Devuelve { aplicadas, pendientes, modificadas, total }.
 * Tira error si falla una migración (las anteriores quedan registradas).
 */
async function migrateDatabase(dbUrl, { dryRun = false, migrations = listMigrations() } = {}) {
  const conn = await mysql.createConnection({ uri: dbUrl, multipleStatements: true });
  let lockName = null;
  try {
    const [[{ db }]] = await conn.query('SELECT DATABASE() AS db');
    if (!db) throw new Error('La connection string no tiene base (falta /<base> al final)');
    lockName = `aa_migrate:${db}`.slice(0, 64);
    const [[{ ok }]] = await conn.query('SELECT GET_LOCK(?, 60) AS ok', [lockName]);
    if (ok !== 1) { lockName = null; throw new Error('Otra instancia está migrando esta base (lock ocupado)'); }

    await conn.query(CREATE_TABLE);
    const [rows] = await conn.query('SELECT version, checksum FROM schema_migrations');
    const aplicadasAntes = new Map(rows.map((r) => [r.version, r.checksum]));

    const modificadas = migrations
      .filter((m) => aplicadasAntes.has(m.version) && aplicadasAntes.get(m.version) !== m.checksum)
      .map((m) => m.version);
    const pendientes = migrations.filter((m) => !aplicadasAntes.has(m.version));

    const aplicadas = [];
    if (!dryRun) {
      for (const m of pendientes) {
        const t0 = Date.now();
        try {
          await conn.query(m.sql);
        } catch (e) {
          const err = new Error(`${m.file}: ${e.message}`);
          err.aplicadas = aplicadas;
          throw err;
        }
        await conn.execute(
          'INSERT INTO schema_migrations (version, checksum, duration_ms) VALUES (?, ?, ?)',
          [m.version, m.checksum, Date.now() - t0]);
        aplicadas.push(m.version);
      }
    }
    return {
      aplicadas,
      pendientes: dryRun ? pendientes.map((m) => m.version) : [],
      modificadas,
      total: migrations.length,
    };
  } finally {
    if (lockName) await conn.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => {});
    await conn.end().catch(() => {});
  }
}

/**
 * Migra varios tenants. Nunca tira: devuelve un reporte por tenant.
 * @param {{ slugs?: string[], incluirSuspendidos?: boolean, dryRun?: boolean, log?: boolean }} opts
 */
async function migrateTenants({ slugs = null, incluirSuspendidos = false, dryRun = false, log = true } = {}) {
  registry.invalidate();
  let tenants = (await registry.listAll()).filter((t) =>
    t.estado === 'activo' || (incluirSuspendidos && t.estado === 'suspendido'));
  if (slugs?.length) {
    const faltan = slugs.filter((s) => !tenants.some((t) => t.slug === s));
    tenants = tenants.filter((t) => slugs.includes(t.slug));
    for (const s of faltan) if (log) console.warn(`⚠️  [migrate] "${s}" no existe o no está activo`);
  }

  const migrations = listMigrations();
  const reporte = [];
  for (const t of tenants) {
    const t0 = Date.now();
    try {
      const r = await migrateDatabase(registry.dbUrlOf(t), { dryRun, migrations });
      reporte.push({ slug: t.slug, ok: true, ...r, ms: Date.now() - t0 });
      if (log) {
        const que = dryRun
          ? (r.pendientes.length ? `pendientes: ${r.pendientes.join(', ')}` : 'al día')
          : (r.aplicadas.length ? `aplicadas: ${r.aplicadas.join(', ')}` : 'al día');
        console.log(`✅ [migrate][${t.slug}] ${que}${r.modificadas.length ? ` · ⚠️ modificadas después de aplicadas: ${r.modificadas.join(', ')}` : ''}`);
      }
    } catch (e) {
      reporte.push({ slug: t.slug, ok: false, error: e.message, aplicadas: e.aplicadas || [], ms: Date.now() - t0 });
      if (log) console.error(`❌ [migrate][${t.slug}] ${e.message}`);
    }
  }
  return reporte;
}

module.exports = { listMigrations, migrateDatabase, migrateTenants, MIGRATIONS_DIR };
