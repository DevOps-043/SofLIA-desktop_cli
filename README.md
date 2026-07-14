# SofLIA - Engine Render Worker

Aplicacion de escritorio para renderizar videos de SofLIA - Engine usando la computadora del usuario. La app se vincula con un codigo temporal, recibe jobs autorizados desde SofLIA - Engine, renderiza localmente con Remotion y sube el video final de vuelta a la plataforma.

## Version actual

### v0.1.0

Primera version operativa del worker de escritorio.

Incluye:

- App Electron descargable con UI en Vite + React.
- Tema claro y oscuro.
- Vinculacion con codigo temporal `SLIA-000000`.
- Guardado local de token limitado del worker.
- Heartbeat para mostrar si el equipo esta disponible.
- Reclamo automatico de jobs con `claim-next`.
- Render local con Remotion.
- Subida del MP4 mediante URL firmada.
- Boton para pausar el render local.
- Opcion para mantener la app en segundo plano.
- Opcion para cerrar completamente desde la UI o desde el icono de segundo plano.
- Icono de app, instalador y bandeja del sistema.
- Workflow de GitHub Actions para generar instaladores por sistema operativo.

No incluye todavia:

- Auto-update.
- Firma/certificado de instaladores.
- Modo offline.
- Cola visual avanzada dentro de la app.
- Revocacion del worker desde la app local.

## Uso para usuarios finales

1. Descargar e instalar la app desde SofLIA - Engine.
2. Abrir SofLIA - Engine en el navegador.
3. Generar un codigo temporal de vinculacion.
4. Abrir la app de escritorio.
5. Pegar el codigo y conectar el equipo.
6. Presionar `Iniciar` para dejar el equipo disponible.

La app debe permanecer abierta o en segundo plano mientras SofLIA renderiza videos.

## Desarrollo local

Instalar dependencias:

```powershell
npm install
```

Ejecutar la app Electron en desarrollo:

```powershell
npm run electron:dev
```

Compilar y probar:

```powershell
npm run build
npm run test
```

## Empaquetado local

Windows:

```powershell
npm run package:win
```

macOS:

```powershell
npm run package:mac
```

Linux:

```powershell
npm run package:linux
```

Los instaladores se generan en `release/`. Esa carpeta no debe subirse a Git.

## Publicacion de instaladores

GitHub Actions genera instaladores desde:

```txt
.github/workflows/desktop-installers.yml
```

Build manual:

1. Ir a GitHub Actions.
2. Ejecutar `Desktop installers`.
3. Descargar los artifacts generados.

Release publica:

```powershell
git tag v0.1.0
git push origin v0.1.0
```

Al subir un tag `v*`, el workflow crea un GitHub Release y adjunta instaladores para Windows, macOS y Linux.

## Integracion con SofLIA - Engine

En produccion, la app debe apuntar a la URL publica de SofLIA - Engine, por ejemplo:

```txt
https://soflia-coursegen.netlify.app
```

`localhost` solo debe usarse en desarrollo.

La app no usa `SUPABASE_SERVICE_ROLE_KEY`, no consulta Supabase directo y no decide permisos. Todo eso vive en SofLIA - Engine server-side.

## Comandos CLI de soporte

La app Electron es el flujo principal. Estos comandos se mantienen como herramientas de desarrollo o soporte:

```powershell
node dist/cli.js link --api-url <url> --code <SLIA-000000>
node dist/cli.js doctor
node dist/cli.js start
node dist/cli.js render --job-id <production_job_id>
node dist/cli.js configure --api-url <url> --token <worker_token>
```

`configure` con token manual es solo fallback de desarrollo.

## Variables y configuracion

La configuracion local se guarda en la carpeta estandar del sistema operativo:

- Windows: `%APPDATA%\SofLIA Engine Render Worker`
- macOS: `~/Library/Application Support/SofLIA Engine Render Worker`
- Linux: `$XDG_CONFIG_HOME/soflia-engine-render-worker`

No se deben guardar tokens ni URLs firmadas en logs.
