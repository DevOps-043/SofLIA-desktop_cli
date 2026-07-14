# Plan de limpieza posterior a v0.1.0

## Objetivo

Dejar el flujo `desktop_worker` listo para distribucion publica, reduciendo deuda tecnica del MVP: separar claramente lo que queda como producto, lo que queda como fallback de desarrollo y lo que debe retirarse de SofLIA - Engine.

## Decision base

Para produccion, el flujo desktop no debe depender de Express vivo. La app desktop debe hablar con endpoints server-side de SofLIA - Engine web/Netlify, y Supabase debe ser la fuente de verdad para workers, jobs, heartbeats, storage y estado.

## Fase 1: Worker desktop

Estado: ejecutada en el repo desktop.

### Mantener

- Electron + Vite + React como interfaz principal.
- `link`, `doctor`, `start` como comandos de soporte.
- `render --job-id` solo para pruebas controladas.
- `configure --api-url --token` solo como fallback de desarrollo.
- `assets/`, `logo.png` y generacion de iconos.
- GitHub Actions para generar instaladores.

### Retirar o deprecar

- Retirado: `src/ui-server.ts`.
- Retirado: comando `node dist/cli.js ui`.
- Documentacion que sugiera usar UI web local dentro del CLI.
- Cualquier copy que pida copiar tokens manuales como flujo normal.

### Ajustes recomendados

- Agregado: URL default de produccion para la app empaquetada.
- Mantener `apiUrl` visible solo en configuracion avanzada.
- Agregado: indicador de version visible en la app.
- Preparar canal de actualizacion posterior, aunque no se active en v0.1.0.

## Fase 2: SofLIA - Engine web/Netlify

### Mantener

- Endpoints Next bajo `/api/v1/production/remotion`.
- `DesktopWorkerControlPlane` server-side.
- Acciones web para:
  - consultar workers,
  - crear codigo temporal,
  - revocar worker,
  - detener/reintentar ensamblado.
- Tablas:
  - `render_workers`,
  - `render_worker_link_codes`,
  - columnas worker en `production_jobs`.

### Consolidar

- `getProductionApiBaseUrl` debe preferir la URL web/Netlify cuando `RENDER_PROVIDER=desktop_worker`.
- Las actions web de worker deben dejar de usar nombres como `expressApiUrl`.
- La UI debe leer una sola fuente de verdad para descargas por OS.
- El apartado de descarga debe mapear:
  - Windows -> `.exe`,
  - macOS -> `.dmg` o `.zip`,
  - Linux -> `.AppImage` o `.deb`.

### Variables a revisar

Para produccion desktop_worker:

- Mantener:
  - `RENDER_PROVIDER=desktop_worker`
  - `NEXT_PUBLIC_SOFLIA_WORKER_DOWNLOAD_URL` o reemplazo por URLs por plataforma
  - Supabase server-side envs en Netlify
  - peppers de worker/link code si ya estan definidos

- Deprecar para desktop_worker:
  - `EXPRESS_INTERNAL_API_URL`
  - `EXPRESS_PUBLIC_URL`
  - `EXPRESS_API_URL`
  - `API_PUBLIC_URL` si solo apunta a Express

No borrar esas variables de forma global si `lambda`, `local` o `apps/api` aun se usan para otros entornos.

## Fase 3: SofLIA - Engine apps/api

### Mantener por ahora

- `apps/api` completo si aun se usa para Lambda, previews externos, Cloud Build o pruebas locales.
- Provider `lambda`.
- Provider `local`, solo si sigue siendo util para desarrollo o Cloud Run.

### Candidatos a retirar del flujo desktop

- Endpoints Express de desktop worker duplicados:
  - `/remotion/workers/link-codes`
  - `/remotion/workers/link`
  - `/remotion/workers/heartbeat`
  - `/remotion/workers/jobs/claim-next`
  - `/remotion/workers/jobs/:jobId/claim`
  - `/remotion/workers/jobs/:jobId/progress`
  - `/remotion/workers/jobs/:jobId/complete`
  - `/remotion/workers/jobs/:jobId/fail`
- `DesktopWorkerService` de `apps/api` si queda reemplazado por `DesktopWorkerControlPlane` en web.
- Documentacion que indique que Express es obligatorio para desktop_worker en produccion.

### Regla de seguridad

No retirar `apps/api` hasta verificar que:

1. El worker desktop puede vincularse contra la URL web de SofLIA - Engine.
2. `claim-next` funciona contra Netlify.
3. `complete` actualiza `production_jobs`, assets y publicacion.
4. La subida por URL firmada funciona en produccion.
5. No hay acciones web que sigan llamando `localhost:4000` o `EXPRESS_*` cuando `RENDER_PROVIDER=desktop_worker`.

## Fase 4: Descargas en SofLIA - Engine

### MVP

- Crear un componente `WorkerDownloadPanel`.
- Detectar OS del navegador como sugerencia, no como bloqueo.
- Mostrar botones:
  - Descargar para Windows
  - Descargar para macOS
  - Descargar para Linux
- Leer URLs desde envs o config server-side.

### Variables sugeridas

```env
NEXT_PUBLIC_SOFLIA_WORKER_DOWNLOAD_WINDOWS_URL=
NEXT_PUBLIC_SOFLIA_WORKER_DOWNLOAD_MACOS_URL=
NEXT_PUBLIC_SOFLIA_WORKER_DOWNLOAD_LINUX_URL=
NEXT_PUBLIC_SOFLIA_WORKER_VERSION=0.1.0
```

### Posterior

- Mostrar checksum.
- Mostrar fecha de release.
- Mostrar changelog.
- Agregar auto-update o aviso de version nueva.

## Validaciones

### Worker

```powershell
npm run test
npm run package:win
```

### SofLIA - Engine web

```powershell
npx tsc -p apps/web/tsconfig.json --noEmit
```

### Manual end-to-end

1. Generar release `v0.1.0`.
2. Descargar instalador desde SofLIA - Engine.
3. Instalar app.
4. Vincular con codigo temporal.
5. Confirmar fila en `render_workers`.
6. Ejecutar render real con `desktop_worker`.
7. Confirmar video final en storage y publicacion.
8. Revocar worker desde web.
9. Confirmar que la app ya no puede reclamar jobs.
