const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const pool = require('../db');
const { cookieName } = require('../tenancy/middleware');
const router = express.Router();

// Middleware: valida token desde header o cookie del tenant.
// (resolveTenant ya rechazó con 401 los tokens de otro tenant o sin tid)
function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/, '') || req.cookies?.[cookieName(req.tenant.slug)];
  if (!token) return res.status(401).json({ error: 'no_token' });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'missing_fields' });

    const [rows] = await pool.execute('SELECT * FROM users WHERE email = ? LIMIT 1', [email]);
    const user = rows[0];

    // Solo verificar si el usuario existe, no el estado active (se valida en el middleware de auth)
    if (!user) return res.status(401).json({ error: 'Credenciales inválidas' });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Credenciales inválidas' });

    const token = jwt.sign(
      // tid: tenant de la sesión (se valida en cada request y en el handshake del socket)
      { uid: user.id, role: user.role, id: user.id, email: user.email, active: user.active, tid: req.tenant.id },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    // Registro de login para el uso mensual (usuarios activos). Si la tabla
    // todavía no existe (tenant sin migrar) no frena el login.
    pool.execute('INSERT INTO user_logins (user_id, ip) VALUES (?, ?)', [user.id, String(req.ip || '').slice(0, 64)])
      .catch((e) => console.warn(`[auth] user_logins [${req.tenant.slug}]:`, e.code || e.message));

    // Un solo backend para todos los dominios: la cookie lleva el slug para no pisar la de otro tenant
    res.cookie(cookieName(req.tenant.slug), token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'none',
      path: '/',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.json({
      ok: true,
      token: token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name || user.email.split('@')[0],
        role: user.role,
        active: user.active,
        reportsTo: user.reportsTo || null
      }
    });

  } catch (error) {
    console.error('Error en login:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  res.json({
    id: req.user.uid,
    role: req.user.role,
    email: req.user.email,
    active: req.user.active
  });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.clearCookie(cookieName(req.tenant.slug), { path: '/' });
  res.json({ ok: true });
});

module.exports = router;
