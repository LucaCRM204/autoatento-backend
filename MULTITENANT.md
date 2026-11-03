# AutoAtento — arquitectura multi-tenant

Un solo backend y un solo frontend para todos los clientes (tenants), con
**una base de datos por tenant**. Las queries de las rutas no cambian: cada
request corre "dentro" de un tenant y `require('../db')` va al pool de ese
tenant. Un `WHERE` olvidado no puede filtrar datos entre clientes porque cada
cliente está en otra base.

> Estado: **Fase 1 terminada** (base multi-tenant del backend). Migraciones,
> panel superadmin, frontend único, tests formales y plan de migración de
> clientes son las fases 2 a 5.

---

## 1. Piezas

```
                  ┌──────────────────────────┐
  request ──────► │ tenantPathRewrite        │  /api/t/<slug>/x  ->  /api/x
                  │ resolveTenant            │  X-Tenant / slug del path, 404/402, tid del JWT
                  │   └─ runWithTenant(t)    │  AsyncLocalStorage { tenant, pool }
                  └────────────┬─────────────┘
                               ▼
         rutas existentes ── require('../db') ── proxy ──► pool del tenant (lazy)
                               │
                               └─ emitTenant(evento) ──► io.to('tenant:<id>')

  autoatento_control (MySQL aparte): tenants, superadmins, uso_mensual, audit_log
  crm_<slug> (una base por tenant):   el esquema de siempre (database.sql)
```

| Archivo | Qué hace |
|---|---|
| `tenancy/context.js` | `AsyncLocalStorage`: `runWithTenant`, `currentTenant`, `requireTenant` |
| `tenancy/pools.js` | Pool de mysql2 por tenant, creado al primer uso (`TENANT_POOL_LIMIT`, 4 por defecto). Se cierra a los 30 min sin uso y se recrea si cambia la `db_url` |
| `tenancy/crypto.js` | AES-256-GCM con `TENANT_DB_KEY` (formato `v1:iv:tag:datos`) |
| `tenancy/control.js` | Pool de la base de control y su esquema (`control/schema.sql`) |
| `tenancy/registry.js` | Lee `tenants` con caché (`TENANT_CACHE_TTL_MS`, 30 s). Los secretos descifrados quedan en un `WeakMap`, nunca en el objeto `tenant` |
| `tenancy/middleware.js` | `tenantPathRewrite`, `resolveTenant`, `GET /api/public/tenant`, `rebindTenant` |
| `tenancy/realtime.js` | `emitTenant`, `emitTenantUser`, rooms `tenant:<id>` y `tenant:<id>:user:<uid>` |
| `tenancy/jobs.js` | `forEachTenant(fn)` y `everyTenant(nombre, ms, fn)` |
| `tenancy/state.js` | `perTenant(nombre, init)`: estado en memoria separado por tenant |
| `tenancy/time.js` | `nowInTz()`: hora local del tenant (`config.timezone`) |
| `tenancy/settings.js` | `tenantConfig`, `tenantSecret`, `waBot()`, `tenantNombre()` |
| `tenancy/modules.js` | Lista de módulos (feature flags) y sus defaults |
| `tenancy/provision.js` | Crear schema, cargar esquema base, owner y registro del tenant |
| `db.js` | Proxy con `execute`, `query`, `getConnection`, `escape`, `format`. **Sin tenant en el contexto tira `NO_TENANT`**; nunca usa un pool por defecto |

## 2. Resolución del tenant (HTTP)

Orden en `resolveTenant` (va antes de todas las rutas `/api`):

1. **Slug en el path** `/api/t/<slug>/...` (webhooks externos, MCP). Se reescribe a `/api/...`.
2. **Header `X-Tenant: <slug>`** (lo manda el frontend).
3. Si vienen los dos y no coinciden → **400**.

Después:

- Sin tenant → **400** `Falta el tenant`.
- Inexistente o en estado `baja` → **404** `Tenant inexistente`.
- `suspendido` → **402** `{ error: 'Cuenta suspendida, contactá a AutoAtento' }`.
- Si el request trae un JWT nuestro (header `Authorization` o cookie `session_<slug>`), su `tid` tiene que ser el id del tenant. Si no coincide o no tiene `tid` → **401**.

Las únicas rutas sin tenant son `/api/health`, `/api/public/*` y `/api/superadmin/*` (esta última es de la Fase 2).

