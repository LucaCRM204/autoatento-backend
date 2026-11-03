# AutoAtento — arquitectura multi-tenant

Un solo backend y un solo frontend para todos los clientes (tenants), con
**una base de datos por tenant**. Las queries de las rutas no cambian: cada
request corre "dentro" de un tenant y `require('../db')` va al pool de ese
tenant. Un `WHERE` olvidado no puede filtrar datos entre clientes porque cada
cliente está en otra base.

> Estado: **Fases 1 a 4 terminadas**:
> - base multi-tenant del backend;
> - migraciones, panel superadmin y uso mensual;
> - frontend único y pantalla `/superadmin`;
> - tests de aislamiento.
>
> Queda el plan de migración de clientes (Fase 5). Cómo correr todo: [README.md](README.md).

> **Comandos en Windows PowerShell 5.** Cada bloque tiene su variante.
> - **`npm.cmd`, no `npm`:** en PowerShell 5, `npm run x -- --flag` **pierde los
>   argumentos** (`npm.ps1` se come el `--`). Por ejemplo, `npm run migrate -- --dry-run`
>   migra de verdad. Usá **`npm.cmd run x -- --flag`**, o `node scripts/x.js --flag`.
> - **Variables:** `$env:VAR='valor'; npm.cmd run ...` y después `Remove-Item Env:VAR`.
> - **Pedidos HTTP:** `curl` es un alias de `Invoke-WebRequest`; los ejemplos usan
>   `Invoke-RestMethod`.

---

## 1. Piezas

```
                  ┌──────────────────────────┐
  request ──────► │ tenantPathRewrite        │  /api/t/<slug>/x  ->  /api/x
                  │ resolveTenant            │  X-Tenant / slug del path, 404/402, tid del JWT
                  │   └─ runWithTenant(t)    │  AsyncLocalStorage { tenant, pool }
                  │ requireModulo(m)         │  403 si el módulo está apagado
                  └────────────┬─────────────┘
                               ▼
         rutas existentes ── require('../db') ── proxy ──► pool del tenant (lazy)
                               │
                               └─ emitTenant(evento) ──► io.to('tenant:<id>')

  autoatento_control (MySQL aparte): tenants, superadmins, uso_mensual, audit_log
  crm_<slug> (una base por tenant):   esquema del CRM (migrations/) + schema_migrations
```

| Archivo | Qué hace |
|---|---|
| `tenancy/context.js` | `AsyncLocalStorage`: `runWithTenant`, `currentTenant`, `requireTenant` |
| `tenancy/pools.js` | Pool de mysql2 por tenant, creado al primer uso (`TENANT_POOL_LIMIT`, 4 por defecto). Se cierra a los 30 min sin uso y se recrea si cambia la `db_url` |
| `tenancy/crypto.js` | AES-256-GCM con `TENANT_DB_KEY` (formato `v1:iv:tag:datos`). Con `TENANT_DB_KEY_ANTERIOR` también descifra con la key vieja (rotación) |
| `tenancy/control.js` | Pool de la base de control y su esquema (`control/schema.sql`) |
| `tenancy/registry.js` | Lee `tenants` con caché (`TENANT_CACHE_TTL_MS`, 30 s). Los secretos descifrados quedan en un `WeakMap`, nunca en el objeto `tenant` |
| `tenancy/middleware.js` | `tenantPathRewrite`, `resolveTenant`, `requireModulo`, `GET /api/public/tenant`, `rebindTenant` |
| `tenancy/realtime.js` | `emitTenant`, `emitTenantUser`, `disconnectTenant`, vigilante de suspensiones |
| `tenancy/jobs.js` | `forEachTenant(fn)` y `everyTenant(nombre, ms, fn)` |
| `tenancy/state.js` | `perTenant(nombre, init)`: estado en memoria separado por tenant |
| `tenancy/time.js` | `nowInTz()` y `rangoMesUtc()`: hora y meses en la zona horaria del tenant |
| `tenancy/settings.js` | `tenantConfig`, `tenantSecret`, `waBot()`, marcas (`resolverMarca`, `marcaPermitida`) |
| `tenancy/modules.js` | Lista de módulos (feature flags) y sus defaults |
| `tenancy/migrate.js` | Runner de migraciones por tenant |
| `tenancy/provision.js` | Alta y edición de tenants (schema, migraciones, owner, registro) |
| `superadmin/` | Rutas del panel, auth propia, auditoría y uso mensual |
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

Las únicas rutas sin tenant son `/api/health`, `/api/public/*` y `/api/superadmin/*`.

**`GET /api/public/tenant?host=<hostname>`** (o `?slug=`):
- **Devuelve:** `slug`, `nombre`, `estado`, `branding` (si no hay nombre cargado, usa "AutoAtento"), `modulos` y la config no sensible (`timezone`, `pais`, `prefijo_telefonico`, `moneda`, `wa_bot_url`, `marcas`, `marca_default`). Nunca devuelve credenciales.
- **Caché:** va con `Cache-Control: no-cache` (el navegador revalida con ETag), así los cambios del panel se ven enseguida.

**Login:**
- el JWT incluye `tid`;
- la cookie se llama `session_<slug>`, porque el backend es uno solo para todos los dominios;
- `requireAuth` mira primero el header y después la cookie.

