# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Electron desktop app ("SofLIA Engine Render Worker") that lets a user's own computer render videos for SofLIA - Engine. It links to the backend with a temporary pairing code, polls for authorized Remotion render/build/preview jobs, renders them locally, uploads the artifact via a signed URL, and confirms completion back to the backend. A CLI (`dist/cli.js`) exposes the same worker loop for headless/dev use; the Electron app is the primary shipped product.

The backend of record is SofLIA - Engine / Courseforge (separate repo at `D:\Pulse Hub\courseforge` in this dev environment). This app never talks to Supabase directly and holds no service-role credentials — all authorization and job-source-of-truth logic lives server-side. Production backend: `https://soflia-coursegen.netlify.app` (see `src/shared/app-defaults.ts`).

## Commands

```powershell
npm install                 # install deps
npm run electron:dev        # build main + launch Electron in dev (renderer dev server via scripts/electron-dev.mjs)
npm run build               # build:main (tsc + icons + copy assets) then build:renderer (vite build)
npm run test                # build, then run node's built-in test runner over dist/__tests__/*.test.js
npm run package:win         # build + electron-builder NSIS installer (release/)
npm run package:mac         # build + electron-builder dmg/zip (unsigned, no notarization yet)
npm run package:linux       # build + electron-builder AppImage/deb
```

There is no separate lint/typecheck script — `tsc -p tsconfig.json` (run as part of `build`) is the type check, and it must pass with no errors (`strict: true`).

Tests are plain `.ts` files under `src/__tests__/`, compiled to `dist/__tests__/*.test.js` and run with Node's native test runner (`node --test`), not Jest/Vitest. To run one test file after building:

```powershell
npm run build
node --test dist/__tests__/worker-loop.test.js
```

CLI commands for manual/dev use against a running backend (see `src/cli.ts`):

```powershell
node dist/cli.js link --api-url <url> --code <SLIA-000000>
node dist/cli.js doctor
node dist/cli.js start
node dist/cli.js render --job-id <production_job_id>
node dist/cli.js configure --api-url <url> --token <worker_token>   # dev-only manual token fallback
```

## Architecture

**Two entry points, one shared worker loop.** `src/electron-main.ts` (Electron main process) and `src/cli.ts` (headless CLI) both ultimately drive `src/worker-loop.ts`'s `startWorkerLoop()`. Electron wraps it with an `AbortController`, forwards `WorkerRuntimeEvent`s to the renderer over IPC (`worker:event` channel), and layers on tray/window/auto-update/resource-monitor/telemetry concerns. The renderer (`src/renderer/`, Vite + React) never touches Node/Electron APIs directly — it only calls the `window.sofliaWorker` bridge defined in `src/electron-preload.cjs` (contextIsolation on, nodeIntegration off).

**Job types.** The backend hands out three kinds of jobs through the same claim/poll cycle (`ClaimedJob` union in `src/api-client.ts`): `render` (a production video), `template_build` (compiles a Remotion template bundle), `template_preview` (renders a poster/preview for a template). `worker-loop.ts` dispatches to `render.ts`, `template-build.ts`, or `template-preview.ts` respectively; `template_preview` jobs in a batch are processed concurrently, everything else sequentially.

