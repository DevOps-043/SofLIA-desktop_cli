import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { APP_DISPLAY_VERSION, DEFAULT_API_URL } from '../shared/app-defaults';
import type { AppUpdateState } from '../shared/update-types';
import type { WorkerRuntimeEvent } from '../shared/worker-events';
import './styles.css';

type WorkerStatus = {
  configured: boolean;
  apiUrl?: string;
  configPath?: string;
  running: boolean;
  closeToTray: boolean;
  message?: string;
  worker?: {
    status?: string;
    device_name?: string;
    last_heartbeat_at?: string;
  };
};

type LinkResult = {
  workerId: string;
  deviceName?: string;
  tokenLast4?: string;
  configPath: string;
};

type LogLine = {
  id: string;
  message: string;
  tone: 'ok' | 'warn' | 'bad' | 'info' | 'busy';
};

declare global {
  interface Window {
    sofliaWorker: {
      getStatus: () => Promise<WorkerStatus>;
      link: (input: { apiUrl: string; code: string }) => Promise<LinkResult>;
      startWorker: () => Promise<unknown>;
      stopWorker: () => Promise<unknown>;
      setCloseToTray: (value: boolean) => Promise<{ closeToTray: boolean }>;
      setTheme: (theme: 'light' | 'dark') => Promise<{ theme: 'light' | 'dark' }>;
      getUpdateStatus: () => Promise<AppUpdateState>;
      checkForUpdates: () => Promise<AppUpdateState>;
      downloadUpdate: () => Promise<AppUpdateState>;
      installUpdate: () => Promise<AppUpdateState>;
      quit: () => Promise<unknown>;
      openExternal: (url: string) => Promise<void>;
      onUpdateStatus: (callback: (payload: AppUpdateState) => void) => () => void;
      onSettings: (callback: (payload: { closeToTray: boolean }) => void) => () => void;
      onWorkerEvent: (callback: (event: WorkerRuntimeEvent) => void) => () => void;
    };
  }
}