**Rutas que antes no pedían token y ahora sí:** `/api/calls`, `/api/metas` y
`/api/users`. El front las llama con token (`api.ts` y `CallPanel`).

## 3. Base de control (`autoatento_control`)

Ver `control/schema.sql`.

- **`tenants`:**
  - `slug` (único);
  - `nombre`;
  - `estado`: `activo` / `suspendido` / `baja`;
  - `plan`: `esencial` / `pro` / `arm`;
  - `db_url_cifrada`;
  - `dominios`, `modulos`, `branding` y `config` (JSON).
- **`superadmins`:** usuarios del panel de AutoAtento (sección 10).
- **`uso_mensual`:** `(tenant_id, mes)` → usuarios activos y leads ingresados (sección 11).
- **`audit_log`:** acciones de superadmins, incluido "entrar como owner".

`schema_migrations` vive **en cada base de tenant** (sección 9).

### Claves de `tenants.config`

| Clave | Cifrada | Uso |
|---|---|---|
| `timezone` | no | Zona IANA. Si falta, `America/Argentina/Buenos_Aires`. Horarios, agente, recordatorios y corte de mes del uso |
| `pais`, `prefijo_telefonico`, `moneda` | no | Datos del país. `pais` entra en el prompt del agente |
| `marcas` | no | Marcas habilitadas, en minúscula: `["fiat", "jeep"]` |
| `marca_default` | no | Marca para leads sin marca o con una no habilitada (tiene que estar en `marcas`) |
| `wa_bot_url` | no | URL del bot de WhatsApp del tenant (el front también la usa) |
| `wa_bot_key` | **sí** | `AGENT_BOT_KEY` del bot |
| `lead_api_keys` | **sí** | `{ proveedor: clave }`: API keys de webhooks (`whatsapp-bot`, `zapier-formularios`, `sheet-emanuel`, `sheet-fastlead`, ...) |
| `sheet_fuentes` | no | `{ proveedor: fuente }`: suma o pisa el mapeo de Google Sheets a fuente |
| `dist_excluidos` | no | Ids de usuarios que nunca reciben leads (antes `DIST_EXCLUIDOS`) |
| `openai_api_key` / `anthropic_api_key` | **sí** | Key propia del tenant para el Agente IA. Si falta, usa el env |
| `agent_provider`, `agent_model` | no | Proveedor y modelo del agente para este tenant |
| `agent_mcp_key` | **sí** | Key del MCP del tenant. Sin ella, `/api/t/<slug>/mcp` responde 404 |

### Marcas del lead

No hay ninguna marca hardcodeada:

| Dónde | Regla |
|---|---|
| Webhooks y bot (`/webhooks/whatsapp-bot`, `/zapier-formularios`, `/sheets`) | Si el payload trae `marca` y está en `config.marcas`, se usa; si no, `marca_default` |
| Alta y edición manual de leads | Sin marca → `marca_default`. Con una marca no habilitada → **400** "Marca inválida" |
| Presupuestos | Igual que los webhooks |
| Tenant sin `marcas` cargadas | Acepta cualquier marca; sin marca queda `NULL` |

### Módulos (`tenants.modulos`)

| Módulo | Default | Backend (403 si está apagado) | Frontend (desaparece si está apagado) |
|---|---|---|---|
| `agente_ia` | prendido | `/api/agent`, `/api/mcp`, `/mcp`; además el worker del agente no corre | Menú "Agente IA" |
| `whatsapp_bot` | prendido | `POST /api/webhooks/whatsapp-bot` | Menú "WhatsApp Admin" |
| `chat_whatsapp` | prendido | `/api/whatsapp` | Botones "Chat" de cada lead |
| `presupuestos` | prendido | `/api/presupuestos` | Botones "Presup" y la carga de plantillas |
| `metas` | prendido | `/api/metas` | Menú "Gestión de Metas" |
| `asignar_tareas` | prendido | `/api/tareas` | Menú "Asignar Tareas" (Mis Tareas sigue, con los recordatorios) |
| `ranking` | prendido | — | Menú "Ranking" |
| `analytics` | prendido | — | Menú "Análisis Diario" |
| `aceptacion_leads` *(futuro, no implementado como flag)* | — | Flujo de ofertas: el lead se ofrece a un vendedor que tiene 10 min para aceptarlo (`socket-server.js`, `/api/leads/:id/accept|reject`, `LeadAcceptanceModal.tsx`). **Queda apagado**: el CRM no lo dispara (nadie llama a `initiateLeadOffer` y el modal no está montado). El checker sigue corriendo pero sin ofertas pendientes no hace nada. Si algún cliente lo quiere, se convierte en módulo y se monta el modal | — |
| `multi_marca`, `motos`, `scoring` | apagado | — | Sin UI en el CRM base. **Se definen al migrar GoldPlan** (qué pantallas y reglas activa cada uno); hasta entonces son flags reservados |

## 4. Tiempo real (Socket.io)

- **Handshake:** `io(url, { auth: { token, tenant: '<slug>' } })`. El server
  valida el token, que el tenant exista y esté activo, y que el `tid` coincida.
