#!/usr/bin/env node
/**
 * npm run migrate [-- opciones]
 *
 * Aplica las migraciones pendientes (migrations/NNN_*.sql) a los tenants
 * activos y reporta el resultado de cada uno. Un tenant que falla no frena
 * a los demás; el código de salida es 1 si alguno falló.
 *
 *   --tenant <slug>        solo ese tenant (repetible)
 *   --incluir-suspendidos  también los tenants suspendidos
 *   --dry-run              solo muestra qué se aplicaría
 *   --listar               lista las migraciones disponibles y sale
 */
require('../tenancy/env');
const { parseArgs } = require('util');
const { migrateTenants, listMigrations } = require('../tenancy/migrate');
const { closeControlPool } = require('../tenancy/control');

const { values: a } = parseArgs({
  options: {
    tenant: { type: 'string', multiple: true },
    'incluir-suspendidos': { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    listar: { type: 'boolean' },
  },
});

async function main() {
  if (a.listar) {
    for (const m of listMigrations()) console.log(`${m.version}  ${m.checksum.slice(0, 12)}`);
    return;
  }
  const reporte = await migrateTenants({
    slugs: a.tenant || null,
    incluirSuspendidos: !!a['incluir-suspendidos'],
    dryRun: !!a['dry-run'],
  });
  const fallidos = reporte.filter((r) => !r.ok);
  console.log(`\n${reporte.length - fallidos.length}/${reporte.length} tenants OK${a['dry-run'] ? ' (dry-run)' : ''}`);
  if (fallidos.length) {
    console.log(`Fallaron: ${fallidos.map((r) => r.slug).join(', ')}`);
    process.exitCode = 1;
  }
}

main()
  .catch((e) => { console.error('❌', e.message); process.exitCode = 1; })
  .finally(() => closeControlPool());
