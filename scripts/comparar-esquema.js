#!/usr/bin/env node
/**
 * npm run comparar-esquema -- --clon <mysql://...> [--referencia <slug | mysql://...>] [--salida informe.md]
 *
 * Compara el esquema de la base de otro clon (GoldPlan, Peugeot, Pergamino,
 * ALRA, ...) contra una base de referencia de AutoAtento, para decidir qué
 * diferencias se convierten en migraciones y cuáles en módulos.
 *
 * SOLO LECTURA: abre las conexiones en modo READ ONLY y solo consulta
 * information_schema y algunos SELECT DISTINCT / COUNT. No escribe nada.
 *
 *   --clon         connection string de la base del clon (usar un usuario de solo lectura si se puede)
 *   --referencia   slug de un tenant de AutoAtento ya migrado (default: tenant-a) o connection string
 *   --salida       archivo .md donde guardar el informe (si no, va a la consola)
 */
require('../tenancy/env');
const fs = require('fs');
const { parseArgs } = require('util');
const mysql = require('mysql2/promise');
const registry = require('../tenancy/registry');
const { closeControlPool } = require('../tenancy/control');

const { values: a } = parseArgs({
  options: { clon: { type: 'string' }, referencia: { type: 'string' }, salida: { type: 'string' } },
});

/** Columnas con valores "de negocio" que conviene comparar (estados, fuentes, roles...). */
const VALORES = [
  ['leads', 'estado'], ['leads', 'fuente'], ['leads', 'marca'], ['leads', 'formaPago'],
  ['users', 'role'], ['wa_instances', 'default_fuente'],
];

async function conectar(url) {
  const c = await mysql.createConnection({ uri: url, timezone: 'Z' });
  await c.query('SET SESSION TRANSACTION READ ONLY');
  return c;
}

async function leerEsquema(c) {
  const [[{ db }]] = await c.query('SELECT DATABASE() AS db');
  const [tablas] = await c.query(
    "SELECT TABLE_NAME AS t, TABLE_ROWS AS filas FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'", [db]);
  const [cols] = await c.query(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_TYPE AS tipo, IS_NULLABLE AS nulo, COLUMN_DEFAULT AS def
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`, [db]);
  const [idx] = await c.query(
    `SELECT TABLE_NAME AS t, INDEX_NAME AS i, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols, MAX(NON_UNIQUE) AS no_unico
       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? GROUP BY TABLE_NAME, INDEX_NAME`, [db]);
  const [[ver]] = await c.query('SELECT VERSION() AS v');
  const esquema = { db, version: ver.v, tablas: new Map(), indices: new Map() };
  for (const t of tablas) esquema.tablas.set(t.t, { filas: Number(t.filas || 0), cols: new Map() });
  for (const col of cols) esquema.tablas.get(col.t)?.cols.set(col.c, col);
  for (const i of idx) esquema.indices.set(`${i.t}.${i.i}`, i);
  return esquema;
}

async function valoresDistintos(c, esquema) {
  const out = {};
  for (const [t, col] of VALORES) {
    if (!esquema.tablas.get(t)?.cols.has(col)) continue;
    const [rows] = await c.query(`SELECT \`${col}\` AS v, COUNT(*) AS n FROM \`${t}\` GROUP BY \`${col}\` ORDER BY n DESC LIMIT 50`);
    out[`${t}.${col}`] = rows.map((r) => `${r.v ?? 'NULL'} (${r.n})`);
  }
  return out;
}

const fmtCol = (c) => `${c.tipo}${c.nulo === 'NO' ? ' NOT NULL' : ''}${c.def !== null && c.def !== undefined ? ` DEFAULT ${c.def}` : ''}`;

