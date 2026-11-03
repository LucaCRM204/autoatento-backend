# AutoAtento — arquitectura multi-tenant

Un solo backend y un solo frontend para todos los clientes (tenants), con
**una base de datos por tenant**. Las queries de las rutas no cambian: cada
request corre "dentro" de un tenant y `require('../db')` va al pool de ese
tenant. Un `WHERE` olvidado no puede filtrar datos entre clientes porque cada
cliente está en otra base.

> Estado: **Fases 1 y 2 terminadas** (base multi-tenant del backend,
> migraciones, panel superadmin y uso mensual). Frontend único, tests formales
> y plan de migración de clientes son las fases 3 a 5.

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

Las únicas rutas sin tenant son `/api/health`, `/api/public/*` y `/api/superadmin/*` (panel superadmin, sección 9).

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
- **`superadmins`:** usuarios del panel de AutoAtento (sección 9).
- **`uso_mensual`:** `(tenant_id, mes)` → usuarios activos y leads ingresados (sección 10).
- **`audit_log`:** acciones de superadmins, incluido "entrar como owner" (sección 9).

`schema_migrations` vive **en cada base de tenant** (sección 8). Así una base
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
- **Suspensión:** al suspender o dar de baja un tenant se cortan sus sockets
  (aviso `tenant:estado` antes). Ver la sección 9.
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
| Uso mensual (usuarios activos y leads) | 1 h (primera corrida al minuto) | `superadmin/uso.js` |
| Vigilante de suspensiones (corta sockets) | 30 s (`SUSPENSION_WATCH_MS`); recorre todos los tenants, no solo los activos | `tenancy/realtime.js` |

**Agente IA:**
- **Esquema y usuario:** las tablas vienen de las migraciones; el usuario de sistema se crea por tenant la primera vez que se usa el agente ahí (`agent/state.js`).
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
npm run dev:seed       # BORRA y recrea crm_tenant-a y crm_tenant-b (schema + migraciones + owner + datos)
npm run smoke          # Fase 1: aislamiento entre tenants (44 checks)
npm run smoke:fase2    # Fase 2: migraciones, superadmin, uso, suspensión (50 checks).
                       # Borra y recrea crm_tenant-b varias veces; al final deja todo como dev:seed
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

## 7. Crear un tenant

**Desde el panel superadmin** (`POST /api/superadmin/tenants`, ver la sección 9).
El alta hace todo el circuito: crea el schema `crm_<slug>`, corre las
migraciones, crea el owner y registra el tenant. Si algo falla después de
crear el schema, el schema se borra (rollback); nunca se borra una base que
ya existía.

```jsonc
// schema nuevo
{ "slug": "mi-cliente", "nombre": "Mi Cliente", "plan": "pro",
  "dominios": ["crm.micliente.com.ar"],
  "branding": { "nombre": "Mi Cliente Autos", "color_primario": "#cc0000", "logo_url": "https://..." },
  "modulos": { "motos": true },
  "config": { "timezone": "America/Argentina/Buenos_Aires", "wa_bot_url": "https://.../wa-micliente",
              "wa_bot_key": "...", "lead_api_keys": { "whatsapp-bot": "...", "sheet-emanuel": "..." } },
  "owner": { "email": "dueño@micliente.com", "password": "...", "name": "Dueño" } }

// usar base existente (ej. Fiat): sin owner, con o sin migrar en el momento
{ "slug": "fiat-autodelsol", "nombre": "Auto del Sol Fiat", "db_url": "mysql://...", "migrar": false, ... }
```

**Por línea de comandos** (mismo circuito; los secretos se cargan después desde el panel):

```bash
OWNER_PASSWORD='...' npm run tenant:add -- --slug mi-cliente --nombre "Mi Cliente" --plan pro \
  --create-schema --dominio crm.micliente.com.ar --owner-email dueño@micliente.com \
  --branding-nombre "Mi Cliente Autos" --color '#cc0000' --wa-bot-url https://.../wa-micliente

# base existente; --sin-migrar para registrarla y migrar después
npm run tenant:add -- --slug fiat-autodelsol --nombre "Auto del Sol Fiat" --db-url 'mysql://...' --sin-migrar
```

## 8. Migraciones