**`GET /api/public/tenant?host=<hostname>`** (o `?slug=`) devuelve `slug`, `nombre`,
`estado`, `branding` (si no hay nombre cargado, usa "AutoAtento"), `modulos` y la
config no sensible (`timezone`, `pais`, `prefijo_telefonico`, `moneda`,
`wa_bot_url`). Nunca devuelve credenciales.

**Login:** el JWT ahora incluye `tid`. La cookie pasa a llamarse
`session_<slug>`, porque el backend es uno solo para todos los dominios y así
la cookie de un tenant no pisa la de otro. `requireAuth` mira primero el
header y después la cookie.

**Rutas que antes no pedían token y ahora sí:** `/api/calls`, `/api/metas` y
`/api/users`. El frontend tiene que llamarlas con `Authorization: Bearer`.
`services/metas.ts` y `services/users.ts` ya lo hacen a través de `api.ts`.
`CallPanel.tsx` usa `fetch` directo y manda el token si lo tiene; en la Fase 3
hay que sumarle `X-Tenant`.

## 3. Base de control (`autoatento_control`)

Ver `control/schema.sql`.

- **`tenants`:**
  - `slug` (único);
  - `nombre`;
  - `estado`: `activo` / `suspendido` / `baja`;
  - `plan`: `esencial` / `pro` / `arm`;
  - `db_url_cifrada`;
  - `dominios`, `modulos`, `branding` y `config` (JSON).
- **`superadmins`:** usuarios del panel de AutoAtento (Fase 2).
- **`uso_mensual`:** `(tenant_id, mes)` → usuarios activos y leads ingresados (Fase 2).
- **`audit_log`:** acciones de superadmins, incluido "entrar como owner" (Fase 2).

`schema_migrations` vive **en cada base de tenant** (Fase 2). Así una base
existente, como la de Fiat en Railway, lleva su propio registro.

### Claves de `tenants.config`

| Clave | Cifrada | Uso |
|---|---|---|
| `timezone` | no | Zona IANA. Si falta, `America/Argentina/Buenos_Aires` |
| `pais`, `prefijo_telefonico`, `moneda` | no | Datos del país. `pais` entra en el prompt del agente |
| `wa_bot_url` | no | URL del bot de WhatsApp del tenant |
| `wa_bot_key` | **sí** | `AGENT_BOT_KEY` del bot |
| `lead_api_keys` | **sí** | `{ proveedor: clave }`: API keys de webhooks (`whatsapp-bot`, `zapier-formularios`, `sheet-emanuel`, `sheet-fastlead`, ...) |
| `sheet_fuentes` | no | `{ proveedor: fuente }`: suma o pisa el mapeo de Google Sheets a fuente |
| `dist_excluidos` | no | Ids de usuarios que nunca reciben leads (antes `DIST_EXCLUIDOS`) |
| `openai_api_key` / `anthropic_api_key` | **sí** | Key propia del tenant para el Agente IA. Si falta, usa el env |
| `agent_provider`, `agent_model` | no | Proveedor y modelo del agente para este tenant |
| `agent_mcp_key` | **sí** | Key del MCP del tenant. Sin ella, `/api/t/<slug>/mcp` responde 404 |

### Módulos (`tenants.modulos`)

| Módulo | Default si no se carga |
|---|---|
| `agente_ia`, `whatsapp_bot`, `chat_whatsapp`, `presupuestos`, `metas`, `ranking`, `analytics`, `asignar_tareas` | prendido |
| `multi_marca`, `motos`, `scoring` | apagado |

En la Fase 1 solo `agente_ia` cambia el comportamiento del backend: el worker
del agente y los eventos con IA corren únicamente en los tenants que lo tienen
prendido. El 403 de las rutas de un módulo apagado y el menú del frontend son
de la Fase 3.

## 4. Tiempo real (Socket.io)

- **Handshake:** `io(url, { auth: { token, tenant: '<slug>' } })`. El server
  valida el token, que el tenant exista y esté activo, y que el `tid` coincida.
  Si algo falla, rechaza la conexión.
- **Rooms:** cada socket entra a `tenant:<id>` y a `tenant:<id>:user:<uid>`.
- **Handlers:** todos corren dentro del contexto del tenant del socket.
- **Emisión:**
  - todos los `io.emit` pasaron a `emitTenant(evento, data)`;
  - `emitToUser` pasó a la room del usuario dentro del tenant;
  - los `socket.broadcast.emit` pasaron a `socket.to('tenant:<id>')`.
- **Sin tenant en el contexto:** `emitTenant` descarta el evento y loguea el
  error. Ningún evento puede salir a todos los tenants.
