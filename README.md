# AutoAtento — backend

CRM multi-tenant para concesionarias (CRM + bot de WhatsApp con IA + Agente IA).
Un solo backend y un solo frontend para todos los clientes, con una base de
datos por cliente. La arquitectura completa está en [MULTITENANT.md](MULTITENANT.md).

Repos: `autoatento-backend` (este) y `autoatento-frontend`.

> En **Windows PowerShell 5** usá `npm.cmd` en vez de `npm`: con `npm` a secas,
> PowerShell pierde los argumentos que van después de `--`.

## Requisitos

- Node 18 o superior (desarrollo con Node 22).
- La MySQL 8 de desarrollo (Railway, vacía, sin datos de clientes).
- `.env` armado a partir de `.env.example`. En desarrollo alcanza con:
  - `DEV_MYSQL_URL`;
  - `TENANT_DB_KEY`, `JWT_SECRET` y `SUPERADMIN_JWT_SECRET`;
  - `DEV_TENANT_PASSWORD`;
  - `TZ=UTC`.

## Backend

| bash | PowerShell 5 | Qué hace |
|---|---|---|
| `npm install` | `npm.cmd install` | Dependencias |
| `npm run control:init` | `npm.cmd run control:init` | Crea la base de control `autoatento_control` |
| `npm run dev:seed` | `npm.cmd run dev:seed` | **Borra y recrea** los tenants de desarrollo `tenant-a` y `tenant-b` |
| `npm run dev` | `npm.cmd run dev` | Server en http://localhost:3001 |
| `npm run migrate` | `npm.cmd run migrate` | Migraciones pendientes de todos los tenants activos (`-- --dry-run` para ver) |

Usuarios de `dev:seed` (en los dos tenants, con la contraseña `DEV_TENANT_PASSWORD`):
`owner@demo.test`, `gerente@demo.test`, `super@demo.test`, `vend1@demo.test`, `vend2@demo.test`.

Superadmin para el panel:

```bash
SUPERADMIN_PASSWORD='...' npm run superadmin:add -- --email vos@autoatento.com
```
```powershell
$env:SUPERADMIN_PASSWORD='...'; npm.cmd run superadmin:add -- --email vos@autoatento.com; Remove-Item Env:SUPERADMIN_PASSWORD
```

## Frontend

```bash
cd ../autoatento-frontend
npm install
npm run dev        # http://localhost:5173
```
```powershell
cd ..\autoatento-frontend
npm.cmd install
npm.cmd run dev
```

El `.env` del front lleva:

```
VITE_API_URL=http://localhost:3001/api
VITE_DEV_TENANT=tenant-a
```

| URL | Qué abre |
|---|---|
| http://localhost:5173 | CRM de `tenant-a` |
| http://localhost:5173/?tenant=tenant-b | CRM de `tenant-b` (también http://tenant-b.localhost:5173) |
| http://localhost:5173/superadmin | Panel de AutoAtento |

Chequeo de tipos y build: `npm run build` (o `npm.cmd run build`).

## Tests

| bash | PowerShell 5 | Qué prueba | Duración |
|---|---|---|---|
| `npm test` | `npm.cmd test` | **Tests de aislamiento** (node:test + supertest, 51 tests) | ~1,5 min |
| `npm run smoke` | `npm.cmd run smoke` | Smoke de la Fase 1 (53 checks). Correrlo después de `dev:seed` | ~1 min |
| `npm run smoke:fase2` | `npm.cmd run smoke:fase2` | Smoke de la Fase 2 (50 checks). Al final deja todo como `dev:seed` | ~2 min |

`npm test`:
- **Tenants propios:** crea sus propios tenants en la base de desarrollo (`crm_test_<id>_a` y `crm_test_<id>_b`) y los borra al terminar. No toca `tenant-a` ni `tenant-b`.
- **Server real:** levanta el server en un puerto libre (con sockets y tareas en segundo plano), así que no hace falta tener nada corriendo.

**Qué cubre:**
- token cruzado → 401;
- A no ve leads, notas, alertas, tareas, mensajes de WhatsApp, recordatorios, acciones del agente ni usuarios de B;
- webhooks con la key de otro tenant → 401;
- sockets aislados;
- tareas en segundo plano por tenant;
- tenant suspendido → 402 y corte de sockets;
- módulo apagado → 403;
- panel superadmin: sin token no entra, el token de un owner no sirve ahí y el del panel no sirve en un CRM.
