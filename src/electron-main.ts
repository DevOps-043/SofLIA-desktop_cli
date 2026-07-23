import { app, BrowserWindow, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import electronUpdater from 'electron-updater';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SofliaWorkerApiClient } from './api-client.js';
import { clearWorkerLink, loadConfig, loadOptionalConfig, saveConfig, saveConfigSettings } from './config.js';
import { normalizeLocalRetentionPolicy } from './local-job-state.js';
import { LocalJobStore } from './local-job-store.js';
import { sanitizeLog } from './logging.js';
import { configureWritableWorkingDirectory, getAppDataDir, getConfigPath } from './paths.js';
import { DEFAULT_WORKER_POWER_PROFILE, getWorkerPowerProfile } from './shared/worker-capacity.js';
import type { AppUpdateState } from './shared/update-types.js';
import { getWorkerStartMessage, getWorkerStatusMessage } from './worker-link-state.js';
import { startWorkerLoop } from './worker-loop.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appVersion = app.getVersion() || 'dev';
const { autoUpdater } = electronUpdater;
type ThemeMode = 'light' | 'dark';

function configureChromiumStoragePaths(): void {
  const appDataDir = getAppDataDir();
  const sessionDataDir = path.join(appDataDir, 'electron-session');
  const cacheDir = path.join(appDataDir, 'electron-cache');
  fs.mkdirSync(sessionDataDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  app.setPath('sessionData', sessionDataDir);
  app.setPath('cache', cacheDir);
}

configureChromiumStoragePaths();
configureWritableWorkingDirectory();

if (process.platform === 'win32') {
  app.setAppUserModelId('com.soflia.engine.render-worker');
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let workerAbortController: AbortController | null = null;
let closeToTray = true;
let isQuitting = false;
const rendererDevUrl = process.env.SOFLIA_RENDERER_DEV_URL;
const updateFeedUrl = process.env.SOFLIA_UPDATE_FEED_URL || 'https://github.com/DevOps-043/SofLIA-desktop_cli/releases/latest/download';
const updatesEnabled = app.isPackaged && process.env.SOFLIA_DISABLE_AUTO_UPDATE !== '1';
let updateState: AppUpdateState = {
  status: updatesEnabled ? 'idle' : 'disabled',
  currentVersion: appVersion,
  message: updatesEnabled ? undefined : 'Las actualizaciones automaticas se activan en la app instalada.',
};

function getAssetPath(fileName: string): string {
  return path.join(__dirname, 'assets', fileName);
}

function getAppIcon() {
  return nativeImage.createFromPath(getAssetPath('app-icon.png'));
}

function getTrayIcon() {
  const icon = nativeImage.createFromPath(getAssetPath('tray-icon.png'));
  if (icon.isEmpty()) return nativeImage.createEmpty();
  return icon.resize({ width: 16, height: 16 });
}

function getTitleBarOverlay(theme: ThemeMode) {
  if (theme === 'light') {
    return {
      color: '#F3F8FA',
      symbolColor: '#0A2540',
      height: 32,
    };
  }
  return {
    color: '#0F1419',
    symbolColor: '#FFFFFF',
    height: 32,
  };
}

function applyWindowTheme(theme: ThemeMode): void {
  if (!mainWindow) return;
  const backgroundColor = theme === 'light' ? '#F3F8FA' : '#0F1419';
  mainWindow.setBackgroundColor(backgroundColor);
  mainWindow.setTitleBarOverlay(getTitleBarOverlay(theme));
}

function normalizeApiUrl(apiUrl: string): string {
  return apiUrl.trim().replace(/\/+$/, '');
}

function send(channel: string, payload: unknown): void {
  mainWindow?.webContents.send(channel, payload);
}

function publishUpdateState(nextState: Partial<AppUpdateState>): AppUpdateState {
  updateState = {
    ...updateState,
    ...nextState,
    currentVersion: appVersion,
  };
  send('app:update-status', updateState);
  return updateState;
}

function configureAutoUpdates(): void {
  if (!updatesEnabled) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: updateFeedUrl,
  });

  autoUpdater.on('checking-for-update', () => {
    publishUpdateState({ status: 'checking', message: 'Buscando actualizaciones.' });
  });

  autoUpdater.on('update-available', (info) => {
    publishUpdateState({
      status: 'available',
      version: info.version,
      percent: undefined,
      message: `La version ${info.version} esta disponible.`,
    });
  });

  autoUpdater.on('update-not-available', () => {
    publishUpdateState({
      status: 'not-available',
      percent: undefined,
      message: 'Ya tienes la version mas reciente.',
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    publishUpdateState({
      status: 'downloading',
      percent: Math.round(progress.percent),
      message: 'Descargando la actualizacion.',
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    publishUpdateState({
      status: 'downloaded',
      version: info.version,
      percent: 100,
      message: 'Actualizacion lista. Instala y reinicia para terminar.',
    });
  });

  autoUpdater.on('error', (error) => {
    publishUpdateState({
      status: 'error',
      percent: undefined,
      message: sanitizeLog(error instanceof Error ? error.message : String(error)),
    });
  });
}

async function checkForUpdates(): Promise<AppUpdateState> {
  if (!updatesEnabled) return updateState;
  publishUpdateState({ status: 'checking', message: 'Buscando actualizaciones.' });
  await autoUpdater.checkForUpdates();
  return updateState;
}

async function downloadUpdate(): Promise<AppUpdateState> {
  if (!updatesEnabled) return updateState;
  publishUpdateState({ status: 'downloading', percent: 0, message: 'Descargando la actualizacion.' });
  await autoUpdater.downloadUpdate();
  return updateState;
}

async function installDownloadedUpdate(): Promise<AppUpdateState> {
  if (updateState.status !== 'downloaded') return updateState;
  isQuitting = true;
  await stopWorker();
  autoUpdater.quitAndInstall(true, true);
  return publishUpdateState({ status: 'downloaded', message: 'Instalando actualizacion y reiniciando.' });
}

function createTray(): void {
  const icon = getTrayIcon();
  tray = new Tray(icon);
  tray.setToolTip('SofLIA - Engine Render Worker');
  tray.on('double-click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Mostrar',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    {
      label: 'Mantener en segundo plano',
      type: 'checkbox',
      checked: closeToTray,
      click: (menuItem) => {
        closeToTray = menuItem.checked;
        send('app:settings', { closeToTray });
      },
    },
    {
      label: 'Salir',
      click: () => {
        void requestQuit();
      },
    },
  ]));
}

function updateTrayMenu(): void {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Mostrar',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    {
      label: 'Mantener en segundo plano',
      type: 'checkbox',
      checked: closeToTray,
      click: (menuItem) => {
        closeToTray = menuItem.checked;
        send('app:settings', { closeToTray });
      },
    },
    {
      label: 'Salir',
      click: () => {
        void requestQuit();
      },
    },
  ]));
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 620,
    minWidth: 420,
    minHeight: 540,
    title: 'SofLIA - Engine Render Worker',
    icon: getAppIcon(),
    autoHideMenuBar: true,
    backgroundColor: '#0F1419',
    titleBarStyle: 'hidden',
    titleBarOverlay: getTitleBarOverlay('dark'),
    webPreferences: {
      preload: path.join(__dirname, 'electron-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('Renderer load failed', sanitizeLog(JSON.stringify({ errorCode, errorDescription, validatedURL })));
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer process gone', sanitizeLog(JSON.stringify(details)));
  });

  mainWindow.webContents.on('console-message', (event) => {
    const { level, message } = event;
    if (level === 'warning' || level === 'error') {
      console.error('Renderer console:', sanitizeLog(message));
    }
  });

  if (rendererDevUrl) {
    mainWindow.loadURL(rendererDevUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  }

  mainWindow.on('close', async (event) => {
    if (isQuitting || !closeToTray) {
      await stopWorker();
      return;
    }
    event.preventDefault();
    mainWindow?.hide();
  });
}