- **Archivos:** `migrations/NNN_descripcion.sql`, en orden. `000_baseline.sql`
  es el `database.sql` original de Fiat, sin cambios: todo `CREATE TABLE IF NOT
  EXISTS`, así que contra una base existente solo crea lo que falte.
- **Registro:** tabla `schema_migrations` **en cada base de tenant** (`version`,
  `checksum`, `applied_at`, `duration_ms`). Si un archivo ya aplicado cambia, el
  runner lo avisa como "modificada" pero no lo vuelve a correr.
- **Idempotencia:** lo aplicado no se repite, y cada archivo tiene que poder
  correrse dos veces sin romper nada. El DDL de MySQL no es transaccional: si
  una corrida se corta a la mitad, se vuelve a correr entera.
- **Compatibilidad MySQL 8 / MariaDB:** sin `ADD COLUMN IF NOT EXISTS`. Para
  cambios condicionales, chequeo contra `information_schema` + `PREPARE`:

  ```sql
  SET @existe := (SELECT COUNT(*) FROM information_schema.COLUMNS
                   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tabla' AND COLUMN_NAME = 'col');
  SET @sql := IF(@existe = 0, 'ALTER TABLE tabla ADD COLUMN col VARCHAR(20) NULL', 'SELECT 1');
  PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  ```
- **Concurrencia:** `GET_LOCK` por base: dos instancias no migran el mismo tenant a la vez.
- **Fallas aisladas:** un tenant que falla (base caída, migración rota) queda en
  el reporte con su error y el runner sigue con los demás. Las migraciones que
  sí se aplicaron antes de la falla quedan registradas.

| Migración | Qué hace |
|---|---|
| `000_baseline` | Esquema del CRM (el `database.sql` de Fiat) |
| `001_agente_ia` | Tablas del Agente IA (antes las creaba `agent/schema.js` en cada arranque) |
| `002_wa_messages_sent_by` | Columna `wa_messages.sent_by` si no existe |
| `003_leads_marca_varchar` | `leads.marca` de `ENUM('fiat')` a `VARCHAR(30)` (default `'fiat'`). Solo si sigue siendo ENUM; conserva los valores. **Reconstruye la tabla `leads`: en bases grandes, correrla fuera de horario** |
| `004_user_logins` | Registro de logins, para el uso mensual |

Cómo se corren:

```bash
npm run migrate                          # tenants activos
npm run migrate -- --tenant fiat-autodelsol --dry-run
npm run migrate -- --incluir-suspendidos
npm run migrate -- --listar              # versiones y checksums
```

- **Al arrancar:** con `AUTO_MIGRATE=1`, el server migra los tenants activos.
  Si uno falla, lo loguea y arranca igual.
- **Desde el panel:** `POST /api/superadmin/tenants/:id/migrar` (con `{"dry_run": true}` para ver qué falta).
- **`bootstrap.js`:** ya no corre `database.sql`.
- **Agente IA:** `agent/schema.js` ya no crea tablas, solo el usuario de
  sistema. Si un tenant no está migrado, el agente de ese tenant avisa
  "faltan las tablas del agente" y el resto del CRM sigue andando.

Para agregar una migración: archivo nuevo con el número siguiente, idempotente,
probado contra una base nueva (`dev:seed`) y contra una vieja (`smoke:fase2`
simula una base como la de Fiat).

## 9. Panel superadmin (backend)

Rutas en `/api/superadmin/*` (`superadmin/routes.js`). No pasan por
`resolveTenant` y tienen login propio:

- **Usuarios:** tabla `autoatento_control.superadmins`, separados de los usuarios de cada CRM.
- **Token:** JWT firmado con `SUPERADMIN_JWT_SECRET` (distinto de `JWT_SECRET`), `scope: 'superadmin'`, 12 h.
- **Fuerza bruta:** 5 intentos fallidos por IP+email bloquean 15 minutos.
- **Sin `SUPERADMIN_JWT_SECRET`** (o igual a `JWT_SECRET`): el panel responde 503.

```bash
SUPERADMIN_PASSWORD='...' npm run superadmin:add -- --email vos@autoatento.com --nombre "Luca"
npm run superadmin:add -- --email alguien@autoatento.com --desactivar
```

