# AutoAtento — arquitectura multi-tenant

Un solo backend y un solo frontend para todos los clientes (tenants), con
**una base de datos por tenant**. Las queries de las rutas no cambian: cada
request corre "dentro" de un tenant y `require('../db')` va al pool de ese
tenant. Un `WHERE` olvidado no puede filtrar datos entre clientes porque cada
cliente está en otra base.

> Estado: **Fases 1 a 5 terminadas** (la 5 es documentación: nada se ejecutó en producción):
> - base multi-tenant del backend;
> - migraciones, panel superadmin y uso mensual;
> - frontend único y pantalla `/superadmin`;
> - tests de aislamiento.
>
> Fase 5: plan de migración y runbook de producción en la sección 14 (sin ejecutar). Cómo correr todo: [README.md](README.md).

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
| `tenancy/pools.js` | Pool de mysql2 por tenant, creado al primer uso (`TENANT_POOL_LIMIT`, 2 por defecto: ver sección 15). Se cierra a los 30 min sin uso y se recrea si cambia la `db_url` |
| `tenancy/crypto.js` | AES-256-GCM con `TENANT_DB_KEY` (formato `v1:iv:tag:datos`). Con `TENANT_DB_KEY_ANTERIOR` también descifra con la key vieja (rotación) |
| `tenancy/control.js` | Pool de la base de control y su esquema (`control/schema.sql`) |
| `tenancy/registry.js` | Lee `tenants` con caché (`TENANT_CACHE_TTL_MS`, 30 s). Los secretos descifrados quedan en un `WeakMap`, nunca en el objeto `tenant` |
| `tenancy/middleware.js` | `tenantPathRewrite`, `resolveTenant`, `requireModulo`, `GET /api/public/tenant`, `rebindTenant` |
| `tenancy/subdominios.js` | Subdominios automáticos `<slug>.<BASE_DOMAIN>`, slugs reservados y reglas del slug de un tenant nuevo |
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

**Cómo se resuelve el host** (`registry.getByHost`, en ese orden):
1. **Dominio propio** cargado en `tenants.dominios` (ej. `crm5alluma.com.ar`), con o sin `www.`.
2. **Subdominio automático** `<slug>.<BASE_DOMAIN>` (ej. `demo-norte.autoatento.com.ar`): no se carga en ningún lado, alcanza con que exista el tenant. Un solo nivel (`a.b.autoatento.com.ar` no resuelve). Sin `BASE_DOMAIN` no hay subdominios automáticos.
3. **Desarrollo:** fuera de `NODE_ENV=production`, también `<slug>.localhost`.
4. **No son tenants** (404): el dominio base, `www.<base>` y los subdominios reservados (`www`, `api`, `app`, `admin`, `superadmin`, `panel`, `mail`, ...; la lista está en `tenancy/subdominios.js`).

**Slug de un tenant nuevo** (panel y `tenant:add`): tiene que servir como subdominio. Minúsculas, números y guiones, hasta 60 caracteres, sin guion al principio ni al final ni dos seguidos, y que no sea reservado. Los tenants que ya existen no se revalidan.

**Dominios propios:** un subdominio de `BASE_DOMAIN` no se puede cargar como dominio propio (400): ya funciona solo, y así nadie le "pisa" el subdominio a otro tenant.

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
npm run dev:seed       # BORRA y recrea crm_demo-norte y crm_demo-sur (schema + migraciones + owner + datos)
npm run smoke          # aislamiento entre tenants, módulos y marcas (54 checks)
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

**Frontend** (`autoatento-frontend`, `.env` con `VITE_API_URL=http://localhost:3001/api` y `VITE_DEV_TENANT=demo-norte`):

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
- `http://localhost:5173/?tenant=demo-sur`: cambia de tenant (queda guardado en la pestaña).
- `http://demo-sur.localhost:5173`: resuelve por host, como en producción (`<slug>.localhost` es el subdominio automático de desarrollo; anda para cualquier tenant).

**Tenants de `dev:seed`** (contraseña `DEV_TENANT_PASSWORD`; usuarios `owner@`, `gerente@`, `super@`, `vend1@` y `vend2@demo.test`):

| Slug | Nombre | Diferencias | Dominio propio simulado |
|---|---|---|---|
| `demo-norte` | Concesionaria Demo Norte | marca `fiat`, todos los módulos; datos con la palabra "Norte" | `crm.demo-norte.test` |
| `demo-sur` | Concesionaria Demo Sur | marcas `peugeot` y `citroen`, zona Montevideo, sin Agente IA ni Metas; datos con "Sur" | `crm.demo-sur.test` |

El dominio propio simulado sirve para probar la API (`?host=crm.demo-norte.test`); en el navegador no resuelve.
- `http://localhost:5173/superadmin`: el panel. Para tener un usuario, ver la sección 10.

**Pedidos a mano** (bash):

```bash
curl -s "localhost:3001/api/public/tenant?host=demo-norte.localhost"
TOKEN=$(curl -s -X POST localhost:3001/api/auth/login -H 'X-Tenant: demo-norte' -H 'Content-Type: application/json' \
  -d '{"email":"owner@demo.test","password":"<DEV_TENANT_PASSWORD>"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s localhost:3001/api/leads -H 'X-Tenant: demo-norte' -H "Authorization: Bearer $TOKEN"
curl -s localhost:3001/api/leads -H 'X-Tenant: demo-sur' -H "Authorization: Bearer $TOKEN"   # 401
```