- **Rooms:** cada socket entra a `tenant:<id>` y a `tenant:<id>:user:<uid>`.
- **Handlers:** todos corren dentro del contexto del tenant del socket.
- **Emisión:** todo pasa por `emitTenant`, `emitTenantUser` o `socket.to('tenant:<id>')`. Sin tenant en el contexto, el evento se descarta y se loguea.
- **Suspensión:** al suspender o dar de baja se cortan los sockets del tenant, con un aviso `tenant:estado` antes. El front muestra "Cuenta suspendida".
- **Presencia:** separada por tenant (clave `tenant:usuario`).

## 5. Tareas en segundo plano

Todo `setInterval` que toca la base pasa por `everyTenant` (try/catch por
tenant, sin solapar corridas del mismo tenant).

| Tarea | Intervalo | Dónde |
|---|---|---|
| Realinear equipos de distribución | 15 min (primera corrida a los 30 s) | `server.js` |
| Reset mensual de distribución | Cada hora; corre el día 1 en la zona horaria del tenant | `server.js` |
| Checker de aceptación de leads | 30 s | `socket-server.js` |
| Scanner del agente (eventos + avisos de recordatorios vencidos) | 60 s | `agent/index.js` |
| Worker del agente (llamadas al LLM) | 5 s, solo tenants con `agente_ia`, hasta `AGENT_CONCURRENCY` en paralelo | `agent/index.js` |
| Uso mensual | 1 h (primera corrida al minuto) | `superadmin/uso.js` |
| Vigilante de suspensiones (corta sockets) | 30 s (`SUSPENSION_WATCH_MS`) | `tenancy/realtime.js` |

## 6. Correr local

Docker no funciona en la PC de desarrollo. Se usa una MySQL de desarrollo en
Railway, **vacía y sin datos de clientes**. `docker-compose.yml` queda para más adelante.

**Backend** (bash):

```bash
cd autoatento-backend
npm install
# .env con DEV_MYSQL_URL, TENANT_DB_KEY, JWT_SECRET, SUPERADMIN_JWT_SECRET y DEV_TENANT_PASSWORD (ver .env.example)
npm run control:init   # crea autoatento_control
npm run dev:seed       # BORRA y recrea crm_tenant-a y crm_tenant-b (schema + migraciones + owner + datos)
npm run smoke          # aislamiento entre tenants, módulos y marcas (53 checks)
npm run smoke:fase2    # migraciones, superadmin, uso, suspensión (50 checks); al final deja todo como dev:seed
npm run dev            # server en :3001
```

Backend (PowerShell 5):

```powershell
cd autoatento-backend
npm.cmd install
npm.cmd run control:init
npm.cmd run dev:seed
npm.cmd run smoke
npm.cmd run smoke:fase2
npm.cmd run dev
```

**Frontend** (`autoatento-frontend`, `.env` con `VITE_API_URL=http://localhost:3001/api` y `VITE_DEV_TENANT=tenant-a`):

```bash
cd autoatento-frontend
npm install
npm run dev            # http://localhost:5173 -> tenant de VITE_DEV_TENANT
```

```powershell
cd autoatento-frontend
npm.cmd install
npm.cmd run dev
```

**Cómo elegir el tenant en desarrollo:**
- `http://localhost:5173`: usa `VITE_DEV_TENANT`.
- `http://localhost:5173/?tenant=tenant-b`: cambia de tenant (queda guardado en la pestaña).
- `http://tenant-b.localhost:5173`: resuelve por dominio, como en producción. Funciona porque `tenant-b.localhost` está en los dominios del tenant.
- `http://localhost:5173/superadmin`: el panel. Para tener un usuario, ver la sección 10.

**Pedidos a mano** (bash):

```bash
curl -s "localhost:3001/api/public/tenant?host=tenant-a.localhost"
TOKEN=$(curl -s -X POST localhost:3001/api/auth/login -H 'X-Tenant: tenant-a' -H 'Content-Type: application/json' \
  -d '{"email":"owner@demo.test","password":"<DEV_TENANT_PASSWORD>"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s localhost:3001/api/leads -H 'X-Tenant: tenant-a' -H "Authorization: Bearer $TOKEN"
curl -s localhost:3001/api/leads -H 'X-Tenant: tenant-b' -H "Authorization: Bearer $TOKEN"   # 401
```

Pedidos a mano (PowerShell 5):

```powershell
Invoke-RestMethod "http://localhost:3001/api/public/tenant?host=tenant-a.localhost"
$login = Invoke-RestMethod -Method Post http://localhost:3001/api/auth/login -Headers @{ 'X-Tenant'='tenant-a' } `
  -ContentType 'application/json' -Body '{"email":"owner@demo.test","password":"<DEV_TENANT_PASSWORD>"}'