- **Presencia:** `users:online` y `/api/activity/online` usan la clave
  `tenant:usuario`, porque los ids de usuario se repiten entre bases.

## 5. Tareas en segundo plano

Todo `setInterval` que toca la base pasa por `everyTenant`. Corre la función
en cada tenant activo, con try/catch por tenant, y no solapa dos corridas del
mismo tenant.

| Tarea | Intervalo | Dónde |
|---|---|---|
| Realinear equipos de distribución | 15 min (primera corrida a los 30 s) | `server.js` |
| Reset mensual de distribución | Cada hora; corre el día 1 en la zona horaria del tenant | `server.js` |
| Checker de aceptación de leads | 30 s | `socket-server.js` |
| Scanner del agente (eventos + avisos de recordatorios vencidos) | 60 s | `agent/index.js` |
| Worker del agente (llamadas al LLM) | 5 s, solo tenants con `agente_ia`, hasta `AGENT_CONCURRENCY` en paralelo | `agent/index.js` |

**Agente IA:**
- **Esquema y usuario:** las tablas y el usuario de sistema se crean por tenant la primera vez que se usa el agente ahí (`agent/state.js`).
- **Configuración:** la caché de `agent_config` es por tenant.
- **Hora:** `nowArg()` y `enHorario()` usan la zona horaria del tenant.
- **Marca:** el system prompt y el MCP usan `branding.nombre`.
- **LLM:** la key sale de `tenants.config` o del env.
- **Bot de WhatsApp:** URL y key salen de `tenants.config` o del env.

## 6. Correr local

Docker no funciona en la PC de desarrollo (virtualización deshabilitada). Se
usa una MySQL de desarrollo en Railway, **vacía y sin datos de clientes**.
`docker-compose.yml` queda para más adelante.

```bash
cd autoatento-backend
npm install
# .env con DEV_MYSQL_URL, TENANT_DB_KEY, JWT_SECRET, SUPERADMIN_JWT_SECRET y DEV_TENANT_PASSWORD (ver .env.example)
npm run control:init   # crea autoatento_control
npm run dev:seed       # BORRA y recrea crm_tenant-a y crm_tenant-b con datos distintos
npm run smoke          # levanta el server en un puerto libre y corre los checks de aislamiento
npm run dev            # server en :3001
```

Pedido a mano:

```bash
curl -s localhost:3001/api/public/tenant?host=tenant-a.localhost
TOKEN=$(curl -s -X POST localhost:3001/api/auth/login -H 'X-Tenant: tenant-a' -H 'Content-Type: application/json' \
  -d '{"email":"owner@demo.test","password":"<DEV_TENANT_PASSWORD>"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s localhost:3001/api/leads -H 'X-Tenant: tenant-a' -H "Authorization: Bearer $TOKEN"
curl -s localhost:3001/api/leads -H 'X-Tenant: tenant-b' -H "Authorization: Bearer $TOKEN"   # 401
```

## 7. Crear un tenant (Fase 1: línea de comandos)

```bash
# Schema nuevo crm_<slug> en TENANT_DB_SERVER_URL, con esquema base y owner
npm run tenant:add -- --slug mi-cliente --nombre "Mi Cliente" --plan pro --create-schema \
  --dominio crm.micliente.com.ar --owner-email dueño@micliente.com --owner-password '...' \
  --branding-nombre "Mi Cliente Autos" --color '#c00' \
  --wa-bot-url https://.../wa-micliente --wa-bot-key '...' \
  --lead-key whatsapp-bot:'...' --lead-key sheet-emanuel:'...'

# Apuntar a una base existente (no carga esquema salvo --load-schema)
npm run tenant:add -- --slug fiat-autodelsol --nombre "Auto del Sol Fiat" --db-url 'mysql://...'
```

Las claves pasadas por línea de comandos quedan en el historial de la
terminal. En la Fase 2 esto se hace desde el panel superadmin.

## 8. Migraciones

*Fase 2.* `migrations/000_baseline.sql` = `database.sql`. Tabla
`schema_migrations` en cada base de tenant, `npm run migrate` y `AUTO_MIGRATE=1`.
Las migraciones tienen que ser compatibles con MySQL 8 y MariaDB, con chequeos
contra `information_schema` y sin `ADD COLUMN IF NOT EXISTS`.