Pedidos a mano (PowerShell 5):

```powershell
Invoke-RestMethod "http://localhost:3001/api/public/tenant?host=demo-norte.localhost"
$login = Invoke-RestMethod -Method Post http://localhost:3001/api/auth/login -Headers @{ 'X-Tenant'='demo-norte' } `
  -ContentType 'application/json' -Body '{"email":"owner@demo.test","password":"<DEV_TENANT_PASSWORD>"}'
Invoke-RestMethod http://localhost:3001/api/leads -Headers @{ 'X-Tenant'='demo-norte'; Authorization="Bearer $($login.token)" }
Invoke-RestMethod http://localhost:3001/api/leads -Headers @{ 'X-Tenant'='demo-sur'; Authorization="Bearer $($login.token)" }   # 401
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
1. El panel abre `https://<slug>.<BASE_DOMAIN>/#imp=<token>&u=<usuario>` (o el primer dominio propio, si no hay `BASE_DOMAIN`). El token viaja en el fragmento (`#`), que el navegador no manda a ningún servidor.
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
   - Agregar el dominio de cada cliente (ej. `crm5alluma.com.ar`) y el del panel (`app.autoatento.com.ar`, o el wildcard `*.autoatento.com.ar`: ver abajo).
   - **Todos apuntan al mismo proyecto**; no hace falta un proyecto por cliente.
4. **DNS de cada cliente:** cargar los registros que muestra Vercel al agregar el dominio:
   - **Dominio raíz** (`cliente.com.ar`): registro `A` a la IP que indique Vercel (hoy `76.76.21.21`).
   - **Subdominio** (`crm.cliente.com.ar`): `CNAME` a `cname.vercel-dns.com`.
   - El certificado HTTPS lo emite Vercel solo.
5. **`www`:** si el cliente usa `www.`, agregarlo también en Vercel con *Redirect* al dominio principal. El front normaliza `www.`, pero conviene un solo host.
6. **Registrar el dominio en el tenant:** en el panel, *General → Dominios propios*, cargar exactamente el mismo host. Sin eso el CRM muestra "Cuenta no encontrada". (Los subdominios `<slug>.autoatento.com.ar` no se cargan: ver abajo.)
7. **Panel:** se entra por `https://app.autoatento.com.ar/superadmin`. Cualquier dominio del proyecto sirve, porque `/superadmin` no depende del tenant.
8. **Deploys de preview** (`*.vercel.app`): no son dominios de ningún tenant y muestran "Cuenta no encontrada". Para probar un tenant en preview, agregar temporalmente el host de preview a sus dominios.
9. **Backend:** no hace falta tocar nada al sumar un dominio. CORS acepta cualquier origen con credenciales y el tenant sale del dominio. Si en el futuro se restringe CORS, hay que sumar cada dominio.

Agregar un cliente nuevo: alta en el panel y listo, entra por `https://<slug>.autoatento.com.ar` (con el wildcard de abajo ya configurado). Si además quiere su dominio propio: cargarlo en el panel → agregarlo en Vercel → DNS del cliente. No hay redeploy.

### Subdominios automáticos: wildcard `*.autoatento.com.ar` en Vercel

Se configura **una sola vez**. Después, cada tenant nuevo tiene `https://<slug>.autoatento.com.ar` con HTTPS sin tocar Vercel ni el DNS.

**Requisito de Vercel:** un dominio wildcard solo se puede verificar y certificar si **el DNS de `autoatento.com.ar` lo maneja Vercel** (método de nameservers). El certificado `*.autoatento.com.ar` sale por desafío DNS-01, y para eso Vercel tiene que poder escribir registros en la zona. Con un `CNAME` suelto no alcanza.

1. **Antes de mover el DNS, inventario de la zona actual.** En el proveedor de DNS de hoy, anotar todos los registros de `autoatento.com.ar`: `MX` y `TXT` (mail, SPF, DKIM, verificaciones de Google, etc.), el `CNAME` del backend (`api`) y cualquier otro. Si no se recrean en Vercel, **se corta el mail**.
2. **Vercel → *Domains*** (del equipo, no del proyecto) → *Add* `autoatento.com.ar`. Vercel muestra sus nameservers: `ns1.vercel-dns.com` y `ns2.vercel-dns.com`.
3. **Recrear los registros del paso 1** en *Domains → autoatento.com.ar → DNS Records*. En particular:
   - `api` → `CNAME` al destino que indica Railway para el dominio propio del backend. Un registro explícito le gana al wildcard, así que `api.autoatento.com.ar` sigue yendo a Railway (y Railway emite su propio certificado).
   - `MX` / `TXT` del mail, tal cual estaban.