Invoke-RestMethod http://localhost:3001/api/leads -Headers @{ 'X-Tenant'='tenant-a'; Authorization="Bearer $($login.token)" }
Invoke-RestMethod http://localhost:3001/api/leads -Headers @{ 'X-Tenant'='tenant-b'; Authorization="Bearer $($login.token)" }   # 401
```

## 7. Frontend único

Un solo build (`autoatento-frontend`) para todos los clientes:

| Pieza | Qué hace |
|---|---|
| `src/tenant/TenantContext.tsx` | Al cargar: `GET /api/public/tenant?host=<hostname>` (en localhost, `?tenant=` o `VITE_DEV_TENANT`). Pone título, favicon y color primario (`--color-primario`). Muestra "Cuenta no encontrada" o "Cuenta suspendida" si corresponde. Expone `useTenant()` → `{ tenant, modulo(m), nombreMarca }` |
| `src/tenant/store.ts` | Tenant accesible fuera de React: `X-Tenant` en `api.ts`, `api/client.ts` y los `fetch` directos (`CallPanel`, `DistribucionLeads`, `LeadAcceptanceModal`) |
| `src/hooks/useRealtime.ts` | El handshake lleva el slug. Escucha `tenant:estado` y se reconecta cuando cambia el token |
| `src/CRM.tsx` | Cambios puntuales: branding en login y menú, "Powered by AutoAtento", menú, secciones y botones según módulos, bot desde `config.wa_bot_url`, plantillas de WhatsApp con el nombre del tenant |
| `src/superadmin/` | Panel `/superadmin` (sección 10) |
| `vercel.json` | Rewrite SPA: todas las rutas sirven `index.html` (para `/superadmin`) |

**Entrar como owner:**
1. El panel abre `https://<dominio del tenant>/#imp=<token>&u=<usuario>`. El token viaja en el fragmento (`#`), que el navegador no manda a ningún servidor.
2. `TenantProvider` lo guarda en `sessionStorage` y lo saca de la URL.
3. `CRM.tsx` inicia sesión con ese token.
4. Un aviso fijo dice "Modo soporte" mientras dure la sesión (1 hora).

**Variables del front:**
- `VITE_API_URL`: backend con `/api` al final.
- `VITE_DEV_TENANT`: solo para desarrollo.
- `VITE_WHATSAPP_BOT_URL` ya no se usa.

### Un solo proyecto de Vercel con varios dominios de clientes

1. **Crear el proyecto:** en Vercel, *Add New → Project* e importar el repo
   `autoatento-frontend`. Framework: *Vite*. Build: `npm run build`. Output: `dist`.
2. **Variables** (*Settings → Environment Variables*, Production y Preview):
   - `VITE_API_URL=https://<backend>/api`.
   - No cargar `VITE_DEV_TENANT`.
3. **Dominios** (*Settings → Domains*):
   - Agregar el dominio de cada cliente (ej. `crm5alluma.com.ar`) y el del panel (ej. `panel.autoatento.com`).
   - **Todos apuntan al mismo proyecto**; no hace falta un proyecto por cliente.
4. **DNS de cada cliente:** cargar los registros que muestra Vercel al agregar el dominio:
   - **Dominio raíz** (`cliente.com.ar`): registro `A` a la IP que indique Vercel (hoy `76.76.21.21`).
   - **Subdominio** (`crm.cliente.com.ar`): `CNAME` a `cname.vercel-dns.com`.
   - El certificado HTTPS lo emite Vercel solo.
5. **`www`:** si el cliente usa `www.`, agregarlo también en Vercel con *Redirect* al dominio principal. El front normaliza `www.`, pero conviene un solo host.
6. **Registrar el dominio en el tenant:** en el panel, *General → Dominios*, cargar exactamente el mismo host. Sin eso el CRM muestra "Cuenta no encontrada".
7. **Panel:** se entra por `https://panel.autoatento.com/superadmin`. Cualquier dominio del proyecto sirve, porque `/superadmin` no depende del tenant.
8. **Deploys de preview** (`*.vercel.app`): no son dominios de ningún tenant y muestran "Cuenta no encontrada". Para probar un tenant en preview, agregar temporalmente el host de preview a sus dominios.
9. **Backend:** no hace falta tocar nada al sumar un dominio. CORS acepta cualquier origen con credenciales y el tenant sale del dominio. Si en el futuro se restringe CORS, hay que sumar cada dominio.

Agregar un cliente nuevo: alta en el panel (con su dominio) → agregar el dominio en Vercel → DNS del cliente. No hay redeploy.

## 8. Crear un tenant

**Desde el panel:** *Tenants → Nuevo tenant*, con dos modalidades:
- **Base nueva:** crea `crm_<slug>`, corre las migraciones y crea el owner.
- **Base existente:** se pega la connection string, con la opción de migrar en ese momento o después.

Si algo falla después de crear el schema, el schema se borra (rollback). Nunca
se borra una base que ya existía.

**Por API** (`POST /api/superadmin/tenants`):

```jsonc
// base nueva
{ "slug": "mi-cliente", "nombre": "Mi Cliente", "plan": "pro",
  "dominios": ["crm.micliente.com.ar"],
  "branding": { "nombre": "Mi Cliente Autos", "color_primario": "#cc0000", "logo_url": "https://..." },
  "modulos": { "motos": true },
  "config": { "timezone": "America/Argentina/Buenos_Aires", "marcas": ["fiat", "jeep"], "marca_default": "fiat",
              "wa_bot_url": "https://.../wa-micliente", "wa_bot_key": "...",
              "lead_api_keys": { "whatsapp-bot": "...", "sheet-emanuel": "..." } },
  "owner": { "email": "dueño@micliente.com", "password": "...", "name": "Dueño" } }

// base existente (ej. Fiat): sin owner, con o sin migrar en el momento
{ "slug": "fiat-autodelsol", "nombre": "Auto del Sol Fiat", "db_url": "mysql://...", "migrar": false, ... }
```

