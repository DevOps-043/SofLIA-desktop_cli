# SofLIA - Engine Render Worker

Aplicacion de escritorio para renderizar videos de SofLIA - Engine usando la computadora del usuario. La app se vincula con un codigo temporal, recibe jobs autorizados desde SofLIA - Engine, renderiza localmente con Remotion y sube el video final de vuelta a la plataforma.

## Version actual

### v0.1.11

Version enfocada en mejorar instalacion, actualizaciones, experiencia de escritorio, builds de plantilla y visibilidad del render local.

Incluye:

- App Electron descargable con UI en Vite + React.
- Tema claro y oscuro desde el menu lateral de configuracion.
- Pestaña lateral para abrir y cerrar configuracion sin ocupar espacio en la pantalla principal.
- Vinculacion con codigo temporal `SLIA-000000`.
- Guardado local de token limitado del worker.
- Heartbeat para mostrar si el equipo esta disponible.
- Inicio automatico del worker al abrir la app cuando el equipo ya esta vinculado.
- Control manual para iniciar o detener el render local.
- Reclamo automatico de jobs con `claim-next`.
- Compatibilidad con cola secuencial: el worker procesa un video, termina, y despues reclama el siguiente.
- Progreso visible del job actual: job, composicion, etapa y porcentaje.
- Compatibilidad con jobs de build y preview de plantillas.
- Render local con Remotion.
- Subida del MP4 mediante URL firmada.
- Actualizaciones automaticas con GitHub Releases y `latest/download`.
- Menu lateral con actualizaciones, segundo plano, tema y cierre completo.
- Opcion para mantener la app en segundo plano.
- Opcion para cerrar completamente desde la configuracion o desde el icono de segundo plano.
- Icono de app, instalador, bandeja del sistema y logo interno sincronizados desde `logo.png`.
- Workflow de GitHub Actions para generar instaladores por sistema operativo.
- Preparacion tecnica para firma y notarizacion de macOS, pendiente de activar cuando tengamos secrets.

Limitaciones actuales:

- La app muestra el progreso del job actual, pero no puede mostrar el total de videos en cola hasta que el backend entregue `queueTotal` o `queuePosition`.
- No incluye modo offline.
- La revocacion del worker todavia debe hacerse desde SofLIA - Engine.
- Los instaladores macOS aun no estan firmados ni notarizados, por lo que Gatekeeper puede bloquearlos.

## Uso para usuarios finales

1. Descargar e instalar la app desde SofLIA - Engine.
2. Abrir SofLIA - Engine en el navegador.
3. Generar un codigo temporal de vinculacion.
4. Abrir la app de escritorio.
5. Pegar el codigo y conectar el equipo.
6. La app iniciara el render local automaticamente cuando el equipo ya este vinculado.
7. Si se necesita pausar el equipo, usar `Detener`.

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

> Nota: por ahora los builds macOS se generan sin firma Developer ID ni notarizacion de Apple.
> macOS puede bloquearlos con mensajes como "esta danado y no puede abrirse" o
> "Apple no pudo verificar que no contenga software malicioso". La firma/notarizacion se activara en una fase posterior.

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

El workflow valida que el tag coincida con la version de `package.json`. Para esta publicacion la version esperada es `0.1.11`, por lo tanto el tag debe ser `v0.1.11`.

### Comandos para subir v0.1.11

Revisar estado:

```powershell
git status
```

Ejecutar validacion local:

```powershell
npm run test
```

Agregar cambios:

```powershell
git add .
```

Crear commit:

```powershell
git commit -m "Release v0.1.11 desktop worker updates"
```

Subir rama actual:

```powershell
git push origin HEAD
```

Crear tag:

```powershell
git tag v0.1.11
```

Subir tag:

```powershell
git push origin v0.1.11
```

Al subir un tag `v*`, el workflow crea un GitHub Release y adjunta instaladores para Windows, macOS y Linux.

Los links estables para usuarios finales usan `latest/download` y no deben incluir la version:

```txt
https://github.com/DevOps-043/SofLIA-desktop_cli/releases/latest/download/SofLIA-Engine-Render-Worker-Windows-x64.exe
https://github.com/DevOps-043/SofLIA-desktop_cli/releases/latest/download/SofLIA-Engine-Render-Worker-macOS-arm64.dmg
https://github.com/DevOps-043/SofLIA-desktop_cli/releases/latest/download/SofLIA-Engine-Render-Worker-macOS-x64.dmg
```

## Firma y notarizacion macOS

Por ahora el workflow no exige secrets de GitHub para macOS. Esto permite publicar la v0.1.11 sin bloquear el release.

Cuando decidamos activar firma y notarizacion, necesitaremos configurar:

- `MACOS_CSC_LINK`: certificado Developer ID Application exportado como `.p12` en base64.
- `MACOS_CSC_KEY_PASSWORD`: password del `.p12`.
- `APPLE_ID`: Apple ID usado para notarizar.
- `APPLE_APP_SPECIFIC_PASSWORD`: app-specific password de Apple ID.
- `APPLE_TEAM_ID`: Team ID de Apple Developer.

En ese momento tambien se debe volver a activar `notarize` en `package.json` y pasar los secrets al job macOS.

## Integracion con SofLIA - Engine

En produccion, la app debe apuntar a la URL publica de SofLIA - Engine:

```txt
https://soflia-coursegen.netlify.app
```

`localhost` solo debe usarse en desarrollo.

La app no usa `SUPABASE_SERVICE_ROLE_KEY`, no consulta Supabase directo y no decide permisos. Todo eso vive en SofLIA - Engine server-side.

## Contrato de jobs y cola

El worker usa `claim-next` para reclamar jobs en orden. El procesamiento local es secuencial:

1. El worker reporta `ONLINE`.
2. Reclama el siguiente job disponible.
3. Reporta progreso al backend y a la UI local.
4. Completa o falla el job.
5. Vuelve a reclamar el siguiente job disponible.

La UI local muestra:

- Job actual.
- Composicion.
- Etapa.
- Porcentaje.
- Historial reciente.

Para mostrar "N videos en espera", el backend debe entregar metadata adicional como `queueTotal` o `queuePosition`.

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
