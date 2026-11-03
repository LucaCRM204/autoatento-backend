#!/usr/bin/env node
/**
 * Crea un usuario del panel superadmin o le cambia la contraseña.
 *
 *   SUPERADMIN_PASSWORD='...' npm run superadmin:add -- --email vos@autoatento.com [--nombre "Luca"]
 *   npm run superadmin:add -- --email vos@autoatento.com --desactivar
 *
 * La contraseña va por variable de entorno (no por argumento) para que no
 * quede en el historial de la terminal. Mínimo 12 caracteres.
 */
require('../tenancy/env');
const { parseArgs } = require('util');
const bcrypt = require('bcrypt');
const { ensureControlSchema, getControlPool, closeControlPool } = require('../tenancy/control');

const { values: a } = parseArgs({
  options: { email: { type: 'string' }, nombre: { type: 'string' }, desactivar: { type: 'boolean' } },
});

async function main() {
  const email = String(a.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Falta --email válido');
  await ensureControlSchema();
  const pool = getControlPool();

  if (a.desactivar) {
    const [r] = await pool.execute('UPDATE superadmins SET activo = 0 WHERE email = ?', [email]);
    console.log(r.affectedRows ? `✅ ${email} desactivado` : `⚠️  ${email} no existe`);
    return;
  }

  const password = process.env.SUPERADMIN_PASSWORD;
  if (!password || password.length < 12) throw new Error('Pasá la contraseña en SUPERADMIN_PASSWORD (mínimo 12 caracteres)');
  const hash = await bcrypt.hash(password, 12);
  const [r] = await pool.execute(
    `INSERT INTO superadmins (email, password, nombre, activo) VALUES (?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE password = VALUES(password), activo = 1, nombre = COALESCE(VALUES(nombre), nombre)`,
    [email, hash, a.nombre || null]);
  console.log(r.affectedRows === 1 ? `✅ Superadmin creado: ${email}` : `✅ Contraseña actualizada: ${email}`);
}

main()
  .catch((e) => { console.error('❌', e.message); process.exitCode = 1; })
  .finally(() => closeControlPool());