4. **NIC Argentina** (`.com.ar`): en nic.ar → *Mis dominios → autoatento.com.ar → Delegaciones*, reemplazar los DNS actuales por `ns1.vercel-dns.com` y `ns2.vercel-dns.com`. La propagación puede tardar unas horas; mientras tanto conviven los DNS viejos y los nuevos (por eso el paso 3 va antes).
5. **Proyecto `autoatento-frontend` → *Settings → Domains → Add*** `*.autoatento.com.ar`. Con los nameservers ya en Vercel, lo verifica solo y emite el certificado wildcard (Let's Encrypt). La renovación también es automática.
6. **Panel:** agregar `app.autoatento.com.ar` al mismo proyecto (o usar cualquier subdominio) y entrar por `https://app.autoatento.com.ar/superadmin`. `app` es un slug reservado: la raíz de ese host dice "Cuenta no encontrada", pero `/superadmin` no depende del tenant.
7. **Backend (Railway):** variable `BASE_DOMAIN=autoatento.com.ar` y redeploy. Sin esa variable el backend no resuelve los subdominios (responde "Cuenta no encontrada").
8. **Verificar:**

```powershell
Resolve-DnsName demo.autoatento.com.ar                       # IPs de Vercel
Invoke-RestMethod "https://api.autoatento.com.ar/api/public/tenant?host=demo.autoatento.com.ar"   # slug demo
```

   Y en el navegador, `https://demo.autoatento.com.ar`: el candado tiene que mostrar un certificado para `*.autoatento.com.ar`.

**Notas:**
- El wildcard cubre un solo nivel: `demo.autoatento.com.ar` sí, `x.demo.autoatento.com.ar` no (el backend tampoco los acepta).
- La raíz `autoatento.com.ar` y `www` no son tenants. Si hay una landing, va en otro proyecto de Vercel con esos dos dominios; el wildcard puede quedar en el proyecto del CRM.
- **Si no se quiere mover el DNS a Vercel:** no hay wildcard. Se puede cargar cada subdominio a mano como un dominio más (un `CNAME` a `cname.vercel-dns.com` por cliente en el DNS actual + *Add* en Vercel); el backend lo resuelve igual por `BASE_DOMAIN`, sin cargarlo en el tenant.

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
- **No toca** `demo-norte` ni `demo-sur`.

**Server real:** se levanta en un puerto libre con estas variables (solo para tests):
- `TENANTS_SOLO_PREFIJO=test-<run>-`: las tareas en segundo plano procesan solo los tenants de la corrida, no los de `dev:seed`;
- `ACCEPTANCE_CHECK_MS=2000`: el checker de aceptación corre cada 2 s en vez de 30 s;
- `BASE_DOMAIN=autoatento.test`: para probar los subdominios automáticos;
- (ya no hace falta `TZ`: ver "Fechas y zonas horarias" más abajo).

**Qué cubre (61 tests):**

| Área | Casos |
|---|---|
| Resolución | Sin `X-Tenant` → 400; inexistente → 404; `/public/tenant` sin secretos |
| Subdominios | `<slug>.BASE_DOMAIN` resuelve sin cargarlo (mayúsculas y puerto incluidos); el dominio propio sigue andando; `<slug>.localhost` en desarrollo; base, `www`, reservados, dos niveles y slug inexistente → 404 |
| JWT | `tid` firmado; token de A en B y de B en A → 401; token sin `tid` → 401; mismo email en dos tenants da usuarios distintos |
| Datos | A y B ven solo lo suyo en leads, lead por id, notas, alertas, tareas, `wa_messages`, recordatorios, `agent_actions` y usuarios; un id que solo existe en B da 404 en A; una nota creada en A no aparece en B con el mismo id de lead; la key de webhook de A no sirve en B |
| Sockets | Token de A pidiendo B → rechazado; sin tenant → rechazado; `lead:created` de A llega a A y no a B; presencia separada |
| Tareas en segundo plano | El checker de aceptación pasa cada oferta vencida al otro vendedor **de su tenant**; el scanner genera la alerta del recordatorio vencido en su tenant y con sus datos |
| Módulos | `metas` apagado en B → 403 (y 200 en A) |
| Suspensión | 402 en B, sockets de B cortados en el momento, reconexión rechazada, A sigue andando, reactivar vuelve a 200 |
| Superadmin | Sin token → 401; contraseña mala → 401; token de un owner → 401 (con o sin `X-Tenant`); el token del panel no sirve en un CRM; la lista no expone secretos y trae la URL por subdominio; `/config` da el dominio base; alta con slug que no sirve como subdominio (mayúsculas, guion al borde, `--`, reservado, más de 60) → 400; alta con un subdominio de `BASE_DOMAIN` como dominio propio → 400 |
| Tenancy | `db` sin tenant → `NO_TENANT`; `emitTenant` sin tenant descarta; el server no logueó ninguna consulta sin tenant |

**Fechas y zonas horarias** (no depende de la zona del proceso de Node):
- **Vencimientos y comparaciones con "ahora":** se calculan en MySQL (`NOW() + INTERVAL`, `acceptance_expires_at < NOW()`, `completed_at = NOW()`).
- **mysql2:** usa `timezone: 'Z'` (las bases guardan UTC). Es lo mismo que pasaba en Railway con el proceso en UTC, pero ahora también vale en una PC en hora de Argentina.
- **Fechas "de calendario" del tenant** (recordatorios, horarios, corte de mes): usan la zona horaria del tenant (`nowInTz`).
- **Tests:** todos pasan sin `TZ=UTC`, con el proceso en `America/Buenos_Aires`. Hay un test que verifica que una oferta pasada a otro vendedor no siga rotando.

## 14. Runbook de puesta en producción

> **Nada de esto se ejecutó.** Son los pasos para hacerlo vos.
>
> **Convenciones:**
> - Los comandos son de **PowerShell 5**: `npm.cmd`, `$env:VAR`, y `--result-file` en vez de `>`.
> - Los comandos que van **dentro del contenedor de Railway** (`railway ssh`) son de `sh` (Linux).
> - `<...>` es un valor tuyo.
> - Nunca pegues secretos en archivos versionados ni en chats.

### 14.1 Repos privados en GitHub

Creá vos dos repos **privados y vacíos** (sin README ni .gitignore): `autoatento-backend` y `autoatento-frontend`. Después, en PowerShell:

```powershell
cd C:\Users\lucac\Downloads\autoatento\autoatento-backend
git status                       # tiene que estar limpio
git remote add origin https://github.com/<usuario-u-org>/autoatento-backend.git
git push -u origin main

cd ..\autoatento-frontend
git status
git remote add origin https://github.com/<usuario-u-org>/autoatento-frontend.git
git push -u origin main
```

Antes de pushear, confirmá que no sube nada sensible (no tiene que listar nada):

```powershell
git ls-files | Select-String -Pattern '(^|/)\.env($|\.(?!example$))|\.sql\.gz$|\.dump$|auth_info'
```

`.env.example` sí está versionado: es la plantilla, sin valores.

### 14.2 Railway: backend + MySQL de control

**Proyecto nuevo** (separado del de Fiat): *New Project*.

1. ***+ New → Database → MySQL*.** Llamalo `mysql-control`. Va a tener `autoatento_control` y los schemas `crm_<slug>` de los clientes nuevos.
2. ***+ New → GitHub Repo → autoatento-backend*.** Railway lee `railway.json`:
   - build con el `Dockerfile` (Node 22);
   - `npm start`;
   - healthcheck `GET /api/health`;
   - reinicio si falla;
   - **1 réplica** (los sockets, la presencia y el worker del agente viven en memoria; para más réplicas haría falta un adapter de Redis para Socket.io).
3. **Variables** del servicio backend (*Variables → Raw Editor*):

| Variable | Valor | Nota |
|---|---|---|
| `NODE_ENV` | `production` | |
| `CONTROL_DB_URL` | `mysql://${{mysql-control.MYSQLUSER}}:${{mysql-control.MYSQLPASSWORD}}@${{mysql-control.MYSQLHOST}}:${{mysql-control.MYSQLPORT}}/autoatento_control` | Red privada de Railway. La base se crea sola en el primer arranque |
| `TENANT_DB_SERVER_URL` | `mysql://${{mysql-control.MYSQLUSER}}:${{mysql-control.MYSQLPASSWORD}}@${{mysql-control.MYSQLHOST}}:${{mysql-control.MYSQLPORT}}/` | Donde se crean los `crm_<slug>` nuevos |
| `TENANT_DB_KEY` | 64 hex nuevos | **Guardarla antes en el gestor de contraseñas** (sección 12) |
| `JWT_SECRET` | secreto nuevo, largo | **No reusar** el del backend viejo de Fiat |
| `SUPERADMIN_JWT_SECRET` | otro secreto nuevo | Distinto de `JWT_SECRET` |
| `OPENAI_API_KEY` | la key de OpenAI | Key global del Agente IA (cada tenant puede tener la suya) |
| `JWT_EXPIRES_IN` | `7d` | Opcional |
| `AUTO_MIGRATE` | `0` | Las migraciones de clientes con datos se corren a mano (14.4) |
| `BASE_DOMAIN` | `autoatento.com.ar` | Subdominios automáticos `<slug>.autoatento.com.ar` (wildcard en Vercel: sección 7) |

   Opcionales: `AGENT_PROVIDER`, `AGENT_MODEL`, `ANTHROPIC_API_KEY`, `AGENT_CONCURRENCY`, `TENANT_POOL_LIMIT` (default 2, ver sección 15), `TENANT_CACHE_TTL_MS`.

   **No cargar en producción:**
   - `PORT` (lo pone Railway);
   - `DEV_MYSQL_URL` y `DEV_TENANT_PASSWORD`;
   - `TZ` (ya no hace falta);
   - `WA_BOT_URL`, `WA_BOT_KEY`, `LEAD_API_KEYS`, `AGENT_MCP_KEY`, `DIST_EXCLUIDOS`, `DATABASE_URL` y `DB_*` (todo eso va por tenant);
   - `TENANTS_SOLO_PREFIJO` y `ACCEPTANCE_CHECK_MS` (solo tests);
   - `AGENT_DISABLED`;
   - `TENANT_DB_KEY_ANTERIOR` (solo durante una rotación).

   Generar secretos en PowerShell (uno por vez, y pegarlos directo en Railway y en el gestor):

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # TENANT_DB_KEY
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # JWT_SECRET / SUPERADMIN_JWT_SECRET
```

4. **Dominio del backend.** En *Settings → Networking*, *Generate Domain* o un dominio propio (ej. `api.autoatento.com.ar`, con el `CNAME` que indique Railway; si el DNS ya está en Vercel, ese `CNAME` se carga ahí).
5. **Primer deploy y verificación.**
   - Los logs tienen que mostrar `Base de control "autoatento_control" creada` y `Base de control OK`.
   - La prueba:

```powershell
Invoke-RestMethod https://<backend>/api/health    # { ok: True, ts: ... }
```

6. **Superadmin.** Se crea dentro del contenedor, así no hace falta exponer la base. Con la CLI de Railway (v4 o más nueva):

```powershell
npm.cmd install -g @railway/cli
railway login
cd C:\Users\lucac\Downloads\autoatento\autoatento-backend
railway link            # elegir el proyecto y el servicio del backend
railway ssh             # abre una shell (sh) dentro del contenedor
```
```sh
# dentro del contenedor:
SUPERADMIN_PASSWORD='<contraseña de 12+ caracteres>' npm run superadmin:add -- --email <vos@autoatento.com> --nombre "Luca"
exit
```

   **Alternativa sin `railway ssh`:** correrlo desde tu PC contra la URL **pública** de `mysql-control` (*Variables → MYSQL_PUBLIC_URL*), en una ventana nueva de PowerShell:

```powershell
$env:CONTROL_DB_URL = '<MYSQL_PUBLIC_URL de mysql-control, cambiando /railway por /autoatento_control>'
$env:SUPERADMIN_PASSWORD = '<contraseña>'
npm.cmd run superadmin:add -- --email <vos@autoatento.com> --nombre "Luca"
Remove-Item Env:CONTROL_DB_URL, Env:SUPERADMIN_PASSWORD
```

### 14.3 Vercel: un proyecto para el front

1. ***Add New → Project* → `autoatento-frontend`.** Framework Vite, build `npm run build`, output `dist`. `vercel.json` ya tiene el rewrite SPA.
2. **Variables** (*Production* y *Preview*):
   - `VITE_API_URL=https://<backend>/api`.
   - Nada más; **no** cargar `VITE_DEV_TENANT`.
3. **Deploy.** Configurar el wildcard `*.autoatento.com.ar` y `app.autoatento.com.ar` (sección 7, "Subdominios automáticos") y entrar a `https://app.autoatento.com.ar/superadmin` con el superadmin. Mientras el DNS no esté listo, el panel también anda en `https://<proyecto>.vercel.app/superadmin`.
4. **Dominios propios de clientes** (opcional, además del subdominio): ver la sección 7.
   - En Vercel: *Settings → Domains → Add*.
   - DNS del cliente: `A` a la IP que indique Vercel para un dominio raíz, o `CNAME` a `cname.vercel-dns.com` para un subdominio.
   - En el panel: el mismo host en *General → Dominios propios*.
5. **Prueba de punta a punta con un tenant demo** (recomendado antes del Día D):
   1. En el panel, *Nuevo tenant → Base nueva*: slug `demo`, sin dominios propios. El panel muestra la URL: `https://demo.autoatento.com.ar`.
   2. Nada que agregar en Vercel: lo cubre el wildcard.
   3. Entrar con el owner y probar login, alta de lead, sockets y "entrar como owner".

### 14.4 Día D de Fiat

**Idea general:** el backend nuevo apunta a **la misma MySQL de Fiat** (base existente). Durante la transición, el backend viejo y el nuevo usan la misma base, así que **no se pierde nada si hay que volver**.

Está probado que el backend viejo funciona igual con la base ya migrada: login, lecturas, alta de lead, webhook viejo y completar recordatorio, 15 de 15 contra una base con las migraciones 000 a 005.

#### Preparación (días antes, sin tocar la producción de Fiat salvo lecturas)

1. **Inventario del deploy viejo.**
   - **Backend de Fiat en Railway** (*Variables*): anotar `LEAD_API_KEYS` (formato `proveedor:clave;proveedor2:clave2`), `WA_BOT_URL`, `WA_BOT_KEY`, `DIST_EXCLUIDOS` y `AGENT_MCP_KEY`.
   - **Front viejo:** `VITE_WHATSAPP_BOT_URL`.
   - **Bot (droplet):** la variable del `.env` con la URL del webhook del CRM (la que termina en `/api/webhooks/whatsapp-bot`) y la key que manda.
   - **Integraciones:** la lista de Google Sheets (Apps Script) y Zaps que mandan leads.
2. **URL de la MySQL de Fiat.** En el proyecto viejo, servicio MySQL → *Variables → `MYSQL_PUBLIC_URL`* (el backend nuevo está en otro proyecto y entra por el proxy público).
   - Tiene costo de egress y algo más de latencia. Más adelante se puede mover la base al proyecto nuevo.
3. **Comparar esquema** (solo lectura) y revisar el informe:

```powershell
cd C:\Users\lucac\Downloads\autoatento\autoatento-backend
npm.cmd run comparar-esquema -- --clon '<MYSQL_PUBLIC_URL de Fiat>' --referencia demo --salida fiat-vs-autoatento.md
```

   Se espera que le falten `schema_migrations` y `user_logins`, y quizás `recordatorios.completed_at` (las agregan las migraciones), y que `leads.marca` sea ENUM (lo cambia la 003). Cualquier otra diferencia: revisarla antes del Día D. **No subas `fiat-vs-autoatento.md` al repo.**

4. **Registrar el tenant** en el panel: *Nuevo tenant → Base existente*.
   - slug `fiat-autodelsol`, nombre `Auto del Sol Fiat`, plan, zona `America/Argentina/Buenos_Aires`;
   - dominio propio: `crm5alluma.com.ar` (para probar antes del cambio de dominio está el subdominio automático `https://fiat-autodelsol.autoatento.com.ar`);
   - marcas `fiat`;
   - URL del bot = `WA_BOT_URL` viejo (o `https://api.crmalluma.com.ar/wa-fiat`);
   - connection string = `MYSQL_PUBLIC_URL` de Fiat;
   - **destildar "Correr las migraciones ahora"**;
   - sin owner (ya existe en la base);
   - branding: el que quieras mostrar (el front viejo decía "Alluma").
5. **Suspenderlo enseguida** (*Resumen → Suspender*, motivo "pre-migración"). Así el backend nuevo no corre tareas en segundo plano sobre la base de Fiat antes de tiempo.
6. **Secretos** en *Secretos*:
   - `wa_bot_key` = `WA_BOT_KEY` viejo;
   - API keys de webhooks: una fila por cada `proveedor:clave` de `LEAD_API_KEYS` (**las mismas claves**: los Sheets no cambian de key);
   - key del MCP, si se usa.

   En *Configuración*: `dist_excluidos` = `DIST_EXCLUIDOS` viejo.
7. **Ver pendientes** en *Base y migraciones*. Lo esperado: `000` a `002` sin cambios; `003`, `004` y quizás `005`.
8. **Avisar a los usuarios:** la ventana del Día D, que van a tener que volver a iniciar sesión, y que el horario de ofertas de leads pasa a ser 9:30 a 19:30 de Argentina (aunque ese flujo hoy está apagado).

#### Día D (fuera de horario, ej. 22:00, alrededor de 1 hora)

1. **Backup de la base de Fiat** (obligatorio). Las dos opciones:
   - **Desde Railway:** servicio MySQL de Fiat → *Backups* (en el volumen) → *Create backup*, si el plan lo tiene.
   - **`mysqldump` desde tu PC** (cliente de MySQL 8, por ejemplo `winget install Oracle.MySQL` o el MySQL Shell). En PowerShell **no uses `>`**, porque guarda en UTF-16: usá `--result-file`.

```powershell
$fecha = Get-Date -Format 'yyyyMMdd-HHmm'
mysqldump --host=<host del proxy> --port=<puerto> --user=root --password `
  --single-transaction --routines --triggers --no-tablespaces --set-gtid-purged=OFF `
  --default-character-set=utf8mb4 --result-file="C:\backups\fiat-$fecha.sql" railway
# Verificar que tenga datos:
(Get-Item "C:\backups\fiat-$fecha.sql").Length / 1MB
Select-String -Path "C:\backups\fiat-$fecha.sql" -Pattern 'INSERT INTO `leads`' -SimpleMatch | Measure-Object
```

   (`railway` es el nombre de la base en la URL; puede ser otro.) Guardar el `.sql` fuera del repo.

2. **Migraciones:** en el panel, *Base y migraciones → Aplicar pendientes*. La `003` reconstruye `leads`: unos segundos o minutos según el tamaño. Alternativa, dentro del contenedor:

```sh
npm run migrate -- --tenant fiat-autodelsol --incluir-suspendidos --dry-run
npm run migrate -- --tenant fiat-autodelsol --incluir-suspendidos
```

3. **Backend viejo:** en su servicio de Railway, agregar `AGENT_DISABLED=1` y redeploy. Así el Agente IA (y el aviso de recordatorios vencidos) corre solo en el backend nuevo.
   - El viejo sigue atendiendo al front viejo mientras dure el cambio de dominio.
   - Sus otras tareas en segundo plano son inofensivas en paralelo: el reparto es idempotente y el checker no tiene ofertas.
4. **Reactivar `fiat-autodelsol`** en el panel. Desde acá, el backend nuevo procesa a Fiat.
5. **Prueba en el subdominio** `https://fiat-autodelsol.autoatento.com.ar` (no hace falta agregarlo en Vercel): login como owner, ver los leads de siempre, *Mi Equipo*, chat de WhatsApp de un lead, alertas. "Entrar como owner" desde el panel también abre el subdominio.
6. **Apuntar `crm5alluma.com.ar` al proyecto nuevo de Vercel:**
   - **Si el proyecto viejo está en la misma cuenta o equipo de Vercel:** *proyecto viejo → Settings → Domains → Remove `crm5alluma.com.ar`*, y después *proyecto nuevo → Domains → Add `crm5alluma.com.ar`*. Si el DNS ya apunta a Vercel, no hay que tocar DNS y el cambio es inmediato.
   - **Si está en otra cuenta:** Vercel pide verificarlo con un registro TXT; después cambiar el DNS a lo que indique.
7. **Webhooks** (la key no cambia, solo la URL):
   - **Google Sheets** (cada Apps Script): `https://<backend>/api/t/fiat-autodelsol/webhooks/sheets`.
   - **Zapier:** `https://<backend>/api/t/fiat-autodelsol/webhooks/zapier-formularios`.
   - **Bot de WhatsApp** (`.env` del droplet): la URL del webhook del CRM pasa a `https://<backend>/api/t/fiat-autodelsol/webhooks/whatsapp-bot`; después reiniciar el bot (ej. `pm2 restart <bot-fiat>`). El bot sigue escribiendo en la misma base, sin cambios.
   - Mientras no se cambien, las URLs viejas siguen funcionando contra el backend viejo, en la misma base: no se pierden leads.
8. **Checklist post-migración** (con dos navegadores: owner y un vendedor):
   - [ ] `https://crm5alluma.com.ar` muestra el branding de Fiat y "Powered by AutoAtento".
   - [ ] Login de owner, gerente, supervisor y vendedor (todos tienen que volver a loguearse).
   - [ ] La cantidad de leads coincide con la del sistema viejo (filtros iguales).
   - [ ] Alta manual de un lead de prueba: le llega en vivo al otro navegador.
   - [ ] Una fila de prueba en cada Google Sheet crea el lead (y no lo duplica).
   - [ ] Un WhatsApp de prueba al bot crea el lead; el chat del lead muestra los mensajes y se puede responder desde el CRM.
   - [ ] Notas, recordatorios (crear y completar), alertas, tareas asignadas y metas.
   - [ ] *Mi Equipo* muestra la distribución; *Análisis Diario* y Ranking cargan.
   - [ ] Agente IA: `/api/agent/status` en el panel del agente; acciones pendientes visibles.
   - [ ] Registrar una llamada desde el panel de llamadas.
   - [ ] En el panel superadmin: uso del mes de Fiat con usuarios y leads; estado del bot "Responde".
   - [ ] Logs de Railway del backend nuevo sin `sin tenant en el contexto` ni errores de SQL.
9. **Semana de respaldo.** El backend viejo (con `AGENT_DISABLED=1`) y el proyecto viejo de Vercel quedan deployados una semana.
   - Si todo anda: escalar el backend viejo a 0 réplicas (no borrarlo enseguida) y archivar el proyecto viejo de Vercel.
   - **No borrar el servicio MySQL de Fiat del proyecto viejo:** es la base que usa el backend nuevo.

#### Rollback (en minutos)

Como los dos backends usan la misma base y el backend viejo funciona con el esquema migrado, **no hace falta revertir la base**: lo que se cargó en el sistema nuevo queda.

1. **Front (1 a 2 minutos):** en Vercel, *proyecto nuevo → Domains → Remove `crm5alluma.com.ar`*, y en el *proyecto viejo → Add* de nuevo (mismo DNS).
2. **Tareas en segundo plano:** en el panel, *Suspender* `fiat-autodelsol`; el backend nuevo deja de procesar Fiat. En el backend viejo, sacar `AGENT_DISABLED` y redeploy.
3. **Webhooks:** volver los Sheets, Zapier y el `.env` del bot a las URLs viejas (`https://<backend-viejo>/api/webhooks/...`) y reiniciar el bot. Las keys son las mismas.
4. **Usuarios:** vuelven a entrar en el front viejo, con el login viejo.
5. **Solo si hay datos dañados (último recurso):** restaurar el backup.
   - **Primero en una base nueva**, para compararla, nunca encima de la de producción sin verificar.

```powershell
mysql --host=<host> --port=<puerto> --user=root --password -e "CREATE DATABASE fiat_restore"
mysql --host=<host> --port=<puerto> --user=root --password --default-character-set=utf8mb4 fiat_restore `
  --execute="source C:/backups/fiat-<fecha>.sql"
```

   - Después decidir con los datos a la vista. Esto es destructivo: hacerlo con calma.

**Cambios de comportamiento para avisar a Fiat:**
1. **Re-login obligatorio una vez:** los tokens viejos no tienen `tid`.
2. **Horario del flujo de ofertas:** pasa a ser 9:30 a 19:30 de Argentina (antes, por la hora del servidor, era 6:30 a 16:30). El flujo hoy está apagado.
3. **URLs de webhooks:** pasan a `/api/t/fiat-autodelsol/...`. Las keys son las mismas.
4. **Ya no hay defaults hardcodeados:** la URL del bot, las marcas (`fiat`) y los usuarios excluidos del reparto salen de la config del tenant.
5. **`/api/calls`, `/api/metas` y `/api/users`** piden token (el front nuevo lo manda).
6. **Cookie de sesión:** se llama `session_fiat-autodelsol`.

### 14.5 Checklist para migrar otro clon (GoldPlan, Peugeot, Pergamino, ALRA)

Para cada clon, antes de registrarlo:

**Base de datos (automático, solo lectura):**

```powershell
npm.cmd run comparar-esquema -- --clon '<MYSQL_PUBLIC_URL del clon>' --referencia demo --salida <clon>-vs-autoatento.md
```

| Lo que aparece en el informe | Qué hacer |
|---|---|
| Tablas que le faltan al clon | Nada: las crean las migraciones al registrarlo |
| Columnas que le faltan al clon | Confirmar que alguna migración las agrega; si no, migración nueva aditiva (patrón de `002`/`005`) |
| Tablas o columnas que solo tiene el clon | Funcionalidad propia: ¿se suma para todos (migración) o es un módulo (flag + migración + rutas con `requireModulo`)? Ej.: tablas de scoring → módulo `scoring` |
| Tipos distintos (ENUM con otros valores) | Migración que unifique el tipo, como la `003` |
| Estados, fuentes o roles en uso que el CRM base no conoce | Estados y fuentes en el front (`CRM.tsx`) o como config del tenant; nunca hardcodeados a un cliente |
| Marcas en uso | Cargar `config.marcas` y `marca_default` del tenant |

**Código (manual, comparando el repo del clon contra `fiat-autodelsol-crm-backend`/`-react` en el commit desde el que se copió AutoAtento):**
- [ ] `git diff --stat` de `routes/`, `services/`, `agent/` y `socket-server.js`: cada archivo distinto, ¿es mejora general (se porta a AutoAtento para todos) o del cliente (módulo)?
- [ ] Rutas que existen solo en el clon → módulo o ruta nueva.
- [ ] `CRM.tsx`: secciones del menú, botones y textos propios (marca, plantillas de WhatsApp, modelos) → módulos y branding, nunca hardcodeado.
- [ ] Variables de entorno del deploy del clon que no existen en AutoAtento → config del tenant (o secreto cifrado) o variable global.
- [ ] Webhooks y fuentes (`FUENTE_POR_PROVIDER`, `LEAD_API_KEYS`) → `sheet_fuentes` y `lead_api_keys` del tenant.
- [ ] Bot de WhatsApp del clon: ¿misma API que el de Fiat? (`WhatsApp Admin` muestra los modelos de Fiat; revisar.)
- [ ] Roles y jerarquía (equipos, `reportsTo`, ids de líderes hardcodeados como los de GoldPlan) → datos, no código.
- [ ] `multi_marca`, `motos` y `scoring`: se definen al migrar **GoldPlan** (qué pantallas y reglas activa cada uno).

**Después de convertir las diferencias en migraciones y módulos:**
1. `npm test`, `smoke` y `smoke:fase2` en desarrollo.
2. Deploy.
3. Registrar el clon como **base existente, sin migrar y suspendido**.
4. Seguir el Día D (14.4) cambiando dominio, webhooks y bot.

## 15. Capacidad (conexiones a MySQL)

**Qué abre cada proceso del backend:**
- **Base de control:** un pool de hasta `CONTROL_POOL_LIMIT` conexiones (default 5).
- **Cada tenant:** un pool de hasta `TENANT_POOL_LIMIT` conexiones (default 2), contra el servidor MySQL de **su** `db_url`.
- **Scripts y panel:** `npm run migrate`, el alta de un tenant o "probar conexión" abren 1 conexión temporal por tenant mientras trabajan.

**Por qué cuenta cada tenant activo, aunque nadie lo use:**
- un pool se cierra a los `TENANT_POOL_IDLE_MS` (30 min) sin uso, **pero** las tareas en segundo plano (checker de aceptación cada 30 s, recordatorios, Agente IA) pasan por todos los tenants **activos** cada pocos segundos o minutos. En la práctica, cada tenant activo tiene su pool abierto todo el tiempo;
- mysql2 no cierra conexiones ociosas dentro del pool: si un tenant llegó a usar 2 a la vez, quedan 2 abiertas hasta que se cierre su pool;
- los tenants suspendidos o de baja no abren nada.

**Cuenta (peor caso), por cada servidor MySQL:**

```
conexiones = réplicas × (C + T × L) + margen
  C = CONTROL_POOL_LIMIT (5), solo en el servidor donde está autoatento_control
  T = tenants activos cuya db_url apunta a ESE servidor
  L = TENANT_POOL_LIMIT (2)
  margen = ~10 (consola, backups, migraciones, panel)
```

y tiene que quedar por debajo de `max_connections`. En la MySQL 8 de Railway es **151** por defecto (medido en la de desarrollo: MySQL 8.4, 151).

**Hoy hay 1 réplica** (sección 14.2). Con `mysql-control` alojando `autoatento_control` y los `crm_<slug>` nuevos, y Fiat en su propia MySQL:

| Tenants activos en `mysql-control` | `L = 2` (default) | `L = 4` | `L = 1` |
|---|---|---|---|
| 10 | 5 + 20 + 10 = **35** | 55 | 25 |
| 25 | **65** | 115 | 40 |
| 50 | **115** | 215 ✗ | 65 |
| 68 | **151** (límite) | ✗ | 83 |
| 100 | 215 ✗ | ✗ | 115 |

- **Máximo con los defaults:** `(151 − 5 − 10) / 2 = 68` tenants activos por servidor MySQL.
- **Fiat** (base existente en su MySQL): suma **2** conexiones a la MySQL de Fiat, no a `mysql-control`. El backend viejo de Fiat, mientras siga prendido, usa las suyas aparte.
- **`L = 1`** duplica la capacidad, pero cada tenant hace una consulta por vez (los pedidos de los vendedores y las tareas en segundo plano hacen fila). No conviene salvo emergencia.

**Cómo medir** (con la consola de MySQL de Railway o cualquier cliente):

```sql
SHOW VARIABLES LIKE 'max_connections';
SHOW GLOBAL STATUS LIKE 'Threads_connected';     -- ahora
SHOW GLOBAL STATUS LIKE 'Max_used_connections';  -- pico desde el último reinicio
SELECT db, COUNT(*) AS conexiones FROM information_schema.PROCESSLIST GROUP BY db ORDER BY conexiones DESC;
```

**Cuando se acerque al límite** (`Max_used_connections` arriba de ~80% de `max_connections`):
1. **Subir `max_connections`** en ese servidor: `SET PERSIST max_connections = 300;` (con el usuario root de Railway; sobrevive reinicios). Cada conexión ociosa ocupa poca memoria, pero conviene mirar la memoria del servicio MySQL después.
2. **Repartir tenants en otra MySQL:** cada tenant tiene su `db_url`, así que los nuevos se pueden crear en un segundo servidor (*Base existente* con la connection string del otro servidor, o cambiar `TENANT_DB_SERVER_URL`).
3. **No** bajar `TENANT_POOL_LIMIT` a 1 como solución permanente.

**Si se suben las réplicas** (hoy no se puede sin un adapter de Redis para Socket.io): todo se multiplica por la cantidad de réplicas.

**Ojo al programar con pools de 2:** dentro de una transacción (`getConnection()` + `beginTransaction()`), todas las consultas tienen que ir por esa conexión. Si una función pide otra al pool mientras la transacción tiene una tomada, con dos pedidos a la vez se ocupan las 2 conexiones y los dos quedan esperando para siempre. Pasaba en el reparto de leads (`siguienteVendedor` → `idsHabilitados`) y ya está corregido.

## 16. Bot de WhatsApp (fuera de alcance)

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

## 17. Bugs previos detectados

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

## 18. Pendiente

- **`multi_marca`, `motos` y `scoring`:** los flags existen, pero el CRM base no tiene pantallas para eso (por ejemplo, un selector de marca al cargar un lead). **Decisión: se definen cuando se migre GoldPlan.**
- **Admin del bot por tenant** (sección 16).