function comparar(ref, clon) {
  const L = [];
  const soloClon = [...clon.tablas.keys()].filter((t) => !ref.tablas.has(t)).sort();
  const soloRef = [...ref.tablas.keys()].filter((t) => !clon.tablas.has(t)).sort();
  L.push(`## Tablas que solo tiene el clon (${soloClon.length})`, '');
  L.push(soloClon.length ? '→ funcionalidad propia del clon: ¿módulo nuevo + migración que la cree?' : '_ninguna_', '');
  for (const t of soloClon) L.push(`- \`${t}\` (~${clon.tablas.get(t).filas} filas): ${[...clon.tablas.get(t).cols.keys()].join(', ')}`);
  L.push('', `## Tablas que le faltan al clon (${soloRef.length})`, '');
  L.push(soloRef.length ? '→ las crean las migraciones de AutoAtento al registrar el clon (son CREATE TABLE IF NOT EXISTS)' : '_ninguna_', '');
  for (const t of soloRef) L.push(`- \`${t}\``);

  const colsClon = [];
  const colsRef = [];
  const tipos = [];
  for (const [t, info] of clon.tablas) {
    const r = ref.tablas.get(t);
    if (!r) continue;
    for (const [c, col] of info.cols) {
      if (!r.cols.has(c)) colsClon.push(`- \`${t}.${c}\` ${fmtCol(col)}`);
      else if (r.cols.get(c).tipo !== col.tipo) tipos.push(`- \`${t}.${c}\`: clon \`${col.tipo}\` · referencia \`${r.cols.get(c).tipo}\``);
    }
    for (const [c] of r.cols) if (!info.cols.has(c)) colsRef.push(`- \`${t}.${c}\` ${fmtCol(r.cols.get(c))}`);
  }
  L.push('', `## Columnas que solo tiene el clon (${colsClon.length})`, '');
  L.push(colsClon.length ? '→ migración aditiva en AutoAtento (todos los tenants) o módulo si es específica' : '_ninguna_', '', ...colsClon);
  L.push('', `## Columnas que le faltan al clon (${colsRef.length})`, '');
  L.push(colsRef.length ? '→ revisar que alguna migración las agregue antes de registrar el clon (si no, el CRM falla en esas rutas)' : '_ninguna_', '', ...colsRef);
  L.push('', `## Columnas con distinto tipo (${tipos.length})`, '');
  L.push(tipos.length ? '→ ENUM con valores distintos o tamaños distintos: decidir el tipo común y hacer una migración' : '_ninguna_', '', ...tipos);

  const idxClon = [...clon.indices.keys()].filter((k) => !ref.indices.has(k) && ref.tablas.has(k.split('.')[0]));
  L.push('', `## Índices que solo tiene el clon (${idxClon.length})`, '');
  L.push(idxClon.length ? '→ si son por performance, sumarlos con una migración' : '_ninguno_', '');
  for (const k of idxClon) L.push(`- \`${k}\` (${clon.indices.get(k).cols})`);
  return L;
}

async function main() {
  if (!a.clon) throw new Error('Falta --clon <mysql://...>');
  let refUrl = a.referencia || 'tenant-a';
  if (!/^mysql:\/\//.test(refUrl)) {
    const t = await registry.getBySlug(refUrl);
    if (!t) throw new Error(`No existe el tenant de referencia "${refUrl}"`);
    refUrl = registry.dbUrlOf(t);
  }
  const cRef = await conectar(refUrl);
  const cClon = await conectar(a.clon);
  try {
    const ref = await leerEsquema(cRef);
    const clon = await leerEsquema(cClon);
    const valores = await valoresDistintos(cClon, clon);
    const L = [
      `# Comparación de esquema: ${clon.db} (clon) vs ${ref.db} (referencia)`, '',
      `- Clon: MySQL ${clon.version}, ${clon.tablas.size} tablas`,
      `- Referencia: MySQL ${ref.version}, ${ref.tablas.size} tablas`,
      `- Generado: ${new Date().toISOString()} (solo lectura)`, '',
      ...comparar(ref, clon),
      '', '## Valores en uso en el clon (para estados, fuentes, marcas y roles)', '',
      '→ estados o fuentes que el CRM base no conoce: agregarlos (configurable o módulo); marcas: cargar `config.marcas`', '',
    ];
    for (const [k, vals] of Object.entries(valores)) L.push(`- \`${k}\`: ${vals.join(', ') || '—'}`);
    L.push('', '## Volumen (filas aproximadas, tablas principales)', '');
    for (const t of ['leads', 'users', 'lead_history', 'notas_internas', 'wa_messages', 'alertas', 'recordatorios']) {
      if (clon.tablas.has(t)) L.push(`- \`${t}\`: ~${clon.tablas.get(t).filas}`);
    }
    const informe = L.join('\n') + '\n';
    if (a.salida) {
      fs.writeFileSync(a.salida, informe);
      console.log(`✅ Informe guardado en ${a.salida}`);
    } else {
      console.log(informe);
    }
  } finally {
    await cRef.end();
    await cClon.end();
  }
}

main()
  .catch((e) => { console.error('❌', e.message); process.exitCode = 1; })
  .finally(() => closeControlPool());