async function getStatus() {
  try {
    const config = await loadConfig();
    const localRecovery = await readLocalRecoverySummary();
    closeToTray = config.closeToTray !== false;
    const client = new SofliaWorkerApiClient(config.apiUrl, config.token);
    const heartbeat = await client.heartbeat(workerAbortController ? 'BUSY' : 'OFFLINE', {
      maxConcurrentJobs: config.maxConcurrentJobs,
    });
    return {
      configured: true,
      apiUrl: config.apiUrl,
      configPath: getConfigPath(),
      running: Boolean(workerAbortController),
      closeToTray,
      powerProfile: config.powerProfile,
      maxConcurrentJobs: config.maxConcurrentJobs,
      renderConcurrency: config.renderConcurrency,
      localRetentionPolicy: config.localRetentionPolicy,
      localRecovery,
      worker: heartbeat.worker || heartbeat,
    };
  } catch (error) {
    const config = await loadOptionalConfig();
    const powerProfile = getWorkerPowerProfile(config.powerProfile || DEFAULT_WORKER_POWER_PROFILE);
    const localRecovery = await readLocalRecoverySummary();
    closeToTray = config.closeToTray !== false;
    return {
      configured: false,
      apiUrl: config.apiUrl,
      configPath: getConfigPath(),
      running: Boolean(workerAbortController),
      closeToTray,
      powerProfile: powerProfile.id,
      maxConcurrentJobs: powerProfile.maxConcurrentJobs,
      renderConcurrency: powerProfile.renderConcurrency,
      localRetentionPolicy: normalizeLocalRetentionPolicy(config.localRetentionPolicy),
      localRecovery,
      message: getWorkerStatusMessage(error),
    };
  }
}