**Por línea de comandos** (mismo circuito; los secretos se cargan después desde el panel):

```bash
OWNER_PASSWORD='...' npm run tenant:add -- --slug mi-cliente --nombre "Mi Cliente" --plan pro \
  --create-schema --dominio crm.micliente.com.ar --owner-email dueño@micliente.com \
  --branding-nombre "Mi Cliente Autos" --color '#cc0000' --marca fiat --marca jeep

npm run tenant:add -- --slug fiat-autodelsol --nombre "Auto del Sol Fiat" --db-url 'mysql://...' --marca fiat --sin-migrar
```

```powershell
$env:OWNER_PASSWORD='...'; npm.cmd run tenant:add -- --slug mi-cliente --nombre "Mi Cliente" --plan pro `
  --create-schema --dominio crm.micliente.com.ar --owner-email dueño@micliente.com `
  --branding-nombre "Mi Cliente Autos" --color '#cc0000' --marca fiat --marca jeep
Remove-Item Env:OWNER_PASSWORD

npm.cmd run tenant:add -- --slug fiat-autodelsol --nombre "Auto del Sol Fiat" --db-url 'mysql://...' --marca fiat --sin-migrar
```

## 9. Migraciones

- **Archivos:** `migrations/NNN_descripcion.sql`, en orden. `000_baseline.sql`
  es el `database.sql` original de Fiat: todo `CREATE TABLE IF NOT EXISTS`, así
  que contra una base existente solo crea lo que falte.
- **Registro:** tabla `schema_migrations` **en cada base de tenant** (`version`,
  `checksum`, `applied_at`, `duration_ms`). Si un archivo ya aplicado cambia, el
  runner lo avisa como "modificada" pero no lo vuelve a correr.
- **Idempotencia:** lo aplicado no se repite, y cada archivo tiene que poder
  correrse dos veces sin romper nada. El DDL de MySQL no es transaccional: si
  una corrida se corta a la mitad, se vuelve a correr entera.
- **Motor:** todas las bases son MySQL 8 (Railway). Igual las migraciones evitan
  `ADD COLUMN IF NOT EXISTS` y usan chequeos contra `information_schema` + `PREPARE`:

  ```sql
  SET @existe := (SELECT COUNT(*) FROM information_schema.COLUMNS
                   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tabla' AND COLUMN_NAME = 'col');
  SET @sql := IF(@existe = 0, 'ALTER TABLE tabla ADD COLUMN col VARCHAR(20) NULL', 'SELECT 1');
  PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  ```
- **Concurrencia:** `GET_LOCK` por base: dos instancias no migran el mismo tenant a la vez.
- **Fallas aisladas:** un tenant que falla queda en el reporte con su error y el
  runner sigue con los demás. Lo aplicado antes de la falla queda registrado.

| Migración | Qué hace |
|---|---|
| `000_baseline` | Esquema del CRM (el `database.sql` de Fiat) |
| `001_agente_ia` | Tablas del Agente IA (antes las creaba `agent/schema.js` en cada arranque) |
| `002_wa_messages_sent_by` | Columna `wa_messages.sent_by` si no existe |
| `003_leads_marca_varchar` | `leads.marca` de `ENUM('fiat')` a `VARCHAR(30)`, sin default (la marca la pone el backend). Solo si sigue siendo ENUM; conserva los valores. **Reconstruye la tabla `leads`: correrla fuera de horario** |
| `004_user_logins` | Registro de logins, para el uso mensual |
| `005_recordatorios_completed_at` | Columna `recordatorios.completed_at` si no existe (la usa "completar recordatorio"; en una base nueva fallaba) |

```bash
npm run migrate                                        # tenants activos
npm run migrate -- --tenant fiat-autodelsol --dry-run  # solo muestra qué aplicaría
npm run migrate -- --incluir-suspendidos
npm run migrate -- --listar                            # versiones y checksums
```

```powershell
npm.cmd run migrate
npm.cmd run migrate -- --tenant fiat-autodelsol --dry-run
npm.cmd run migrate -- --incluir-suspendidos
npm.cmd run migrate -- --listar
```

- **Al arrancar:** con `AUTO_MIGRATE=1`, el server migra los tenants activos.
  Si uno falla, lo loguea y arranca igual.
- **Desde el panel:** pestaña *Base y migraciones* (ver pendientes / aplicar).
- **Agente IA:** si un tenant no está migrado, el agente de ese tenant avisa
  "faltan las tablas del agente" y el resto del CRM sigue andando.

Para agregar una migración: archivo nuevo con el número siguiente, idempotente,
probado contra una base nueva (`dev:seed`) y contra una vieja (`smoke:fase2`
simula una base como la de Fiat).

## 10. Panel superadmin

**Front:** `/superadmin` en cualquier dominio del proyecto de Vercel. Pantallas:
- login y lista de tenants (estado, plan, dominios, uso del mes);
- alta (base nueva o existente);
- detalle por pestañas: resumen y acciones, general, branding con vista previa, módulos, configuración, secretos y API keys de webhooks, base y migraciones, uso y bot, auditoría;
- uso de todos los tenants para facturar;
- auditoría general.

Está pensado para celular primero.