**Poll/claim/report cycle** (`worker-loop.ts`): heartbeat `ONLINE` with capacity + active job ids + local-recovery summary -> `claimNextBatch()` (falls back to single `claimNext()` if the client doesn't support batching) -> process each job, emitting `WorkerRuntimeEvent`s with stage/percent/timing at every step -> on success, backend is already confirmed by the job handler; on failure, report via `client.fail()` and persist to the local store; on empty queue, sleep `pollIntervalMs` (default 5000ms, min 1000ms) and repeat. SIGINT/SIGTERM or an `AbortSignal` stop the loop after the current cycle.

**Render pipeline** (`render.ts`): download+extract the Remotion bundle (or use an approved external `serve_url` directly) -> prepare known remote media/font asset URLs through `render-asset-preparer.ts` as local files served from a per-job `127.0.0.1` server, including byte-count checks and local audio/video duration preflight via `mediabunny` -> `ensureBrowser()` -> `selectComposition()` -> `renderMedia()` with fine-grained progress callbacks (asset download, frame render, encoding, muxing) mapped to a single 0-100 percent reported both to the backend (`client.progress`) and the local UI (`onProgress`). Render progress reports are throttled by percent/stage/time so the lease stays fresh without flooding Engine. Then sha256 checksum the output -> stream-upload the MP4 via `fetch(..., { method: 'PUT', duplex: 'half' })` to the signed URL -> `client.complete()`. Upload and complete failures throw `RecoverableJobError` (see below) rather than failing the job outright.

**Local recovery / crash resilience.** `src/local-job-store.ts` wraps a `node:sqlite` `DatabaseSync` at `<workspace>/state/worker-state.db` (WAL mode). It never stores video bytes — only status, local artifact path, checksum, retry count, and cleanup policy. `src/local-job-state.ts` defines the status/type enums and the `LocalCleanupPolicy` (`delete_on_remote_confirm` default, or `keep_all`). `src/recoverable-job-error.ts` defines `RecoverableJobError` (stage `'upload' | 'complete'`), which `worker-loop.ts` catches specially — it does NOT call `client.fail()` for these, since the artifact is safe locally and the loop's long-lived `RecoveryCoordinator` (`src/recovery-coordinator.ts`) will retry the upload URL refresh + upload + complete with per-job exponential backoff. This is the mechanism behind "app or PC restarts mid-upload/confirm, worker resumes on next start."
If Engine later rejects completion with a terminal 409 (`JOB_NOT_CLAIMABLE`, already completed with different output, forbidden worker, unsupported type/provider) or 422 `OUTPUT_DURATION_MISMATCH`, recovery marks the local job `failed_non_recoverable` and preserves the artifact for review instead of retrying forever.

**Workspace cleanup.** `src/job-workspace-cleanup.ts` removes stale or completed per-job workspaces under `renders/`, `template-builds/`, and `template-previews/`, but preserves any workspace whose local job record still has a recoverable artifact/checksum. Recovery must upload/complete first; retention cleanup runs only after remote confirmation. The settings UI also exposes a manual local cleanup action that stops the worker, clears the local SQLite queue/events via `LocalJobStore.clearAllLocalJobs()`, and removes all worker-owned job workspaces without changing any remote Engine job or asset.

**Config & paths.** `src/paths.ts` resolves an OS-appropriate app-data dir (`%APPDATA%\SofLIA Engine Render Worker` on Windows, etc.) and forces `process.chdir()` into a writable workspace subdirectory there — required because Remotion derives its Chromium/browser download cache from `process.cwd()`, and installed Windows builds run from `Program Files` (not writable). `src/config.ts` persists `apiUrl`/`token`/power-profile/retention-policy as JSON (mode `0600`) at `getConfigPath()`. Power profiles (`light`/`balanced`/`high`/`max`, `src/shared/worker-capacity.ts`) bundle `maxConcurrentJobs`, `renderConcurrency`, `hardwareAcceleration`, `chromiumGl`, and `videoBitrate` as one user-facing dial.

**API client** (`src/api-client.ts`): thin fetch wrapper over `/api/v1/production/remotion/workers/*` REST endpoints (link, heartbeat, claim/claim-next, progress, complete, refresh-upload-url, fail, telemetry runs/samples/finish). Bearer token auth except on `linkWorker`. All error messages are passed through `sanitizeLog()` (`src/logging.ts`) before surfacing — never log tokens, signed URLs, or raw local paths.

**Telemetry.** `src/worker-telemetry-service.ts` + `src/worker-telemetry-store.ts` capture per-phase render performance (bundle download, Chromium prep, frame render, encoding, upload, etc.) and system resource snapshots (`src/resource-monitor.ts`), batching them up to the backend telemetry endpoints for now-fine-grained visibility in SofLIA - Engine's UI.

**Shared types** live in `src/shared/` and are imported by both main-process and renderer code (via Vite/tsc, not IPC-serialized) — `worker-events.ts` (the `WorkerRuntimeEvent`/`RenderProgressEvent` shapes flowing over IPC), `worker-capacity.ts`, `resource-metrics.ts`, `update-types.ts`, `worker-telemetry.ts`.

## Conventions and constraints

- User-facing strings (README, CLI output, UI copy, error messages) are in Spanish; keep new user-facing text consistent with that.
- Never log or persist worker tokens, signed upload URLs, or Supabase-derived secrets — route error messages through `sanitizeLog()`.
- The app must not gain direct Supabase access or a service-role key; all job authorization stays server-side in Courseforge/SofLIA - Engine.
- Renderer code only reaches Node/Electron through the `window.sofliaWorker` preload bridge — don't add `nodeIntegration` or bypass `contextIsolation`.
- A partial `renderMedia()` render is not resumable — an interrupted render restarts from scratch. Only the post-render (artifact-ready -> upload -> complete) stages are crash-recoverable via `LocalJobStore`/`RecoverableJobError`.
- Windows auto-update depends on `latest.yml` and the exact asset naming (`SofLIA-Engine-Render-Worker-<OS>-<arch>.<ext>`) produced by `.github/workflows/desktop-installers.yml` — don't rename release assets without updating both the workflow and the download page in Courseforge.
- Release tags must be `vX.Y.Z` and must exactly match `package.json`'s `version` (the workflow enforces this); `src/shared/app-defaults.ts`'s `APP_DISPLAY_VERSION` should be bumped alongside it. See `PROTOCOLO_ACTUALIZACION_WORKER.md` for the full release checklist (version bump locations across both this repo and `courseforge`, required validations, asset list, tag/push sequence).
- `npm run test` (which builds first) must pass before tagging or publishing a release — don't skip or ignore TypeScript/test failures to unblock a release.