async function readLocalRecoverySummary() {
  const store = new LocalJobStore();
  try {
    await store.initialize();
    return store.getRecoverySummary();
  } catch {
    return { pendingUploads: 0, pendingCompletes: 0, pendingCleanup: 0, retainedBytes: 0 };
  } finally {
    store.close();
  }
}

async function startWorker() {
  if (workerAbortController) {
    return { started: false, message: 'El worker ya esta corriendo.' };
  }

  try {
    const config = await loadConfig();
    await new SofliaWorkerApiClient(config.apiUrl, config.token).heartbeat('ONLINE', {
      maxConcurrentJobs: config.maxConcurrentJobs,
    });
  } catch (error) {
    const message = getWorkerStartMessage(error);
    return { started: false, message };
  }

  workerAbortController = new AbortController();
  void startWorkerLoop({
    signal: workerAbortController.signal,
    onStatus: (event) => send('worker:event', event),
  }).catch((error) => {
    send('worker:event', {
      state: 'error',
      message: sanitizeLog(error instanceof Error ? error.message : String(error)),
    });
  }).finally(() => {
    workerAbortController = null;
    send('worker:event', { state: 'stopped', message: 'Worker detenido' });
  });

  return { started: true };
}

async function startWorkerIfConfigured() {
  try {
    await loadConfig();
    return await startWorker();
  } catch {
    return { started: false };
  }
}

async function stopWorker() {
  if (!workerAbortController) return { stopped: false };
  workerAbortController.abort();
  workerAbortController = null;
  try {
    const config = await loadConfig();
    await new SofliaWorkerApiClient(config.apiUrl, config.token).heartbeat('OFFLINE', {
      maxConcurrentJobs: config.maxConcurrentJobs,
    });
  } catch {
    // Best-effort only.
  }
  return { stopped: true };
}

async function requestQuit() {
  isQuitting = true;
  await stopWorker();
  app.quit();
  return { quitting: true };
}

async function clearLink() {
  await stopWorker();
  await clearWorkerLink();
  send('worker:event', {
    state: 'stopped',
    message: 'Vinculacion local limpiada. Genera un codigo nuevo en SofLIA para conectar este equipo.',
  });
  return { cleared: true };
}

async function setApiUrl(_event: Electron.IpcMainInvokeEvent, rawApiUrl: string) {
  const apiUrl = normalizeApiUrl(String(rawApiUrl || ''));
  if (!/^https?:\/\/[\w.-]+(?::\d+)?(?:\/.*)?$/i.test(apiUrl)) {
    throw new Error('Direccion de SofLIA invalida. Usa una URL http(s), por ejemplo http://localhost:3000.');
  }

  const shouldRestart = Boolean(workerAbortController);
  if (shouldRestart) {
    await stopWorker();
  }

  await saveConfigSettings({ apiUrl });

  if (!shouldRestart) {
    return { apiUrl, restarted: false, message: 'Direccion guardada. Inicia el worker para usarla.' };
  }

  const result = await startWorker();
  const restarted = isActionStarted(result);
  return {
    apiUrl,
    restarted,
    message: restarted
      ? 'Direccion guardada y worker reiniciado.'
      : result.message || 'Direccion guardada, pero el worker no pudo reiniciarse.',
  };
}