| Ruta | Qué hace |
|---|---|
| `POST /login` | `{ email, password }` → token |
| `GET /tenants` | Lista con uso del mes. Sin secretos: dice cuáles están cargados y la base con la contraseña enmascarada |
| `POST /tenants` | Alta (sección 7) |
| `GET /tenants/:id` | Detalle |
| `PATCH /tenants/:id` | `nombre`, `plan`, `dominios`, `branding`, `modulos`, `config`, `db_url`. `modulos` y `branding` se mezclan con lo guardado. En `config`, un valor pisa, `null` o `""` borra, y una clave ausente queda igual. Los secretos se cifran |
| `POST /tenants/:id/suspender` · `/reactivar` · `/baja` | Cambia el estado. Suspender y dar de baja cortan los sockets del tenant en el momento |
| `GET /tenants/:id/secretos/:clave` | Muestra un secreto (ej. `lead_api_keys` para configurar un Sheet). Queda auditado |
| `POST /tenants/:id/migrar` | Migra ese tenant (`{"dry_run": true}` para ver) |
| `GET /tenants/:id/uso?meses=6` | Uso del mes (recalculado), historial y estado del bot |
| `POST /tenants/:id/impersonar` | "Entrar como owner": token del CRM del tenant (primer owner activo, o `{ "user_id": N }`) |
| `GET /uso?mes=YYYY-MM&recalcular=1` | Uso de todos los tenants, para facturar |
| `GET /auditoria?tenant_id=&limit=` | Log de auditoría |

**Entrar como owner:**
- **Token:** el mismo formato que el login del CRM (`tid` incluido), con `imp: { sid, email }` del superadmin y vencimiento de **1 hora**.
- **Uso:** sirve solo en ese tenant. Sus conexiones no se cuentan como uso del cliente.
- **Restricción:** no se puede entrar a un tenant suspendido (409).
- **Pendiente para la Fase 3:** el front tiene que guardar ese token y abrir el CRM del tenant.

**Auditoría** (`audit_log`):
- **Qué registra:** altas, ediciones (con la lista de campos tocados, nunca los valores de los secretos), cambios de estado (con sockets cortados y motivo), secretos vistos, migraciones e impersonaciones.
- **Datos de cada registro:** superadmin, IP y fecha.

**Suspender un tenant:**
- `estado = suspendido` → toda request recibe **402**.
- Los sockets abiertos reciben `tenant:estado` (`{ estado, mensaje }`) y se desconectan.
- La reconexión se rechaza mientras no esté activo.
- Si la suspensión se hace por fuera del panel (otra instancia o la base a mano), un vigilante corta los sockets en hasta 30 segundos (`SUSPENSION_WATCH_MS`).
- En la caché de tenants, los otros procesos lo ven en hasta 30 segundos (`TENANT_CACHE_TTL_MS`).

## 10. Uso mensual (facturación por usuario)

`autoatento_control.uso_mensual (tenant_id, mes, usuarios_activos, leads_ingresados)`:

- **`usuarios_activos`:** usuarios distintos que en el mes iniciaron sesión
  (`user_logins`) o usaron el CRM (`user_sessions`, una fila por conexión del
  socket). No cuenta al usuario de sistema del agente ni las sesiones de soporte.
- **`leads_ingresados`:** leads con `created_at` dentro del mes.
- **Cálculo:** una tarea horaria (`everyTenant`) actualiza el mes en curso y,
  los primeros 3 días del mes, también cierra el anterior. El panel puede
  forzar el recálculo.
- **Corte de mes:** usa el reloj de la base del tenant. En Railway es UTC, así
  que lo cargado el último día del mes después de las 21 h de Argentina cuenta
  para el mes siguiente.

**Estado del bot** (en `/tenants/:id/uso`):
- si tiene `wa_bot_url` y `wa_bot_key`;
- si la URL responde (GET de 3 segundos, sin mandar la key);
- las sesiones que el bot registra en `wa_sessions` (número, estado y si el bot está prendido).

## 11. Backup de secretos

Si se pierde **`TENANT_DB_KEY`**, no se pueden descifrar las connection
strings ni los secretos de **ningún** tenant (`db_url_cifrada`, `wa_bot_key`,
`lead_api_keys`, `openai_api_key`, `agent_mcp_key`). Las bases de los clientes
siguen intactas, pero hay que volver a cargar a mano cada connection string y
cada key.

**Qué guardar y dónde:**