**Backend:** `/api/superadmin/*` (`superadmin/routes.js`), sin `resolveTenant` y con login propio:
- **Usuarios:** tabla `superadmins`, separados de los usuarios de cada CRM.
- **Token:** JWT con `SUPERADMIN_JWT_SECRET` (distinto de `JWT_SECRET`), `scope: 'superadmin'`, 12 h.
- **Fuerza bruta:** 5 intentos fallidos por IP+email bloquean 15 minutos.
- **Sin `SUPERADMIN_JWT_SECRET`** (o igual a `JWT_SECRET`): responde 503.

```bash
SUPERADMIN_PASSWORD='...' npm run superadmin:add -- --email vos@autoatento.com --nombre "Luca"
npm run superadmin:add -- --email alguien@autoatento.com --desactivar
```

```powershell
$env:SUPERADMIN_PASSWORD='...'; npm.cmd run superadmin:add -- --email vos@autoatento.com --nombre "Luca"
Remove-Item Env:SUPERADMIN_PASSWORD
npm.cmd run superadmin:add -- --email alguien@autoatento.com --desactivar
```

| Ruta | Qué hace |
|---|---|
| `POST /login` | `{ email, password }` → token |
| `GET /tenants` | Lista con uso del mes. Sin secretos: dice cuáles están cargados y la base con la contraseña enmascarada |
| `POST /tenants` | Alta (sección 8) |
| `GET /tenants/:id` | Detalle |
| `PATCH /tenants/:id` | `nombre`, `plan`, `dominios`, `branding`, `modulos`, `config`, `db_url`. `modulos` y `branding` se mezclan con lo guardado. En `config`, un valor pisa, `null` o `""` borra, y una clave ausente queda igual. Los secretos se cifran |
| `POST /tenants/:id/suspender` · `/reactivar` · `/baja` | Cambia el estado. Suspender y dar de baja cortan los sockets del tenant en el momento |
| `GET /tenants/:id/secretos/:clave` | Muestra un secreto (ej. `lead_api_keys` para configurar un Sheet). Queda auditado |
| `POST /tenants/:id/migrar` | Migra ese tenant (`{"dry_run": true}` para ver) |
| `GET /tenants/:id/uso?meses=6` | Uso del mes (recalculado), historial y estado del bot |
| `POST /tenants/:id/impersonar` | "Entrar como owner": token del CRM del tenant, 1 h, con `imp` (quién entró) |
| `GET /uso?mes=YYYY-MM&recalcular=1` | Uso de todos los tenants, para facturar |
| `GET /auditoria?tenant_id=&limit=` | Log de auditoría |

**Auditoría:**
- **Qué registra:** altas, ediciones (campos tocados, nunca valores secretos), cambios de estado (con sockets cortados y motivo), secretos vistos, migraciones e impersonaciones.
- **Datos de cada registro:** superadmin, IP y fecha.

**Suspender:**
- todas las requests reciben **402**;
- los sockets abiertos reciben `tenant:estado` y se cortan, y el CRM abierto muestra "Cuenta suspendida";
- la reconexión se rechaza;
- si se suspende por fuera del panel, el vigilante corta los sockets en hasta 30 s.

## 11. Uso mensual (facturación por usuario)

`autoatento_control.uso_mensual (tenant_id, mes, usuarios_activos, leads_ingresados)`:

- **`usuarios_activos`:** usuarios distintos que en el mes iniciaron sesión
  (`user_logins`) o usaron el CRM (`user_sessions`, conexiones del socket). No
  cuenta al usuario de sistema del agente ni las sesiones de soporte.
- **`leads_ingresados`:** leads con `created_at` dentro del mes.
- **Corte de mes: en la zona horaria del tenant.** El inicio y fin del mes local
  se convierten al reloj de la base (sea UTC o no) antes de comparar.
- **Cálculo:** una tarea horaria actualiza el mes en curso y, los primeros 3
  días del mes, también cierra el anterior. El panel puede forzar el recálculo.

**Estado del bot** (pestaña *Uso*):
- si tiene `wa_bot_url` y `wa_bot_key`;
- si la URL responde (GET de 3 segundos, sin mandar la key);
- las sesiones que el bot registra en `wa_sessions`.

## 12. Backup de secretos

Si se pierde **`TENANT_DB_KEY`**, no se pueden descifrar las connection
strings ni los secretos de **ningún** tenant (`db_url_cifrada`, `wa_bot_key`,
`lead_api_keys`, `openai_api_key`, `agent_mcp_key`). Las bases de los clientes
siguen intactas, pero hay que volver a cargar a mano cada connection string y
cada key.

**Qué guardar y dónde:**

| Secreto | Si se pierde | Backup |
|---|---|---|
| `TENANT_DB_KEY` | No se descifra nada de `tenants` | **Imprescindible.** En un gestor de contraseñas (1Password/Bitwarden) en una bóveda de la empresa, con al menos dos personas con acceso. Además, una copia offline (papel en lugar seguro o USB cifrado) |
| `JWT_SECRET` | Se cierran todas las sesiones de los CRMs; no se pierden datos | Gestor de contraseñas |
| `SUPERADMIN_JWT_SECRET` | Se cierran las sesiones del panel | Gestor de contraseñas |
| `CONTROL_DB_URL` / `TENANT_DB_SERVER_URL` | Se recuperan desde Railway | Opcional |
| Base `autoatento_control` | Se pierden los tenants, el uso y la auditoría | Backups de Railway + un dump periódico. **El dump solo sirve junto con `TENANT_DB_KEY`** |

