#!/usr/bin/env node
/**
 * npm run rotate-key [-- --dry-run]
 *
 * Re-cifra todos los secretos de autoatento_control.tenants (db_url_cifrada y
 * las claves secretas de config) con una key nueva.
 *
 *   key vieja = TENANT_DB_KEY_ANTERIOR
 *   key nueva = TENANT_DB_KEY
 *
 * Todo en UNA transacción con las filas bloqueadas (SELECT ... FOR UPDATE):
 * o se rota todo, o no cambia nada. Antes de confirmar verifica que cada
 * valor nuevo se descifre con la key nueva y dé exactamente lo mismo.
 * Idempotente: lo que ya está cifrado con la key nueva se deja como está.
 *
 * Procedimiento sin corte (ver "Backup de secretos" en MULTITENANT.md):
 *   1. Generar la key nueva y guardarla en el gestor de contraseñas.
 *   2. Deploy con TENANT_DB_KEY=<nueva> y TENANT_DB_KEY_ANTERIOR=<vieja>
 *      (el backend descifra con las dos y cifra con la nueva).
 *   3. npm run rotate-key -- --dry-run   y después   npm run rotate-key
 *   4. Sacar TENANT_DB_KEY_ANTERIOR del deploy.
 */
require('../tenancy/env');
const { parseArgs } = require('util');
const { getControlPool, closeControlPool } = require('../tenancy/control');
const { encryptWith, decryptWith, isEncrypted, parseKey } = require('../tenancy/crypto');
const { SECRET_KEYS } = require('../tenancy/registry');

const { values: a } = parseArgs({ options: { 'dry-run': { type: 'boolean' } } });

const parseJSON = (v) => (v == null ? {} : typeof v === 'object' ? v : JSON.parse(v));

async function main() {
  const nueva = parseKey(process.env.TENANT_DB_KEY, 'TENANT_DB_KEY (la key nueva)');
  const vieja = parseKey(process.env.TENANT_DB_KEY_ANTERIOR, 'TENANT_DB_KEY_ANTERIOR (la key vieja)');
  if (nueva.equals(vieja)) throw new Error('TENANT_DB_KEY y TENANT_DB_KEY_ANTERIOR son iguales: no hay nada que rotar');

  /** Devuelve { valor, estado: 'rotado' | 'ya-nueva' } o tira si no se descifra con ninguna. */
  function rotar(valor, donde) {
    try {
      decryptWith(nueva, valor);
      return { valor, estado: 'ya-nueva' };
    } catch { /* sigue con la vieja */ }
    let plano;
    try {
      plano = decryptWith(vieja, valor);
    } catch {
      throw new Error(`${donde}: no se descifra ni con la key nueva ni con la vieja`);
    }
    const nuevoValor = encryptWith(nueva, plano);
    if (decryptWith(nueva, nuevoValor) !== plano) throw new Error(`${donde}: la verificación del re-cifrado falló`);
    return { valor: nuevoValor, estado: 'rotado' };
  }

  const conn = await getControlPool().getConnection();
  const resumen = { tenants: 0, rotados: 0, yaNueva: 0 };
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT id, slug, db_url_cifrada, config FROM tenants ORDER BY id FOR UPDATE');
    const cambios = [];
    for (const row of rows) {
      resumen.tenants++;
      const r = rotar(row.db_url_cifrada, `${row.slug}.db_url`);
      const config = parseJSON(row.config);
      const detalle = [`db_url:${r.estado}`];
      let tocado = r.estado === 'rotado';
      r.estado === 'rotado' ? resumen.rotados++ : resumen.yaNueva++;
      for (const k of SECRET_KEYS) {
        if (!isEncrypted(config[k])) continue;
        const rc = rotar(config[k], `${row.slug}.config.${k}`);
        config[k] = rc.valor;
        detalle.push(`${k}:${rc.estado}`);
        if (rc.estado === 'rotado') { tocado = true; resumen.rotados++; } else resumen.yaNueva++;
      }
      console.log(`${tocado ? '🔁' : '✔️ '} ${row.slug}: ${detalle.join(', ')}`);
      if (tocado) cambios.push([r.valor, JSON.stringify(config), row.id]);
    }

    if (a['dry-run']) {
      await conn.rollback();
      console.log(`\n(dry-run) ${resumen.tenants} tenants: ${resumen.rotados} secretos se rotarían, ${resumen.yaNueva} ya estaban con la key nueva. No se cambió nada.`);
      return;
    }
    for (const [db, config, id] of cambios) {
      await conn.execute('UPDATE tenants SET db_url_cifrada = ?, config = ? WHERE id = ?', [db, config, id]);
    }
    await conn.commit();
    console.log(`\n✅ ${resumen.tenants} tenants: ${resumen.rotados} secretos rotados, ${resumen.yaNueva} ya estaban con la key nueva.`);
    console.log('Ahora podés sacar TENANT_DB_KEY_ANTERIOR del deploy.');
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

main()
  .catch((e) => { console.error('❌', e.message, '\n(no se cambió nada)'); process.exitCode = 1; })
  .finally(() => closeControlPool());
