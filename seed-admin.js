// seed-admin.js
// Crea (o resetea la contraseña de) un usuario owner en la base de UN tenant.
// Uso:
//   SEED_ADMIN_EMAIL=admin@cliente.com SEED_ADMIN_PASSWORD=algo_seguro npm run seed:admin -- --tenant <slug>
//
// Lee la connection string del tenant desde autoatento_control (cifrada).
// No hay credenciales hardcodeadas acá.

const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const { parseArgs } = require('util');
require('./tenancy/env');
const registry = require('./tenancy/registry');
const { closeControlPool } = require('./tenancy/control');

(async () => {
  const { values } = parseArgs({ options: { tenant: { type: 'string' } } });
  const slug = values.tenant || process.env.SEED_TENANT;
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  const name = process.env.SEED_ADMIN_NAME || 'Owner';

  if (!slug) throw new Error('Falta --tenant <slug>');
  if (!email || !password) {
    throw new Error('Faltan SEED_ADMIN_EMAIL y SEED_ADMIN_PASSWORD. Ejemplo: SEED_ADMIN_EMAIL=a@b.com SEED_ADMIN_PASSWORD=algo_seguro npm run seed:admin -- --tenant mi-cliente');
  }

  const tenant = await registry.getBySlug(slug);
  if (!tenant) throw new Error(`No existe el tenant "${slug}"`);

  const conn = await mysql.createConnection({ uri: registry.dbUrlOf(tenant) });
  try {
    const hash = await bcrypt.hash(password, 10);
    const [existing] = await conn.execute('SELECT id FROM users WHERE email = ?', [email]);

    if (existing.length > 0) {
      await conn.execute('UPDATE users SET password = ?, updated_at = NOW() WHERE email = ?', [hash, email]);
      console.log(`✅ [${slug}] Contraseña actualizada para ${email}`);
    } else {
      await conn.execute(
        "INSERT INTO users (name, email, password, role, active) VALUES (?, ?, ?, 'owner', 1)",
        [name, email, hash]
      );
      console.log(`✅ [${slug}] Usuario owner creado: ${email}`);
    }
  } finally {
    await conn.end();
  }
})()
  .catch((e) => {
    console.error('❌', e.message);
    process.exitCode = 1;
  })
  .finally(() => closeControlPool());
