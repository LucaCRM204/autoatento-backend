/**
 * Cifrado de secretos de tenants (connection strings, keys del bot, API keys).
 * AES-256-GCM con TENANT_DB_KEY (32 bytes, en hex de 64 caracteres o base64).
 *
 * Formato guardado:  v1:<iv base64>:<tag base64>:<datos base64>
 *
 * Rotación (ver scripts/rotate-key.js y MULTITENANT.md): mientras exista
 * TENANT_DB_KEY_ANTERIOR, decrypt() prueba primero con TENANT_DB_KEY y si
 * falla con la anterior. encrypt() usa siempre TENANT_DB_KEY.
 */
const crypto = require('crypto');

const PREFIX = 'v1';
const cache = new Map();

/** Convierte el texto de una key (hex de 64 o base64) en 32 bytes. */
function parseKey(raw, nombre = 'la key') {
  const s = String(raw || '').trim();
  if (!s) throw new Error(`Falta ${nombre} (32 bytes en hex o base64)`);
  const buf = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64');
  if (buf.length !== 32) throw new Error(`${nombre} tiene que ser de 32 bytes (64 caracteres hex o base64)`);
  return buf;
}

function envKey(variable) {
  const raw = process.env[variable];
  if (!raw) return null;
  if (!cache.has(variable) || cache.get(variable).raw !== raw) cache.set(variable, { raw, buf: parseKey(raw, variable) });
  return cache.get(variable).buf;
}

function getKey() {
  const k = envKey('TENANT_DB_KEY');
  if (!k) throw new Error('Falta TENANT_DB_KEY (32 bytes en hex o base64)');
  return k;
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(`${PREFIX}:`) && value.split(':').length === 4;
}

function encryptWith(key, plain) {
  if (plain === null || plain === undefined) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [PREFIX, iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

/** Descifra con una key puntual. Tira si la key no corresponde (falla el tag de GCM). */
function decryptWith(key, value) {
  if (value === null || value === undefined || value === '') return null;
  if (!isEncrypted(value)) throw new Error('Valor cifrado con formato inválido');
  const [, iv, tag, data] = value.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

const encrypt = (plain) => encryptWith(getKey(), plain);

function decrypt(value) {
  try {
    return decryptWith(getKey(), value);
  } catch (e) {
    const anterior = envKey('TENANT_DB_KEY_ANTERIOR');
    if (!anterior || !isEncrypted(value)) throw e;
    return decryptWith(anterior, value);
  }
}

/** Para objetos (ej. el mapa de API keys de webhooks). */
const encryptJSON = (obj) => encrypt(JSON.stringify(obj));
const decryptJSON = (value) => {
  const s = decrypt(value);
  return s ? JSON.parse(s) : null;
};

module.exports = { encrypt, decrypt, encryptJSON, decryptJSON, isEncrypted, encryptWith, decryptWith, parseKey };