**Reglas:**
- `TENANT_DB_KEY` no va en el repo, ni en Slack, ni por mail. Solo en las
  variables del deploy (Railway) y en el gestor de contraseñas.
- Un dump de `autoatento_control` tiene los secretos cifrados: se guarda como
  cualquier backup, pero **nunca junto con la key**.
- Cada tanto, probar la restauración: backend local con la key del gestor y un
  dump reciente, y `npm.cmd run migrate -- --dry-run`. Si lista los tenants sin
  errores de descifrado, el backup sirve.

### Rotar `TENANT_DB_KEY` (sin corte de servicio)

`npm run rotate-key` re-cifra `db_url_cifrada` y todos los secretos de config.
Usa `TENANT_DB_KEY_ANTERIOR` como key vieja y `TENANT_DB_KEY` como nueva.
- **Atomicidad:** todo en **una transacción** con las filas bloqueadas; antes de confirmar verifica que cada valor nuevo se descifre igual. Si algo falla, no cambia nada.
- **Idempotente:** lo que ya está con la key nueva queda como está.

1. **Generar la key nueva** y guardarla en el gestor de contraseñas:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. **Deploy de transición** en Railway: `TENANT_DB_KEY=<nueva>` y
   `TENANT_DB_KEY_ANTERIOR=<vieja>`. El backend descifra con las dos y cifra con la nueva.
3. **Correr la rotación** contra la base de control de producción (local con esas dos variables, o en Railway):
   ```bash
   TENANT_DB_KEY='<nueva>' TENANT_DB_KEY_ANTERIOR='<vieja>' npm run rotate-key -- --dry-run
   TENANT_DB_KEY='<nueva>' TENANT_DB_KEY_ANTERIOR='<vieja>' npm run rotate-key
   ```
   ```powershell
   $env:TENANT_DB_KEY='<nueva>'; $env:TENANT_DB_KEY_ANTERIOR='<vieja>'
   npm.cmd run rotate-key -- --dry-run
   npm.cmd run rotate-key
   Remove-Item Env:TENANT_DB_KEY, Env:TENANT_DB_KEY_ANTERIOR
   ```
4. **Sacar `TENANT_DB_KEY_ANTERIOR`** del deploy.

**Si la key se perdió de verdad:**
1. Generar una nueva y ponerla en el deploy.
2. Por cada tenant, desde el panel: *Base y migraciones → Cambiar base* y *Secretos* (cada uno).
3. Las keys de webhooks se recuperan de los Apps Script y de Zapier; la del bot, del `.env` del bot.

## 13. Tests de aislamiento

`npm test` (`npm.cmd test` en PowerShell) corre `test/aislamiento.test.js` con `node:test` + `supertest` + `socket.io-client`.

**Entorno propio** (`testing/entorno.js`):
- **Qué crea:** `crm_test_<run>_a` y `crm_test_<run>_b` (slugs `test-<run>-a` / `-b`), con migraciones, owner y datos marcados con el id de la corrida, más un superadmin `test-<run>@autoatento.test`.
- **Limpieza:** borra todo eso al terminar, y al arrancar limpia restos de corridas cortadas (solo `crm_test_*`, tenants `test-*` y superadmins `test-*@autoatento.test`).
- **No toca** `tenant-a` ni `tenant-b`.

**Server real:** se levanta en un puerto libre con estas variables (solo para tests):
- `TENANTS_SOLO_PREFIJO=test-<run>-`: las tareas en segundo plano procesan solo los tenants de la corrida, no los de `dev:seed`;
- `ACCEPTANCE_CHECK_MS=2000`: el checker de aceptación corre cada 2 s en vez de 30 s;
- (ya no hace falta `TZ`: ver "Fechas y zonas horarias" más abajo).

**Qué cubre (51 tests):**

| Área | Casos |
|---|---|
| Resolución | Sin `X-Tenant` → 400; inexistente → 404; `/public/tenant` sin secretos |
| JWT | `tid` firmado; token de A en B y de B en A → 401; token sin `tid` → 401; mismo email en dos tenants da usuarios distintos |
| Datos | A y B ven solo lo suyo en leads, lead por id, notas, alertas, tareas, `wa_messages`, recordatorios, `agent_actions` y usuarios; un id que solo existe en B da 404 en A; una nota creada en A no aparece en B con el mismo id de lead; la key de webhook de A no sirve en B |
| Sockets | Token de A pidiendo B → rechazado; sin tenant → rechazado; `lead:created` de A llega a A y no a B; presencia separada |
| Tareas en segundo plano | El checker de aceptación pasa cada oferta vencida al otro vendedor **de su tenant**; el scanner genera la alerta del recordatorio vencido en su tenant y con sus datos |
| Módulos | `metas` apagado en B → 403 (y 200 en A) |
| Suspensión | 402 en B, sockets de B cortados en el momento, reconexión rechazada, A sigue andando, reactivar vuelve a 200 |
| Superadmin | Sin token → 401; contraseña mala → 401; token de un owner → 401 (con o sin `X-Tenant`); el token del panel no sirve en un CRM; la lista no expone secretos |
| Tenancy | `db` sin tenant → `NO_TENANT`; `emitTenant` sin tenant descarta; el server no logueó ninguna consulta sin tenant |

