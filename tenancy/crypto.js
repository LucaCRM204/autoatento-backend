/**
 * Cifrado de secretos de tenants (connection strings, keys del bot, API keys).
 * AES-256-GCM con TENANT_DB_KEY (32 bytes, en hex de 64 caracteres o base64).
 *
 * Formato guardado:  v1:<iv base64>:<tag base64>:<datos base64>
 */
const crypto = require('crypto');

const PREFIX = 'v1';
let cachedKey = null;

function getKey() {
  if (cachedKey) return cachedKey;
  const raw = (process.env.TENANT_DB_KEY || '').trim();
  if (!raw) throw new Error('Falta TENANT_DB_KEY (32 bytes en hex o base64)');
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('TENANT_DB_KEY tiene que ser de 32 bytes (64 caracteres hex o base64)');
  cachedKey = buf;
  return buf;
}

function encrypt(plain) {
  if (plain === null || plain === undefined) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join(':');
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(`${PREFIX}:`) && value.split(':').length === 4;
}

function decrypt(value) {
  if (value === null || value === undefined || value === '') return null;
  if (!isEncrypted(value)) throw new Error('Valor cifrado con formato inválido');
  const [, iv, tag, data] = value.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

/** Para objetos (ej. el mapa de API keys de webhooks). */
const encryptJSON = (obj) => encrypt(JSON.stringify(obj));
const decryptJSON = (value) => {
  const s = decrypt(value);
  return s ? JSON.parse(s) : null;
};

module.exports = { encrypt, decrypt, encryptJSON, decryptJSON, isEncrypted };
