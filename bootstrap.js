// bootstrap.js — se ejecuta al arrancar el server.
//
// Multi-tenant: ya NO corre database.sql ni crea el owner (no hay una base
// única). Solo asegura el esquema de la base de control (autoatento_control).
//  - Los schemas de los tenants se crean con `npm run tenant:add` (y en la
//    Fase 2 desde el panel superadmin + migraciones).
//  - El owner de cada tenant se crea al darlo de alta.
const { ensureControlSchema } = require('./tenancy/control');

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
  }
}

module.exports = bootstrap;
