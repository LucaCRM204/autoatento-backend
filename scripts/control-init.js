#!/usr/bin/env node
/**
 * npm run control:init
 * Crea la base de control (si no existe) y sus tablas. Idempotente.
 */
require('../tenancy/env');
const { createControlDatabase, ensureControlSchema, getControlPool, closeControlPool } = require('../tenancy/control');

async function main() {
  const nombre = await createControlDatabase();
  await ensureControlSchema();
  const [tablas] = await getControlPool().query('SHOW TABLES');
  const [[{ n }]] = await getControlPool().query('SELECT COUNT(*) AS n FROM tenants');
  console.log(`✅ Base de control "${nombre}" lista: ${tablas.length} tablas, ${n} tenants`);
}

main()
  .catch((e) => { console.error('❌', e.message); process.exitCode = 1; })
  .finally(() => closeControlPool());
