# Plan incremental: Remotion Desktop Worker CLI

**Proyecto:** Courseforge / SofLIA - Engine  
**Fecha:** 2026-07-10  
**Objetivo:** crear un worker local cross-platform para ejecutar renders Remotion en macOS y Windows, manteniendo Courseforge como sistema central de orquestación, seguridad, estados y publicación.

---

## 1. Decisión base

Vamos a apostar por un **Remotion Desktop Worker CLI**.

La idea no es crear primero una app desktop completa. La idea inicial es más simple:

```txt
Courseforge crea y controla el job
    ↓
Worker local toma el job
    ↓
Renderiza con Remotion en la computadora
    ↓
Sube el video final al storage de Courseforge
    ↓
Courseforge actualiza estados y publicación
```

Courseforge sigue siendo el cerebro.  
La computadora local solo aporta capacidad de render.

---

## 2. Plataformas objetivo

Desde el inicio debemos soportar:

- **macOS**, porque la persona principal de producción usa Mac.
- **Windows**, porque también será usado en el entorno actual de desarrollo/operación.

No conviene hacer scripts separados por sistema operativo como solución principal.  
Conviene crear un CLI en **Node.js / TypeScript**, usando APIs cross-platform.

### Regla importante

Evitar lógica frágil como:

```bash
rm -rf
cp
open
brew install
powershell-specific commands
```

Preferir:

```ts
fs
path
os
child_process.spawn
```

El worker debe detectar el sistema operativo y resolver rutas/binarios de forma controlada.

---

## 3. Qué vive en el nuevo repositorio

El nuevo repo debería contener el worker local.

Nombre posible:

```txt
courseforge-render-worker
```

Responsabilidades del repo nuevo:

- CLI local.
- Comando `doctor`.
- Comando `render --job-id`.
- Comando `start`.
- Validación de entorno local.
- Descarga de assets.
- Ejecución de Remotion.
- Manejo local de logs.
- Subida del resultado.
- Reporte de progreso.
- Manejo de errores locales.
- Soporte macOS/Windows desde el inicio.

No debería contener:

- Lógica de aprobación de templates.
- Publicación a SofLIA.
- Gestión de permisos.
- Reglas de negocio del pipeline.
- Admin UI principal.
- Service role key de Supabase.
- Decisiones críticas de producción.

---

## 4. Qué sigue viviendo en Courseforge

Courseforge debe seguir siendo la fuente de verdad.

Se mantiene en Courseforge:

- Autenticación.
- Roles.
- Permisos.
- Multi-tenancy.
- `organization_id`.
- `artifacts`.
- `material_components`.
- `production_jobs`.
- Templates aprobados.
- Versionado de templates.
- Validación server-side.
- Estados de producción.
- Storage final.
- Auditoría.
- Publicación a SofLIA.
- Sincronización con `publication_requests.lesson_videos`.

El worker local no debe decidir qué se aprueba ni qué se publica.

---

## 5. Cambio futuro en la página de ensamblado

Hoy el ensamblado aparece dentro de la página de producción/postproducción.

La dirección deseada sería:

```txt
Si el usuario NO tiene app/worker vinculado:
    mostrar estado, explicación y opción para vincular worker

Si el usuario SÍ tiene app/worker vinculado:
    mostrar controles de ensamblado/render local
```

Esto no tiene que implementarse desde el día uno, pero debe diseñarse desde ahora.

### Idea futura de UX

En Courseforge:

```txt
Worker local
Estado: no vinculado
[Vincular app]
```

Luego:

```txt
Worker local
Estado: conectado
Dispositivo: MacBook Pro de Producción
Último heartbeat: hace 20 segundos
[Enviar render al worker]
```

En otras palabras:

- El paso de ensamblado puede retirarse como acción visible por defecto.
- Aparece cuando hay un worker vinculado o cuando la organización tiene habilitada la función.
- Cloud/Lambda puede quedar como fallback si se decide conservarlo.

---

## 6. Modelo mental simple

Hay tres piezas:

```txt
1. Courseforge Web
   Donde el usuario/admin revisa, selecciona template y ve estado.

2. Courseforge API
   Donde se crean jobs, se validan permisos y se guardan resultados.

3. Render Worker CLI
   Donde se ejecuta Remotion localmente.
```

El worker no reemplaza Courseforge.  
El worker solo ejecuta trabajos autorizados.

