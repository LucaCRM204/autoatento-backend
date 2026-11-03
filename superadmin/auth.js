/**
 * Autenticación del panel superadmin (usuarios de AutoAtento, tabla
 * autoatento_control.superadmins). Separada de los usuarios de cada CRM:
 * otro secreto (SUPERADMIN_JWT_SECRET) y scope 'superadmin' en el token.
 */
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { getControlPool } = require('../tenancy/control');

const EXPIRA = process.env.SUPERADMIN_JWT_EXPIRES_IN || '12h';

/** null si el panel está bien configurado; si no, el motivo. */
function problemaDeConfig() {
  const s = process.env.SUPERADMIN_JWT_SECRET;
  if (!s || s.length < 32) return 'Falta SUPERADMIN_JWT_SECRET (mínimo 32 caracteres)';
  if (s === process.env.JWT_SECRET) return 'SUPERADMIN_JWT_SECRET no puede ser igual a JWT_SECRET';
  return null;
}

// Freno simple a la fuerza bruta: 5 intentos fallidos por IP+email cada 15 min.
const intentos = new Map();
const VENTANA = 15 * 60 * 1000;
function bloqueado(clave) {
  const r = intentos.get(clave);
  if (!r) return false;
  if (Date.now() - r.desde > VENTANA) { intentos.delete(clave); return false; }
  return r.n >= 5;
}
function fallo(clave) {
  const r = intentos.get(clave);
  if (!r || Date.now() - r.desde > VENTANA) intentos.set(clave, { n: 1, desde: Date.now() });
  else r.n++;
}

async function login(req, res) {
  const problema = problemaDeConfig();
  if (problema) return res.status(503).json({ ok: false, error: `Panel deshabilitado: ${problema}` });

  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password) return res.status(400).json({ ok: false, error: 'Faltan email y contraseña' });

  const clave = `${req.ip}|${email}`;
  if (bloqueado(clave)) return res.status(429).json({ ok: false, error: 'Demasiados intentos, probá en 15 minutos' });

  const [rows] = await getControlPool().execute('SELECT * FROM superadmins WHERE email = ? LIMIT 1', [email]);
  const sa = rows[0];
  if (!sa || !sa.activo || !(await bcrypt.compare(password, sa.password))) {
    fallo(clave);
    return res.status(401).json({ ok: false, error: 'Credenciales inválidas' });
  }
  intentos.delete(clave);
  await getControlPool().execute('UPDATE superadmins SET last_login_at = NOW() WHERE id = ?', [sa.id]);

  const token = jwt.sign({ sid: sa.id, email: sa.email, scope: 'superadmin' }, process.env.SUPERADMIN_JWT_SECRET, { expiresIn: EXPIRA });
  res.json({ ok: true, token, superadmin: { id: sa.id, email: sa.email, nombre: sa.nombre } });
}

/** Middleware: token de superadmin válido y usuario activo. */
async function requireSuperadmin(req, res, next) {
  const problema = problemaDeConfig();
  if (problema) return res.status(503).json({ ok: false, error: `Panel deshabilitado: ${problema}` });

  const h = req.headers.authorization || '';
  const token = /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, '') : null;
  if (!token) return res.status(401).json({ ok: false, error: 'Token requerido' });

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.SUPERADMIN_JWT_SECRET);
  } catch {
    return res.status(401).json({ ok: false, error: 'Token inválido o vencido' });
  }
  if (decoded.scope !== 'superadmin') return res.status(401).json({ ok: false, error: 'Token inválido' });

  try {
    const [rows] = await getControlPool().execute('SELECT id, email, nombre, activo FROM superadmins WHERE id = ?', [decoded.sid]);
    if (!rows[0]?.activo) return res.status(401).json({ ok: false, error: 'Usuario desactivado' });
    req.superadmin = rows[0];
    next();
  } catch (e) {
    console.error('[superadmin] auth:', e.message);
    res.status(503).json({ ok: false, error: 'No se pudo validar la sesión' });
  }
}

module.exports = { login, requireSuperadmin, problemaDeConfig };