Mientras tanto:
- `bootstrap.js` ya **no** corre `database.sql` al arrancar; solo asegura la base de control;
- el esquema de un tenant nuevo se carga con `tenant:add --create-schema`;
- `agent/schema.js` sigue creando las tablas del agente y la columna `wa_messages.sent_by` por tenant, la primera vez que se usa. En la Fase 2 eso pasa a ser una migración.

## 9. Migrar un cliente existente

*El paso a paso detallado es de la Fase 5.* Cambios de comportamiento que hay
que **avisar al cliente** (Fiat primero) cuando se migre:

1. **Re-login obligatorio una vez:** los tokens viejos no tienen `tid` y reciben 401.
2. **Horario del flujo de aceptación de leads:** `isWorkingHours()` (9:30 a
   19:30, lunes a viernes) antes usaba la hora del servidor. En Railway el
   servidor está en UTC, así que el horario efectivo era 6:30 a 16:30 de
   Argentina. Ahora usa la zona horaria del tenant: la ventana pasa a ser
   9:30 a 19:30 de Argentina.
3. **URLs de webhooks:** pasan a `/api/t/<slug>/webhooks/...`. Esto incluye
   Google Sheets, Zapier y la URL a la que el bot manda leads. Las API keys
   actuales (`LEAD_API_KEYS` del deploy viejo) se cargan en
   `config.lead_api_keys` del tenant y siguen sirviendo.
4. **Bot de WhatsApp:** `wa_bot_url` y `wa_bot_key` se cargan en la config del
   tenant. Ya no hay default al bot de Fiat (`https://api.crmalluma.com.ar/wa-fiat`).
5. **`DIST_EXCLUIDOS`** pasa a `config.dist_excluidos`.
6. **`AGENT_MCP_KEY`** pasa a `config.agent_mcp_key`, y la URL del MCP pasa a
   `/api/t/<slug>/mcp`.
7. **`/api/calls`, `/api/metas` y `/api/users`** piden token (ver la sección 2).
8. **Cookie de sesión:** pasa a llamarse `session_<slug>`. El front usa el token
   del header, así que no debería notarse.

## 10. Bot de WhatsApp (fuera de alcance)

Cada tenant sigue con su bot propio (Baileys en el droplet), configurado con
`tenants.config.wa_bot_url` y `wa_bot_key`. El bot escribe directo en la base
del tenant (`wa_messages`, `wa_conversations`) y le manda leads al webhook del
tenant. Para pasar a un bot multi-tenant haría falta:

- **Datos:** una sesión de Baileys por número con `tenant_id` y escritura por
  la API del CRM (`/api/t/<slug>/...`) en vez de conexión directa a la base;
- **Webhook:** entrante único, que resuelva el tenant por el número receptor;
- **Configuración:** prompt e IA del bot por tenant (branding, modelos, horarios);
- **Alternativa:** la API oficial de WhatsApp Cloud, con un webhook de Meta
  que resuelva el tenant por `phone_number_id`.

## 11. Bugs previos detectados (no son de multi-tenant, sin tocar)

- `GET /api/leads/unassigned` y `GET /api/leads/distribution` nunca se alcanzan: los tapa `GET /api/leads/:id`, que está definido antes en `routes/leads.js` (responden 404 "Lead no encontrado").
- `GET /api/activity/reassignments` responde 500 en MySQL 8.0.22 o posterior: usa `LIMIT ?` con `execute()` (`ER_WRONG_ARGUMENTS`). `routes/alertas.js` ya tiene el arreglo (LIMIT inline validado).
- Al desconectarse, el log del socket muestra `Usuario desconectado: undefined` porque el JWT no lleva `name`. Es solo cosmético.

## 12. Pendiente

- **Fase 2:** migraciones, panel superadmin (crear, editar, suspender, uso, "entrar como owner") y registro de uso mensual.
- **Fase 3:** `TenantContext`, `X-Tenant`, socket con slug, branding, módulos (403 en backend), `/superadmin` y `CallPanel` con `X-Tenant`.
- **Fase 4:** tests automáticos de aislamiento. Hoy está `npm run smoke`, con 44 checks.
- **Fase 5:** plan de migración de Fiat y checklist para comparar los otros clones.
- **Sockets:** los sockets abiertos de un tenant que se suspende siguen conectados hasta que se reconectan. Las requests HTTP sí reciben 402 enseguida (caché de 30 s). En la Fase 2 el panel puede desconectarlos al suspender.
- **Columna `leads.marca`:** es `ENUM('fiat')` y los webhooks insertan `'fiat'` fijo. Para `multi_marca` o `motos` hace falta una migración (Fase 2/3).