---

## 7. Comandos del CLI

### 7.1 `doctor`

Primer comando obligatorio.

```bash
courseforge-worker doctor
```

Debe revisar:

- Sistema operativo.
- Arquitectura.
- Versión de Node.
- Disponibilidad de Remotion.
- Disponibilidad de Chromium.
- Disponibilidad de FFmpeg.
- Carpeta de trabajo.
- Permisos de escritura.
- Espacio libre en disco.
- Conexión con API.
- Token válido.

Ejemplo ideal:

```txt
Courseforge Render Worker Doctor

OK OS: macOS arm64
OK Node: 20.x
OK Chromium: disponible
OK FFmpeg: disponible
OK API: conectada
OK Workspace: escribible
OK Disk: 120 GB libres

Listo para renderizar.
```

### 7.2 `render --job-id`

Primer modo de render recomendado.

```bash
courseforge-worker render --job-id <job_id>
```

Ventaja:

- Es fácil de probar.
- Es fácil de debuggear.
- No requiere cola automática al inicio.

### 7.3 `start`

Modo worker continuo.

```bash
courseforge-worker start
```

Hace:

- Se conecta a Courseforge.
- Busca jobs pendientes.
- Toma un job disponible.
- Renderiza.
- Reporta progreso.
- Sube resultado.
- Espera el siguiente job.

Este modo debe venir después de validar `render --job-id`.

---

## 8. Compatibilidad macOS y Windows

### Rutas locales

Usar carpetas estándar por sistema operativo.

macOS:

```txt
~/Library/Application Support/Courseforge Render Worker
```

Windows:

```txt
%APPDATA%\Courseforge Render Worker
```

Linux, si se soporta después:

```txt
~/.config/courseforge-render-worker
```

### Binarios

El worker necesita:

- Node.js.
- Chromium.
- FFmpeg.

Para el MVP, se puede iniciar con dependencias instaladas por el usuario/desarrollador.

Después, lo ideal sería empaquetar:

- Chromium vía Playwright o Remotion compatible.
- FFmpeg empaquetado o resuelto por dependencia.

### Riesgos por OS

| Tema | macOS | Windows |
|---|---|---|
| Paths | `/Users/...` | `C:\Users\...` |
| Shell | zsh/bash | PowerShell/cmd |
| FFmpeg | brew o binario | exe o binario empaquetado |
| Seguridad | Gatekeeper | SmartScreen/antivirus |
| Arquitectura | Apple Silicon / Intel | x64 principalmente |
| Permisos | ejecución y carpetas | ejecución, antivirus y PATH |

---

## 9. Seguridad del worker

El worker no debe usar `SUPABASE_SERVICE_ROLE_KEY`.

Debe usar un token limitado.

Idealmente:

```txt
worker_token
scope: leer jobs asignados
scope: descargar assets firmados
scope: subir resultado del job asignado
scope: reportar progreso del job asignado
ttl: corto o renovable
```

Controles mínimos:

- Token por dispositivo.
- Device ID.
- Worker ID.
- Heartbeat.
- Revocación desde Courseforge.
- Jobs firmados o asignados.
- URLs firmadas temporales.
- Validación server-side del output.
- Logs sin secretos.

---

## 10. Modelo de vinculación futuro

La vinculación puede funcionar así:

```txt
1. Admin abre Courseforge.
2. Da clic en "Vincular worker".
3. Courseforge genera código temporal.
4. En la terminal local:

   courseforge-worker link

5. El CLI pide el código.
6. Courseforge registra el dispositivo.
7. El worker queda asociado a organization_id.
```

Datos posibles:

```txt
worker_id
device_id
organization_id
user_id
device_name
platform
arch
app_version
last_heartbeat_at
status
revoked_at
```

Estados posibles:

```txt
PENDING_LINK
LINKED
ONLINE
BUSY
OFFLINE
REVOKED
```

---

## 11. Cambios necesarios en Courseforge

Probablemente se necesiten cambios graduales.

### Backend/API

- Endpoint para registrar worker.
- Endpoint para heartbeat.
- Endpoint para reclamar job.
- Endpoint para descargar input seguro del job.
- Endpoint para reportar progreso.
- Endpoint para reportar fallo.
- Endpoint para confirmar upload final.

### Base de datos

Posibles tablas o extensiones:

```txt
render_workers
render_worker_sessions
production_job_attempts
```

