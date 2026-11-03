// bootstrap.js — se ejecuta al arrancar el server.
//
// Multi-tenant: ya NO corre database.sql ni crea el owner (no hay una base
// única). Hace dos cosas:
//  1. Asegura el esquema de la base de control (autoatento_control).
//  2. Si AUTO_MIGRATE=1, aplica las migraciones pendientes a todos los
//     tenants activos. Un tenant que falla no frena el arranque ni a los demás.
// Los tenants nuevos se crean desde el panel superadmin o con `npm run tenant:add`
// (schema + migraciones + owner).
const { ensureControlSchema } = require('./tenancy/control');
const { migrateTenants } = require('./tenancy/migrate');

async function bootstrap() {
  try {
    await ensureControlSchema();
    console.log('🗄️  Base de control OK');
  } catch (e) {
    if (e.code === 'ER_BAD_DB_ERROR') {
      console.error('❌ Bootstrap: la base de control no existe. Corré `npm run control:init`.');
    } else {
      console.error('❌ Bootstrap (base de control):', e.message);
    }
    return;
  }

  if (process.env.AUTO_MIGRATE === '1') {
    try {
      const reporte = await migrateTenants();
      const fallidos = reporte.filter((r) => !r.ok);
      console.log(`🗄️  AUTO_MIGRATE: ${reporte.length - fallidos.length}/${reporte.length} tenants al día${fallidos.length ? ` · fallaron: ${fallidos.map((r) => r.slug).join(', ')}` : ''}`);
    } catch (e) {
      console.error('❌ AUTO_MIGRATE:', e.message);
    }
  }
}

module.exports = bootstrap;