**Fechas y zonas horarias** (no depende de la zona del proceso de Node):
- **Vencimientos y comparaciones con "ahora":** se calculan en MySQL (`NOW() + INTERVAL`, `acceptance_expires_at < NOW()`, `completed_at = NOW()`).
- **mysql2:** usa `timezone: 'Z'` (las bases guardan UTC). Es lo mismo que pasaba en Railway con el proceso en UTC, pero ahora también vale en una PC en hora de Argentina.
- **Fechas "de calendario" del tenant** (recordatorios, horarios, corte de mes): usan la zona horaria del tenant (`nowInTz`).
- **Tests:** 53 tests pasan sin `TZ=UTC`, con el proceso en `America/Buenos_Aires`. Hay un test que verifica que una oferta pasada a otro vendedor no siga rotando.

## 14. Migrar un cliente existente

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
   actuales (`LEAD_API_KEYS` del deploy viejo) se cargan en `lead_api_keys` y siguen sirviendo.
4. **Bot de WhatsApp:** `wa_bot_url` y `wa_bot_key` se cargan en la config del
   tenant. Ya no hay default al bot de Fiat, ni `VITE_WHATSAPP_BOT_URL` en el front.
5. **Marcas:** cargar `marcas: ["fiat"]` y `marca_default: "fiat"`. Sin eso, los
   leads nuevos de webhooks quedan con marca vacía.
6. **`DIST_EXCLUIDOS`** pasa a `config.dist_excluidos`.
7. **`AGENT_MCP_KEY`** pasa a `config.agent_mcp_key`, y la URL del MCP pasa a `/api/t/<slug>/mcp`.
8. **`/api/calls`, `/api/metas` y `/api/users`** piden token.
9. **Cookie de sesión:** pasa a llamarse `session_<slug>`. El front usa el token del header, así que no debería notarse.
10. **Migraciones sobre la base de Fiat:**
    - `000` a `002` no cambian nada: las tablas y la columna ya existen.
    - `003` pasa `leads.marca` a `VARCHAR(30)` y reconstruye `leads`: **correrla fuera de horario**.
    - `004` agrega `user_logins`.
    - Se puede registrar el tenant sin migrar y correr el dry-run antes.
11. **Front:** el dominio `crm5alluma.com.ar` pasa al proyecto único de Vercel (sección 7), y el branding se carga en el panel.

## 15. Bot de WhatsApp (fuera de alcance)

Cada tenant sigue con su bot propio (Baileys en el droplet), configurado con
`wa_bot_url` y `wa_bot_key`. El bot escribe directo en la base del tenant y le
manda leads al webhook del tenant. Si el bot manda `marca` en el payload, se
respeta según las marcas del tenant.

La pantalla *WhatsApp Admin* habla con la API del bot. La lista de modelos y
videos que muestra es la del bot de Fiat (`WhatsAppAdminFiat.tsx`): sirve para
bots con esa API y queda por revisar cuando se migre otro clon.

Para pasar a un bot multi-tenant haría falta:
- **Datos:** sesiones de Baileys con `tenant_id` y escritura por la API del CRM, en vez de conexión directa a la base;
- **Webhook:** un webhook entrante único, que resuelva el tenant por el número receptor;
- **Configuración:** prompt e IA del bot por tenant;
- **Alternativa:** la API oficial de WhatsApp Cloud, con el tenant resuelto por `phone_number_id`.

## 16. Bugs previos detectados

**Corregidos en autoatento y en el repo de producción de Fiat:**
- `GET /api/leads/unassigned` y `/distribution` quedaban tapadas por `/:id`.
- `GET /api/activity/reassignments` daba 500 en MySQL 8.0.22 o posterior (`LIMIT ?` con `execute()`).
- `CallPanel.tsx` hacía POST a `/api/api/calls` (404 silencioso).

- `DistribucionLeads.tsx` llamaba a `/api/api/distribution` (el panel de reparto de "Mi Equipo" daba 404).
- `LeadAcceptanceModal.tsx` usaba URLs relativas (`/api/leads/...`), que iban al dominio del front. Ojo: ese componente no está montado en el CRM, así que el flujo de aceptar/rechazar ofertas no se usa hoy.

**Corregidos solo en autoatento:**
- `POST /api/leads` sin `modelo` respondía 500; ahora responde 400 "Faltan datos obligatorios: modelo".
- Un login con contraseña mala recargaba la página (`api.ts` recargaba ante cualquier 401) y el error casi no se veía; ahora se muestra "Credenciales inválidas".

**Pendientes:**
- Al desconectarse, el log del socket muestra `Usuario desconectado: undefined` porque el JWT no lleva `name`. Es solo cosmético.
- En el front de producción de Fiat, el socket solo se conecta si había un token al cargar la página (en autoatento ya está resuelto).

## 17. Pendiente

- **Fase 5:** plan de migración de Fiat y checklist para comparar los otros clones.
- **`multi_marca`, `motos` y `scoring`:** los flags existen, pero el CRM base no tiene pantallas para eso (por ejemplo, un selector de marca al cargar un lead). **Decisión: se definen cuando se migre GoldPlan.**
- **Admin del bot por tenant** (sección 14).