function formatTime() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function getInitialTheme(): 'light' | 'dark' {
  const stored = window.localStorage.getItem('soflia-theme');
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function getFriendlyWorkerEvent(event: WorkerRuntimeEvent): Pick<LogLine, 'message' | 'tone'> {
  if (event.state === 'starting') return { message: 'Preparando la conexion con SofLIA.', tone: 'info' };
  if (event.state === 'online') return { message: 'Tu equipo esta disponible para renderizar.', tone: 'ok' };
  if (event.state === 'idle') return { message: 'Sin videos pendientes por ahora.', tone: 'info' };
  if (event.state === 'claiming') return { message: `SofLIA envio el job ${formatJobId(event.jobId)} a este equipo.`, tone: 'info' };
  if (event.state === 'rendering') return { message: `${event.message} (${event.percent ?? 0}%).`, tone: 'busy' };
  if (event.state === 'completed') return { message: `Job ${formatJobId(event.jobId)} terminado y enviado a SofLIA.`, tone: 'ok' };
  if (event.state === 'error') return { message: 'No se pudo completar el render. Revisa la conexion e intenta de nuevo.', tone: 'bad' };
  return { message: 'Render local detenido.', tone: 'warn' };
}

function formatJobId(jobId?: string): string {
  if (!jobId) return 'actual';
  if (jobId.length <= 12) return jobId;
  return `${jobId.slice(0, 8)}...${jobId.slice(-4)}`;
}

function Badge({ text, kind = '' }: { text: string; kind?: 'ok' | 'busy' | 'bad' | 'warn' | '' }) {
  return <span className={`badge ${kind}`.trim()}>{text}</span>;
}

function getUpdateBadge(updateState: AppUpdateState): { text: string; kind: 'ok' | 'busy' | 'bad' | 'warn' | '' } {
  if (updateState.status === 'available') return { text: 'Disponible', kind: 'warn' };
  if (updateState.status === 'downloading' || updateState.status === 'checking') return { text: 'En progreso', kind: 'busy' };
  if (updateState.status === 'downloaded') return { text: 'Lista', kind: 'ok' };
  if (updateState.status === 'error') return { text: 'Error', kind: 'bad' };
  if (updateState.status === 'disabled') return { text: 'Instalada', kind: '' };
  return { text: 'Actualizada', kind: 'ok' };
}

function getUpdateMessage(updateState: AppUpdateState): string {
  if (updateState.message) return updateState.message;
  if (updateState.status === 'idle') return 'La app buscara nuevas versiones publicadas en GitHub Releases.';
  if (updateState.status === 'available') return `La version ${updateState.version} esta disponible.`;
  if (updateState.status === 'downloaded') return 'Actualizacion lista. Reinicia para terminar la instalacion.';
  return 'Ya tienes la version mas reciente.';
}

function BrandMark() {
  const [showLogo, setShowLogo] = useState(true);
  if (!showLogo) return <div className="brand-mark-fallback" aria-hidden="true">S</div>;
  return (
    <div className="brand-mark">
      <img src="/soflia-logo.png" alt="SofLIA" onError={() => setShowLogo(false)} />
    </div>
  );
}

function App() {
  const [apiUrl, setApiUrl] = useState(DEFAULT_API_URL);
  const [code, setCode] = useState('');
  const [theme, setTheme] = useState<'light' | 'dark'>(() => getInitialTheme());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [status, setStatus] = useState<WorkerStatus>({ configured: false, running: false, closeToTray: true });
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState<AppUpdateState>({ status: 'idle', currentVersion: APP_DISPLAY_VERSION });
  const [currentJob, setCurrentJob] = useState<WorkerRuntimeEvent | null>(null);

  const addLog = useCallback((message: string, tone: LogLine['tone'] = 'info') => {
    setLogs((current) => [
      { id: `${Date.now()}-${Math.random()}`, message: `${formatTime()} - ${message}`, tone },
      ...current,
    ].slice(0, 8));
  }, []);

  const refreshStatus = useCallback(async () => {
    const nextStatus = await window.sofliaWorker.getStatus();
    setStatus(nextStatus);
    if (nextStatus.apiUrl) setApiUrl(nextStatus.apiUrl);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem('soflia-theme', theme);
    void window.sofliaWorker.setTheme(theme);
  }, [theme]);

  useEffect(() => {
    const removeWorkerListener = window.sofliaWorker.onWorkerEvent((event) => {
      const friendlyEvent = getFriendlyWorkerEvent(event);
      addLog(friendlyEvent.message, friendlyEvent.tone);
      if (event.state === 'stopped') setStatus((current) => ({ ...current, running: false }));
      if (event.state === 'claiming' || event.state === 'rendering' || event.state === 'starting') {
        setStatus((current) => ({ ...current, running: true }));
      }
      if (event.state === 'claiming' || event.state === 'rendering') {
        setCurrentJob(event);
      }
      if (event.state === 'completed' || event.state === 'error') {
        setCurrentJob((current) => current?.jobId === event.jobId ? { ...current, ...event } : event);
      }
      if (event.state === 'idle' || event.state === 'stopped') {
        setCurrentJob(null);
      }
    });
    const removeSettingsListener = window.sofliaWorker.onSettings((payload) => {
      setStatus((current) => ({ ...current, closeToTray: payload.closeToTray }));
    });
    const removeUpdateListener = window.sofliaWorker.onUpdateStatus((payload) => {
      setUpdateState(payload);
    });
    refreshStatus().catch((error) => addLog(getErrorMessage(error), 'bad'));
    window.sofliaWorker.getUpdateStatus().then(setUpdateState).catch((error) => addLog(getErrorMessage(error), 'bad'));
    return () => {
      removeWorkerListener();
      removeSettingsListener();
      removeUpdateListener();
    };
  }, [addLog, refreshStatus]);

  const statusBadge = status.configured
    ? { text: 'Vinculado', kind: 'ok' as const }
    : { text: 'Pendiente', kind: 'warn' as const };
  const runBadge = status.running
    ? { text: 'Disponible', kind: 'busy' as const }
    : { text: 'Pausado', kind: '' as const };
  const updateBadge = getUpdateBadge(updateState);
  const updateBusy = updateState.status === 'checking' || updateState.status === 'downloading';
  const lastHeartbeat = status.worker?.last_heartbeat_at
    ? new Date(status.worker.last_heartbeat_at).toLocaleString()
    : 'Sin actividad reciente.';
  const statusTitle = status.running
    ? 'Render local activo'
    : status.configured
      ? 'Render local pausado'
      : 'Equipo sin vincular';
  const statusDetail = status.running
    ? 'Este equipo esta listo para recibir renders de SofLIA.'
    : status.configured
      ? 'El equipo esta vinculado. Puedes activar o detener el render local cuando lo necesites.'
      : 'Vincula este equipo con el codigo temporal generado desde SofLIA.';
  const currentJobPercent = Math.max(0, Math.min(100, currentJob?.percent ?? 0));
  const currentJobStage = currentJob?.stage ? currentJob.stage.replace(/_/g, ' ') : 'Esperando';

  async function runAction(name: string, action: () => Promise<void>) {
    setBusyAction(name);
    try {
      await action();
      await refreshStatus();
    } catch (error) {
      addLog(getErrorMessage(error), 'bad');
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <>
      <div className="window-chrome"><span aria-hidden="true" /></div>
      {settingsOpen ? (
        <>
          <button className="drawer-scrim" aria-label="Cerrar configuracion" onClick={() => setSettingsOpen(false)} />
          <aside className="settings-drawer" aria-label="Configuracion">
            <div className="drawer-header">
              <div>
                <span className="eyebrow">SofLIA Engine</span>
                <h2>Configuracion</h2>
                <p>Ajustes generales del sistema.</p>
              </div>
            </div>

            <div className="settings-stack">
              <label>
                Direccion de SofLIA
                <input value={apiUrl} onChange={(event) => setApiUrl(event.target.value)} autoComplete="url" />
              </label>

              <div className="setting-row">
                <span>
                  <strong>Apariencia</strong>
                  <small>Modo visual de la aplicacion.</small>
                </span>
                <div className="segmented-control" aria-label="Cambiar tema">
                  <button className={theme === 'light' ? 'is-active' : ''} onClick={() => setTheme('light')}>Claro</button>
                  <button className={theme === 'dark' ? 'is-active' : ''} onClick={() => setTheme('dark')}>Oscuro</button>
                </div>
              </div>

              <label className="switch-row">
                <span>
                  <strong>Segundo plano</strong>
                  <small>Al cerrar la ventana, la app seguira disponible.</small>
                </span>
                <input type="checkbox" checked={status.closeToTray} onChange={(event) => runAction('tray', async () => {
                  const result = await window.sofliaWorker.setCloseToTray(event.target.checked);
                  setStatus((current) => ({ ...current, closeToTray: result.closeToTray }));
                })} />
              </label>

              <button className="danger full" disabled={busyAction === 'quit'} onClick={() => runAction('quit', async () => {
                addLog('Cerrando la app.', 'warn');
                await window.sofliaWorker.quit();
              })}>
                Cerrar completamente
              </button>

              <section className="settings-section">
                <div className="drawer-section-heading">
                  <div>
                    <h3>Actualizaciones</h3>
                    <p>{getUpdateMessage(updateState)}</p>
                  </div>
                  <Badge {...updateBadge} />
                </div>
                <div className="version-row">
                  <div>
                    <span>Instalada</span>
                    <strong>v{updateState.currentVersion || APP_DISPLAY_VERSION}</strong>
                  </div>
                  {updateState.version ? (
                    <div>
                      <span>Nueva</span>
                      <strong>v{updateState.version}</strong>
                    </div>
                  ) : null}
                </div>
                {updateState.status === 'downloading' ? (
                  <div className="progress-track" aria-label="Progreso de descarga">
                    <span style={{ width: `${updateState.percent || 0}%` }} />
                  </div>
                ) : null}
                <div className="actions update-actions">
                  <button className="secondary" disabled={updateBusy || updateState.status === 'disabled'} onClick={() => runAction('check-update', async () => {
                    const result = await window.sofliaWorker.checkForUpdates();
                    setUpdateState(result);
                  })}>
                    Buscar
                  </button>
                  {updateState.status === 'available' ? (
                    <button className="primary" disabled={busyAction === 'download-update'} onClick={() => runAction('download-update', async () => {
                      const result = await window.sofliaWorker.downloadUpdate();
                      setUpdateState(result);
                    })}>
                      Descargar
                    </button>
                  ) : null}
                  {updateState.status === 'downloaded' ? (
                    <button className="primary" disabled={busyAction === 'install-update'} onClick={() => runAction('install-update', async () => {
                      await window.sofliaWorker.installUpdate();
                    })}>
                      Reiniciar
                    </button>
                  ) : null}
                </div>
              </section>
            </div>
          </aside>
        </>
      ) : null}

      <button
        className={`settings-tab ${settingsOpen ? 'is-open' : ''}`}
        aria-label={settingsOpen ? 'Cerrar configuracion' : 'Abrir configuracion'}
        onClick={() => setSettingsOpen((value) => !value)}
      >
        <span>{settingsOpen ? 'Cerrar' : 'Config'}</span>
      </button>

      <main className="app-shell">
        <header className="app-header">
          <div className="brand-lockup">
            <BrandMark />
            <div>
              <h1>SofLIA - Engine</h1>
              <p>Worker local de render - v{APP_DISPLAY_VERSION}</p>
            </div>
          </div>

          <div className="header-status">
            <Badge {...statusBadge} />
            <Badge {...runBadge} />
          </div>

        </header>

        <section className="status-hero">
          <div>
            <span className="eyebrow">Estado del equipo</span>
            <h2>{statusTitle}</h2>
            <p>{statusDetail}</p>
          </div>
          <div className="status-metrics">
            <div className="metric">
              <span>Render</span>
              <strong>{status.running ? 'Activo' : 'En pausa'}</strong>
            </div>
            <div className="metric">
              <span>Ultima conexion</span>
              <strong>{lastHeartbeat}</strong>
            </div>
          </div>
        </section>

        <section className="workspace-grid">
          <section className="panel connect-panel">
            <div className="section-heading">
              <span className="step">1</span>
              <div>
                <h2>Conectar este equipo</h2>
                <p>Usa el codigo temporal que aparece en SofLIA - Engine.</p>
              </div>
            </div>
            <label>
              Codigo de vinculacion
              <input
                className="code-input"
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
                placeholder="SLIA-482913"
                autoComplete="one-time-code"
              />
            </label>
            <button className="primary full" disabled={busyAction === 'link'} onClick={() => runAction('link', async () => {
              const result = await window.sofliaWorker.link({ apiUrl, code });
              addLog(`Equipo vinculado: ${result.deviceName || 'SofLIA Render Worker'}`, 'ok');
              setCode('');
            })}>
              Conectar equipo
            </button>
          </section>

          <section className="panel">
            <div className="section-heading">
              <span className="step">2</span>
              <div>
                <h2>Mantener disponible</h2>
                <p>Control manual del render local.</p>
              </div>
            </div>
            <div className="status-row">
              <div>
                <span className="eyebrow">Render local</span>
                <strong>{status.running ? 'Activo' : 'En pausa'}</strong>
              </div>
              <span className={`pulse-dot ${status.running ? 'is-on' : ''}`} />
            </div>
            <div className="actions">
              <button className="primary" disabled={busyAction === 'start'} onClick={() => runAction('start', async () => {
                await window.sofliaWorker.startWorker();
                addLog('Este equipo ya esta disponible.', 'ok');
              })}>
                Iniciar
              </button>
              <button className="secondary" disabled={busyAction === 'stop'} onClick={() => runAction('stop', async () => {
                await window.sofliaWorker.stopWorker();
                addLog('El render local quedo en pausa.', 'warn');
              })}>
                Detener
              </button>
            </div>
          </section>

          <section className="panel log-panel">
            <div className="section-heading compact">
              <div>
                <h2>Actividad reciente</h2>
                <p>Render actual y ultimos eventos del worker.</p>
              </div>
              <button className="ghost" onClick={() => setLogs([])}>Limpiar</button>
            </div>
            <div className="current-job-card">
              <div className="current-job-heading">
                <div>
                  <span className="eyebrow">Job actual</span>
                  <strong>{currentJob?.jobId ? formatJobId(currentJob.jobId) : 'Esperando videos en cola'}</strong>
                </div>
                <Badge text={currentJob ? `${currentJobPercent}%` : 'En espera'} kind={currentJob ? 'busy' : ''} />
              </div>
              <div className="job-meta-grid">
                <div>
                  <span>Composicion</span>
                  <strong>{currentJob?.compositionId || 'Sin job activo'}</strong>
                </div>
                <div>
                  <span>Etapa</span>
                  <strong>{currentJob ? currentJobStage : 'Esperando claim-next'}</strong>
                </div>
              </div>
              <div className="progress-track" aria-label="Progreso del job actual">
                <span style={{ width: `${currentJobPercent}%` }} />
              </div>
              <p className="muted">{currentJob?.message || 'Cuando SofLIA envie un video, veras aqui el avance del render local.'}</p>
            </div>
            <div className="log">
              {logs.length === 0 ? <p className="muted empty">Aun no hay actividad.</p> : null}
              {logs.map((line) => <div className={`log-line ${line.tone}`} key={line.id}>{line.message}</div>)}
            </div>
          </section>
        </section>
      </main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
