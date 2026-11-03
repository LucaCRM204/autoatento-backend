/**
 * Middlewares HTTP de tenancy.
 *
 * tenantPathRewrite : /api/t/<slug>/...  ->  /api/...   (webhooks externos, MCP)
 * resolveTenant     : decide el tenant del request y lo mete en el contexto.
 *                     Orden: slug del path /api/t/<slug>  >  header X-Tenant.
 *                     Inexistente o de baja -> 404, suspendido -> 402.
 *                     Si viene un JWT nuestro, su tid tiene que coincidir -> si no, 401.
 * publicTenantRouter: GET /api/public/tenant?host=<hostname>  (o ?slug=)
 * rebindTenant      : vuelve a entrar al contexto (después de multer y otros
 *                     middlewares basados en streams que lo pueden perder).
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const registry = require('./registry');
const { runWithTenant } = require('./context');

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;

/** Rutas de /api que no necesitan tenant. */
const SIN_TENANT = [/^\/health\/?$/, /^\/public(\/|$)/, /^\/superadmin(\/|$)/];

const cookieName = (slug) => `session_${slug}`;

function tenantPathRewrite(req, _res, next) {
  const m = req.url.match(/^\/api\/t\/([^/?#]+)(.*)$/);
  if (m) {
    req.tenantSlugFromPath = decodeURIComponent(m[1]).toLowerCase();
    const resto = m[2] || '/';
    req.url = '/api' + (resto.startsWith('/') ? resto : `/${resto}`);
  }
  next();
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, '').trim() : null;
}

/**
 * Verifica que un JWT firmado por nosotros pertenezca al tenant.
 * Devuelve: 'ok' | 'ajeno' (válido pero de otro tenant / sin tid) | 'no-jwt' (no es un JWT nuestro)
 */
function checkTokenTenant(token, tenant) {
  if (!token) return 'no-jwt';
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    // Vencido, mal firmado o no es un JWT (ej. API key del MCP): lo decide la ruta.
    return 'no-jwt';
  }
  return decoded && Number(decoded.tid) === Number(tenant.id) ? 'ok' : 'ajeno';
}

async function findTenant(slug) {
  if (!slug || !SLUG_RE.test(slug)) return null;
  return registry.getBySlug(slug);
}

/** Respuesta de error según estado. Devuelve true si respondió. */
function rechazarPorEstado(res, tenant) {
  if (!tenant || tenant.estado === 'baja') {
    res.status(404).json({ ok: false, error: 'Tenant inexistente' });
    return true;
  }
  if (tenant.estado === 'suspendido') {
    res.status(402).json({ ok: false, error: 'Cuenta suspendida, contactá a AutoAtento' });
    return true;
  }
  return false;
}

function resolveTenant(req, res, next) {
  if (SIN_TENANT.some((re) => re.test(req.path))) return next();

  (async () => {
    const header = String(req.headers['x-tenant'] || '').trim().toLowerCase();
    const fromPath = req.tenantSlugFromPath || '';
    if (fromPath && header && fromPath !== header) {
      return res.status(400).json({ ok: false, error: 'El tenant del path y el header X-Tenant no coinciden' });
    }
    const slug = fromPath || header;
    if (!slug) return res.status(400).json({ ok: false, error: 'Falta el tenant (header X-Tenant)' });

    const tenant = await findTenant(slug);
    if (rechazarPorEstado(res, tenant)) return;

    for (const token of [bearer(req), req.cookies?.[cookieName(tenant.slug)]]) {
      if (checkTokenTenant(token, tenant) === 'ajeno') {
        return res.status(401).json({ ok: false, error: 'La sesión no corresponde a esta cuenta: volvé a iniciar sesión' });
      }
    }

    req.tenant = tenant;
    runWithTenant(tenant, next);
  })().catch((e) => {
    console.error('[resolveTenant]', e.message);
    res.status(503).json({ ok: false, error: 'No se pudo resolver la cuenta, probá de nuevo' });
  });
}

/**
 * 403 si el módulo está apagado para el tenant del request.
 * Va después de resolveTenant (necesita req.tenant).
 */
function requireModulo(modulo) {
  return (req, res, next) => {
    if (req.tenant?.modulos?.[modulo]) return next();
    res.status(403).json({ ok: false, error: 'Módulo no habilitado para esta cuenta', modulo });
  };
}

function rebindTenant(req, _res, next) {
  if (!req.tenant) return next();
  runWithTenant(req.tenant, next);
}

const publicTenantRouter = express.Router();
publicTenantRouter.get('/tenant', async (req, res) => {
  try {
    const host = String(req.query.host || '').trim();
    const slug = String(req.query.slug || '').trim().toLowerCase();
    if (!host && !slug) return res.status(400).json({ ok: false, error: 'Falta host' });
    const tenant = slug ? await findTenant(slug) : await registry.getByHost(host);
    if (!tenant || tenant.estado === 'baja') return res.status(404).json({ ok: false, error: 'Tenant inexistente' });
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ ok: true, ...registry.publicView(tenant) });
  } catch (e) {
    console.error('[public/tenant]', e.message);
    res.status(503).json({ ok: false, error: 'No se pudo resolver la cuenta' });
  }
});

module.exports = {
  tenantPathRewrite, resolveTenant, rebindTenant, publicTenantRouter, requireModulo,
  checkTokenTenant, findTenant, rechazarPorEstado, cookieName, SLUG_RE,
};