| Secreto | Si se pierde | Backup |
|---|---|---|
| `TENANT_DB_KEY` | No se descifra nada de `tenants` | **Imprescindible.** En un gestor de contraseñas (1Password/Bitwarden) en una bóveda de la empresa, con al menos dos personas con acceso. Además, una copia offline (papel en lugar seguro o USB cifrado) |
| `JWT_SECRET` | Se cierran todas las sesiones de los CRMs (hay que volver a loguearse); no se pierden datos | Gestor de contraseñas |
| `SUPERADMIN_JWT_SECRET` | Se cierran las sesiones del panel | Gestor de contraseñas |
| `CONTROL_DB_URL` / `TENANT_DB_SERVER_URL` | Se recuperan desde Railway | Opcional |
| Base `autoatento_control` | Se pierden los tenants, el uso y la auditoría | Backups de Railway + un dump periódico. **El dump solo sirve junto con `TENANT_DB_KEY`** |

**Reglas:**
- `TENANT_DB_KEY` no va en el repo, ni en Slack, ni por mail. Solo en las
  variables del deploy (Railway) y en el gestor de contraseñas.
- Un dump de `autoatento_control` tiene los secretos cifrados: se puede
  guardar como cualquier backup de base, pero **nunca junto con la key**.
- Cada tanto, probar la restauración: levantar el backend local con la key
  del gestor y un dump reciente de `autoatento_control`, y correr
  `npm run migrate -- --dry-run`. Si lista los tenants sin errores de
  descifrado, el backup sirve.

**Rotar `TENANT_DB_KEY`** (si se filtra): hoy no hay script. Haría falta uno
que descifre cada secreto con la key vieja y lo vuelva a cifrar con la nueva,
en una sola transacción. Queda pendiente; avisame si lo necesitás.

**Si la key se perdió de verdad:**
1. Generar una nueva y ponerla en el deploy.
2. Por cada tenant, desde el panel: `PATCH /api/superadmin/tenants/:id` con `db_url` y cada secreto (`wa_bot_key`, `lead_api_keys`, ...).
3. Las keys de webhooks se recuperan de los Apps Script y de Zapier; la del bot, del `.env` del bot.

## 12. Migrar un cliente existente

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
9. **Migraciones sobre la base de Fiat:** `000` a `002` no cambian nada (las
   tablas y la columna ya existen). `003` pasa `leads.marca` a `VARCHAR(30)`
   y reconstruye la tabla `leads`: correrla fuera de horario. `004` agrega
   `user_logins`. Se puede registrar el tenant con `"migrar": false` y
   correr `npm run migrate -- --tenant fiat-autodelsol --dry-run` antes de
   aplicarlas.

## 13. Bot de WhatsApp (fuera de alcance)

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

## 14. Bugs previos detectados

Corregidos (también en el repo de producción de Fiat):

- `GET /api/leads/unassigned` y `GET /api/leads/distribution` quedaban tapadas por `GET /api/leads/:id`: ahora `/:id` está definida después.
- `GET /api/activity/reassignments` daba 500 en MySQL 8.0.22 o posterior por `LIMIT ?` con `execute()`: ahora el LIMIT va dentro de la consulta, como un entero validado.
- `CallPanel.tsx` (front) hacía POST a `/api/api/calls` (404 silencioso): ahora usa `${apiUrl}/calls`.

Pendiente (cosmético): al desconectarse, el log del socket muestra `Usuario desconectado: undefined` porque el JWT no lleva `name`.

## 15. Pendiente

- **Fase 3 (frontend):**
  - `TenantContext`, `X-Tenant`, socket con slug, branding, módulos y 403 en el backend;
  - pantalla `/superadmin` sobre estas rutas;
  - "entrar como owner" en el front;
  - manejar el evento `tenant:estado`.
- **Fase 4:** tests automáticos (jest o `node:test` + supertest) a partir de los dos smokes.
- **Fase 5:** plan de migración de Fiat y checklist para comparar los otros clones.
- **Migraciones contra MariaDB:** sin probar (no hay Docker en la PC de
  desarrollo). Están escritas para ser compatibles; hay que probarlas cuando haya
  una MariaDB disponible.
- **Webhooks:** siguen insertando `marca = 'fiat'` fijo. Con la columna ya en
  `VARCHAR(30)`, falta definir de dónde sale la marca para `multi_marca` y `motos`.
- **Script de rotación de `TENANT_DB_KEY`** (sección 11).