Campos útiles en `production_jobs`:

```txt
provider: local_worker | lambda | cloud_run
worker_id
device_id
claimed_at
heartbeat_at
progress
attempt_count
input_snapshot
output_asset_id
output_checksum
error_code
error_message
logs_ref
```

### Frontend

- Estado de worker vinculado/no vinculado.
- Botón de vinculación.
- Estado del dispositivo.
- Progreso del render.
- Mensajes claros de error.
- Opción de fallback si aplica.

---

## 12. Flujo MVP recomendado

### MVP 1: render manual por job

Objetivo:

```txt
Probar que una máquina local puede renderizar un job real y subir el resultado.
```

Flujo:

```txt
1. Courseforge crea production_job.
2. Admin copia job_id.
3. En terminal:

   courseforge-worker render --job-id <job_id>

4. Worker descarga input.
5. Worker renderiza con Remotion.
6. Worker sube MP4.
7. Worker reporta completed.
8. Courseforge muestra video final.
```

Este MVP es deliberadamente manual.

### MVP 2: worker vinculado

Objetivo:

```txt
Evitar copiar job_id y permitir que Courseforge detecte workers disponibles.
```

Flujo:

```txt
1. Worker se vincula a una organización.
2. Worker hace heartbeat.
3. Courseforge muestra worker online.
4. Admin manda render al worker.
5. Worker reclama job y lo ejecuta.
```

### MVP 3: worker continuo

Objetivo:

```txt
Procesar cola local automáticamente.
```

Comando:

```bash
courseforge-worker start
```

---

## 13. Estructura sugerida del nuevo repo

```txt
courseforge-render-worker/
  package.json
  tsconfig.json
  README.md
  src/
    cli.ts
    commands/
      doctor.command.ts
      link.command.ts
      render.command.ts
      start.command.ts
    core/
      config.ts
      logger.ts
      paths.ts
      platform.ts
      errors.ts
    api/
      courseforge-client.ts
      types.ts
    remotion/
      render-job.ts
      validate-environment.ts
      chromium.ts
      ffmpeg.ts
    worker/
      claim-job.ts
      run-job.ts
      report-progress.ts
      upload-result.ts
    storage/
      download-assets.ts
      temp-workspace.ts
      cleanup.ts
    security/
      token-store.ts
      device-id.ts
  tests/
    unit/
    integration/
```

---

## 14. Principios técnicos

1. Cross-platform desde el día uno.
2. macOS y Windows como plataformas principales.
3. Courseforge sigue siendo source of truth.
4. El worker no tiene permisos globales.
5. El worker no aprueba ni publica.
6. Remotion sigue siendo el motor de composición.
7. El output final siempre vuelve a storage propio.
8. Todo job debe ser auditable.
9. Todo error debe tener código entendible.
10. Primero CLI, después app desktop.

---

## 15. Qué evitar

Evitar:

- Crear una app desktop completa antes de validar el worker.
- Meter secretos globales en el CLI.
- Depender de comandos PowerShell o bash hardcodeados.
- Guardar outputs solo en la máquina local.
- Permitir que el worker modifique estados críticos sin validación.
- Permitir que cualquier worker tome cualquier job.
- Ejecutar templates no aprobados.
- Saltarse `organization_id`.
- Romper el flujo actual de publicación a SofLIA.

---

## 16. Próximo paso recomendado

El siguiente paso sano es crear el nuevo repo con un MVP muy pequeño:

```txt
courseforge-worker doctor
courseforge-worker render --job-id <job_id>
```

Antes de implementar cola, vinculación o UI, debemos probar:

- Un job real.
- Un render real.
- Un upload real.
- Un update real en Courseforge.
- En macOS.
- En Windows.

Si eso funciona, entonces sí avanzamos a:

```txt
link
start
heartbeat
worker online en UI
```

---

## 17. Resumen final

La ruta recomendada es:

```txt
Nuevo repo para Remotion Desktop Worker CLI.
Compatible con macOS y Windows desde el inicio.
Courseforge mantiene seguridad, estados, templates y publicación.
El worker solo renderiza jobs autorizados.
Primero modo manual por job_id.
Después vinculación.
Después modo worker continuo.
Después app desktop si el CLI demuestra valor.
```

Esto permite avanzar sin reescribir Courseforge y sin casarnos todavía con una app desktop pesada.
