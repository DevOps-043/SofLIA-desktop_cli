import { app, BrowserWindow, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import electronUpdater from 'electron-updater';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SofliaWorkerApiClient } from './api-client.js';
import { loadConfig, loadOptionalConfig, saveConfig, saveConfigSettings } from './config.js';
import { sanitizeLog } from './logging.js';
import { getConfigPath } from './paths.js';
import type { AppUpdateState } from './shared/update-types.js';
import { startWorkerLoop } from './worker-loop.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appVersion = app.getVersion() || 'dev';
const { autoUpdater } = electronUpdater;
type ThemeMode = 'light' | 'dark';

if (process.platform === 'win32') {
  app.setAppUserModelId('com.soflia.engine.render-worker');
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
      message: 'Actualizacion lista. Reinicia para terminar la instalacion.',
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
  autoUpdater.quitAndInstall(false, true);
  return publishUpdateState({ status: 'downloaded', message: 'Reiniciando para instalar.' });
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
    closeToTray = config.closeToTray !== false;
    const client = new SofliaWorkerApiClient(config.apiUrl, config.token);
    const heartbeat = await client.heartbeat(workerAbortController ? 'BUSY' : 'OFFLINE');
    return {
      configured: true,
      apiUrl: config.apiUrl,
      configPath: getConfigPath(),
      running: Boolean(workerAbortController),
      closeToTray,
      worker: heartbeat.worker || heartbeat,
    };
  } catch (error) {
    const config = await loadOptionalConfig();
    closeToTray = config.closeToTray !== false;
    return {
      configured: false,
      running: Boolean(workerAbortController),
      closeToTray,
      message: sanitizeLog(error instanceof Error ? error.message : String(error)),
    };
  }
}

async function startWorker() {
  if (workerAbortController) {
    return { started: false, message: 'El worker ya esta corriendo.' };
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
    await new SofliaWorkerApiClient(config.apiUrl, config.token).heartbeat('OFFLINE');
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
  await new SofliaWorkerApiClient(apiUrl, result.workerToken).heartbeat('OFFLINE');
  await startWorker();
  return {
    workerId: result.worker.id,
    deviceName: result.worker.device_name,
    tokenLast4: result.worker.token_last4,
    configPath: getConfigPath(),
  };
});

ipcMain.handle('app:start-worker', startWorker);
ipcMain.handle('app:stop-worker', stopWorker);

ipcMain.handle('app:set-close-to-tray', (_event, value: boolean) => {
  closeToTray = Boolean(value);
  void saveConfigSettings({ closeToTray });
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