async function setPowerProfile(_event: Electron.IpcMainInvokeEvent, rawPowerProfile: string) {
  const powerProfile = getWorkerPowerProfile(String(rawPowerProfile || ''));
  const shouldRestart = Boolean(workerAbortController);
  if (shouldRestart) {
    await stopWorker();
  }

  await saveConfigSettings({ powerProfile: powerProfile.id });
  const savedConfig = await loadOptionalConfig();
  if (savedConfig.powerProfile !== powerProfile.id) {
    throw new Error('No se pudo guardar el perfil de potencia en la configuracion local.');
  }
  send('app:settings', {
    closeToTray,
    powerProfile: powerProfile.id,
    maxConcurrentJobs: powerProfile.maxConcurrentJobs,
    renderConcurrency: powerProfile.renderConcurrency,
  });

  if (!shouldRestart) {
    return {
      powerProfile: powerProfile.id,
      maxConcurrentJobs: powerProfile.maxConcurrentJobs,
      renderConcurrency: powerProfile.renderConcurrency,
      restarted: false,
      message: 'Perfil de potencia guardado. Se aplicara al iniciar el worker.',
    };
  }

  const result = await startWorker();
  const restarted = isActionStarted(result);
  return {
    powerProfile: powerProfile.id,
    maxConcurrentJobs: powerProfile.maxConcurrentJobs,
    renderConcurrency: powerProfile.renderConcurrency,
    restarted,
    message: restarted
      ? 'Perfil de potencia guardado y worker reiniciado.'
      : result.message || 'Perfil guardado, pero el worker no pudo reiniciarse.',
  };
}

function isActionStarted(value: unknown): value is { started: true } {
  return Boolean(value && typeof value === 'object' && (value as { started?: unknown }).started === true);
}

ipcMain.handle('app:get-status', getStatus);
ipcMain.handle('app:get-update-status', () => updateState);
ipcMain.handle('app:check-for-updates', checkForUpdates);
ipcMain.handle('app:download-update', downloadUpdate);
ipcMain.handle('app:install-update', installDownloadedUpdate);

ipcMain.handle('app:link', async (_event, input: { apiUrl: string; code: string }) => {
  const apiUrl = normalizeApiUrl(input.apiUrl || '');
  const code = String(input.code || '').trim().toUpperCase();
  if (!apiUrl || !/^SLIA-\d{6}$/.test(code)) {
    throw new Error('API URL y codigo SLIA-000000 son requeridos.');
  }

  const client = new SofliaWorkerApiClient(apiUrl);
  const result = await client.linkWorker({
    code,
    deviceName: os.hostname() || 'SofLIA Render Worker',
    platform: process.platform,
    arch: process.arch,
    appVersion,
  });

  await saveConfig({ apiUrl, token: result.workerToken });
  const linkedConfig = await loadConfig();
  await new SofliaWorkerApiClient(apiUrl, result.workerToken).heartbeat('OFFLINE', {
    maxConcurrentJobs: linkedConfig.maxConcurrentJobs,
  });
  await startWorker();
  return {
    workerId: result.worker.id,
    deviceName: result.worker.device_name,
    tokenLast4: result.worker.token_last4,
    configPath: getConfigPath(),
  };
});

ipcMain.handle('app:clear-link', clearLink);
ipcMain.handle('app:start-worker', startWorker);
ipcMain.handle('app:stop-worker', stopWorker);
ipcMain.handle('app:set-api-url', setApiUrl);
ipcMain.handle('app:set-power-profile', setPowerProfile);

ipcMain.handle('app:set-local-retention-policy', async (_event, rawPolicy: string) => {
  const localRetentionPolicy = normalizeLocalRetentionPolicy(rawPolicy);
  await saveConfigSettings({ localRetentionPolicy });
  send('app:settings', { localRetentionPolicy });
  return {
    localRetentionPolicy,
    message: localRetentionPolicy === 'keep_all'
      ? 'La app conservara copias locales despues de confirmar en SofLIA.'
      : 'La app borrara artefactos locales despues de confirmar en SofLIA.',
  };
});

ipcMain.handle('app:set-close-to-tray', (_event, value: boolean) => {
  closeToTray = Boolean(value);
  void saveConfigSettings({ closeToTray });
  send('app:settings', { closeToTray });
  updateTrayMenu();
  return { closeToTray };
});

ipcMain.handle('app:quit', requestQuit);

ipcMain.handle('app:set-theme', (_event, theme: ThemeMode) => {
  const safeTheme = theme === 'light' ? 'light' : 'dark';
  applyWindowTheme(safeTheme);
  return { theme: safeTheme };
});

ipcMain.handle('app:open-external', (_event, url: string) => {
  if (/^https?:\/\//i.test(url)) {
    void shell.openExternal(url);
  }
});

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  configureAutoUpdates();
  const config = await loadOptionalConfig();
  closeToTray = config.closeToTray !== false;
  createTray();
  createWindow();
  void startWorkerIfConfigured();
  setTimeout(() => {
    void checkForUpdates().catch(() => {
      // The updater event handler publishes sanitized errors.
    });
  }, 2500);
});

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
  mainWindow?.show();
});

app.on('before-quit', async () => {
  isQuitting = true;
  await stopWorker();
});
