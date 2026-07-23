import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { APP_DISPLAY_VERSION, DEFAULT_API_URL } from '../shared/app-defaults';
import type { AppUpdateState } from '../shared/update-types';
import { getWorkerPowerProfile, WORKER_POWER_PROFILES } from '../shared/worker-capacity';
import type { WorkerPowerProfile } from '../shared/worker-capacity';
import type { WorkerRuntimeEvent } from '../shared/worker-events';
import './styles.css';

type LocalRetentionPolicy = 'delete_on_remote_confirm' | 'keep_all';

type WorkerStatus = {
  configured: boolean;
  apiUrl?: string;
  configPath?: string;
  running: boolean;
  closeToTray: boolean;
  powerProfile?: WorkerPowerProfile;
  maxConcurrentJobs?: number;
  renderConcurrency?: number;
  localRetentionPolicy?: LocalRetentionPolicy;
  localRecovery?: {
    pendingUploads: number;
    pendingCompletes: number;
    pendingCleanup: number;
    retainedBytes: number;
  };
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
  scope: 'worker' | 'bundle';
  detail?: Array<{ label: string; value: string }>;
};

type AppTab = 'worker' | 'bundle' | 'options';

declare global {
  interface Window {
    sofliaWorker: {
      getStatus: () => Promise<WorkerStatus>;
      link: (input: { apiUrl: string; code: string }) => Promise<LinkResult>;
      clearLink: () => Promise<{ cleared: boolean }>;
      startWorker: () => Promise<unknown>;
      stopWorker: () => Promise<unknown>;
      setApiUrl: (apiUrl: string) => Promise<{ apiUrl: string; restarted: boolean; message?: string }>;
      setPowerProfile: (powerProfile: WorkerPowerProfile) => Promise<{
        powerProfile: WorkerPowerProfile;
        maxConcurrentJobs: number;
        renderConcurrency: number;
        restarted: boolean;
        message?: string;
      }>;
      setLocalRetentionPolicy: (policy: LocalRetentionPolicy) => Promise<{
        localRetentionPolicy: LocalRetentionPolicy;
        message?: string;
      }>;
      setCloseToTray: (value: boolean) => Promise<{ closeToTray: boolean }>;
      setTheme: (theme: 'light' | 'dark') => Promise<{ theme: 'light' | 'dark' }>;
      getUpdateStatus: () => Promise<AppUpdateState>;
      checkForUpdates: () => Promise<AppUpdateState>;
      downloadUpdate: () => Promise<AppUpdateState>;
      installUpdate: () => Promise<AppUpdateState>;
      quit: () => Promise<unknown>;
      openExternal: (url: string) => Promise<void>;
      onUpdateStatus: (callback: (payload: AppUpdateState) => void) => () => void;
      onSettings: (callback: (payload: {
        closeToTray?: boolean;
        powerProfile?: WorkerPowerProfile;
        maxConcurrentJobs?: number;
        renderConcurrency?: number;
        localRetentionPolicy?: LocalRetentionPolicy;
      }) => void) => () => void;
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

function formatDetailValue(value: unknown): string {
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : 'Ninguno';
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value ?? '');
}

function getDetailEntries(detail?: Record<string, unknown>): Array<{ label: string; value: string }> | undefined {
  if (!detail) return undefined;
  const labels: Record<string, string> = {
    artifact: 'Artefacto',
    buildHash: 'Build SHA-256',
    buildId: 'Build ID',
    bundleHash: 'Bundle SHA-256',
    bundleRoot: 'Carpeta fuente',
    defaultProps: 'Props default',
    entryPoint: 'Entry point',
    exportMode: 'Modo export',
    manifest: 'Manifest',
    outputDirectory: 'Carpeta de salida',
    outputStoragePath: 'Destino storage',
    maxConcurrentJobs: 'Capacidad',
    propsHash: 'Props SHA-256',
    powerProfile: 'Perfil',
    renderConcurrency: 'Concurrencia render',
    serveUrl: 'Serve URL',
    sizeBytes: 'Tamano ZIP',
    source: 'Fuente',
    templateVersionId: 'Version ID',
  };
  return Object.entries(detail)
    .filter(([, value]) => value !== undefined && value !== null && formatDetailValue(value) !== '')
    .map(([key, value]) => ({
      label: labels[key] || key,
      value: key === 'sizeBytes' && typeof value === 'number'
        ? `${(value / 1024).toFixed(1)} KB`
        : formatDetailValue(value),
    }));
}

function getEventScope(event: WorkerRuntimeEvent): LogLine['scope'] {
  return event.jobType === 'template_build' || event.stage?.startsWith('template_') ? 'bundle' : 'worker';
}

function getFriendlyWorkerEvent(event: WorkerRuntimeEvent): Pick<LogLine, 'message' | 'tone' | 'scope' | 'detail'> {
  const scope = getEventScope(event);
  const detail = getDetailEntries(event.detail);
  if (event.state === 'starting') return { message: 'Preparando la conexion con SofLIA.', tone: 'info', scope, detail };
  if (event.state === 'online') return { message: 'Tu equipo esta disponible para renderizar.', tone: 'ok', scope, detail };
  if (event.state === 'idle') return { message: 'Sin jobs pendientes por ahora.', tone: 'info', scope, detail };
  if (event.state === 'claiming') {
    return {
      message: scope === 'bundle'
        ? `SofLIA envio el build ${formatJobId(event.buildId || event.jobId)} a este equipo.`
        : `SofLIA envio el job ${formatJobId(event.jobId)} a este equipo.`,
      tone: 'info',
      scope,
      detail,
    };
  }
  if (event.state === 'rendering') {
    return { message: `${event.message} (${event.percent ?? 0}%).`, tone: 'busy', scope, detail };
  }
  if (event.state === 'recovering') return { message: event.message || 'Recuperando job local pendiente.', tone: 'busy', scope, detail };
  if (event.state === 'upload_pending') return { message: event.message || 'Artefacto local pendiente de subir.', tone: 'warn', scope, detail };
  if (event.state === 'confirm_pending') return { message: event.message || 'Artefacto pendiente de confirmar en SofLIA.', tone: 'warn', scope, detail };
  if (event.state === 'cleanup_completed') return { message: event.message || 'Artefacto local eliminado.', tone: 'ok', scope, detail };
  if (event.state === 'cleanup_skipped') return { message: event.message || 'Artefacto local conservado.', tone: 'info', scope, detail };
  if (event.state === 'completed') {
    return {
      message: scope === 'bundle'
        ? `Build ${formatJobId(event.buildId || event.jobId)} compilado y enviado a SofLIA.`
        : `Job ${formatJobId(event.jobId)} terminado y enviado a SofLIA.`,
      tone: 'ok',
      scope,
      detail,
    };
  }
  if (event.state === 'error') return { message: event.message || 'No se pudo completar el job.', tone: 'bad', scope, detail };
  return { message: 'Render local detenido.', tone: 'warn', scope, detail };
}

function formatBytes(value = 0): string {
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function mergeWorkerEvent(current: WorkerRuntimeEvent | null, event: WorkerRuntimeEvent): WorkerRuntimeEvent {
  if (!current || !current.jobId || current.jobId !== event.jobId) return event;
  return {
    ...current,
    ...event,
    detail: {
      ...(current.detail || {}),
      ...(event.detail || {}),
    },
  };
}

function formatJobId(jobId?: string): string {
  if (!jobId) return 'actual';
  if (jobId.length <= 12) return jobId;
  return `${jobId.slice(0, 8)}...${jobId.slice(-4)}`;
}

function Badge({ text, kind = '' }: { text: string; kind?: 'ok' | 'busy' | 'bad' | 'warn' | '' }) {
  return <span className={`badge ${kind}`.trim()}>{text}</span>;
}

function isActionResult(value: unknown): value is { started?: boolean; message?: string } {
  return Boolean(value && typeof value === 'object');
}

function DetailGrid({ detail, compact = false }: { detail?: LogLine['detail']; compact?: boolean }) {
  if (!detail?.length) return null;
  return (
    <div className={compact ? 'detail-grid compact' : 'detail-grid'}>
      {detail.map((item) => (
        <div key={`${item.label}-${item.value}`}>
          <span>{item.label}</span>
          <strong title={item.value}>{item.value}</strong>
        </div>
      ))}
    </div>
  );
}

function LogList({ logs }: { logs: LogLine[] }) {
  return (
    <div className="log">
      {logs.length === 0 ? <p className="muted empty">Aun no hay actividad.</p> : null}
      {logs.map((line) => (
        <div className={`log-line ${line.tone}`} key={line.id}>
          <div className="log-line-heading">
            <span>{line.message}</span>
            <small>{line.scope === 'bundle' ? 'Bundle' : 'Worker'}</small>
          </div>
          <DetailGrid detail={line.detail} compact />
        </div>
      ))}
    </div>
  );
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
  if (updateState.status === 'downloaded') return 'Actualizacion lista. Instala y reinicia para terminar.';
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
  const [status, setStatus] = useState<WorkerStatus>({ configured: false, running: false, closeToTray: true });
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState<AppUpdateState>({ status: 'idle', currentVersion: APP_DISPLAY_VERSION });
  const [currentJob, setCurrentJob] = useState<WorkerRuntimeEvent | null>(null);
  const [activeTab, setActiveTab] = useState<AppTab>('worker');

  const addLog = useCallback((
    message: string,
    tone: LogLine['tone'] = 'info',
    scope: LogLine['scope'] = 'worker',
    detail?: LogLine['detail'],
  ) => {
    setLogs((current) => [
      { id: `${Date.now()}-${Math.random()}`, message: `${formatTime()} - ${message}`, tone, scope, detail },
      ...current,
    ].slice(0, 18));
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
      addLog(friendlyEvent.message, friendlyEvent.tone, friendlyEvent.scope, friendlyEvent.detail);
      if (event.state === 'stopped') setStatus((current) => ({ ...current, running: false }));
      if (event.state === 'claiming' || event.state === 'rendering' || event.state === 'starting') {
        setStatus((current) => ({ ...current, running: true }));
      }
      if (event.state === 'claiming' || event.state === 'rendering') {
        setCurrentJob((current) => mergeWorkerEvent(current, event));
        if (getEventScope(event) === 'bundle') setActiveTab('bundle');
      }
      if (event.state === 'completed' || event.state === 'error') {
        setCurrentJob((current) => mergeWorkerEvent(current, event));
      }
      if (event.state === 'idle' || event.state === 'stopped') {
        setCurrentJob(null);
      }
    });
    const removeSettingsListener = window.sofliaWorker.onSettings((payload) => {
      setStatus((current) => ({
        ...current,
        closeToTray: payload.closeToTray ?? current.closeToTray,
        powerProfile: payload.powerProfile ?? current.powerProfile,
        maxConcurrentJobs: payload.maxConcurrentJobs ?? current.maxConcurrentJobs,
        renderConcurrency: payload.renderConcurrency ?? current.renderConcurrency,
        localRetentionPolicy: payload.localRetentionPolicy ?? current.localRetentionPolicy,
      }));
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
  const currentJobScope = currentJob ? getEventScope(currentJob) : 'worker';
  const currentJobDetails = getDetailEntries(currentJob?.detail);
  const bundleLogs = logs.filter((line) => line.scope === 'bundle');
  const workerLogs = logs.filter((line) => line.scope === 'worker');
  const selectedPowerProfile = getWorkerPowerProfile(status.powerProfile);

  async function runAction(name: string, action: () => Promise<void>, options: { refresh?: boolean; errorTarget?: 'options' } = {}) {
    setBusyAction(name);
    if (options.errorTarget === 'options') setOptionsError(null);
    try {
      await action();
      if (options.refresh !== false) {
        await refreshStatus();
      }
    } catch (error) {
      const message = getErrorMessage(error);
      if (options.errorTarget === 'options') setOptionsError(message);
      addLog(message, 'bad');
    } finally {
      setBusyAction(null);
    }
  }

  async function savePowerProfile(profile: WorkerPowerProfile) {
    await runAction(`power-${profile}`, async () => {
      if (typeof window.sofliaWorker.setPowerProfile !== 'function') {
        throw new Error('Reinicia SofLIA Engine para cargar el nuevo modulo de configuracion del worker.');
      }
      const result = await window.sofliaWorker.setPowerProfile(profile);
      setStatus((current) => ({
        ...current,
        powerProfile: result.powerProfile,
        maxConcurrentJobs: result.maxConcurrentJobs,
        renderConcurrency: result.renderConcurrency,
      }));
      addLog(result.message || `Perfil ${getWorkerPowerProfile(profile).label} guardado.`, result.restarted ? 'ok' : 'info');
    }, { refresh: false, errorTarget: 'options' });
  }

  async function saveLocalRetentionPolicy(policy: LocalRetentionPolicy) {
    await runAction(`retention-${policy}`, async () => {
      const result = await window.sofliaWorker.setLocalRetentionPolicy(policy);
      setStatus((current) => ({ ...current, localRetentionPolicy: result.localRetentionPolicy }));
      addLog(result.message || 'Politica de retencion local guardada.', 'ok');
    });
  }

  return (
    <>
      <div className="window-chrome"><span aria-hidden="true" /></div>
      <main className="app-shell">
        <aside className="side-panel" aria-label="Navegacion del worker">
          <div className="side-brand">
            <BrandMark />
            <div>
              <strong>SofLIA Engine</strong>
              <small>v{APP_DISPLAY_VERSION}</small>
            </div>
          </div>
          <nav className="side-nav">
            <button className={activeTab === 'worker' ? 'is-active' : ''} onClick={() => setActiveTab('worker')}>
              <span>Worker</span>
              <small>{status.running ? 'Activo' : 'Pausado'}</small>
            </button>
            <button className={activeTab === 'bundle' ? 'is-active' : ''} onClick={() => setActiveTab('bundle')}>
              <span>Bundles</span>
              <small>{bundleLogs.length > 0 ? `${bundleLogs.length} eventos` : 'En espera'}</small>
            </button>
            <button className={activeTab === 'options' ? 'is-active' : ''} onClick={() => setActiveTab('options')}>
              <span>Opciones</span>
              <small>{selectedPowerProfile.label}</small>
            </button>
          </nav>
        </aside>

        <section className="content-shell">
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

        {activeTab === 'worker' ? (
          <>
            <section className="status-hero">
              <div>
                <span className="eyebrow">Estado del equipo</span>
                <h2>{statusTitle}</h2>
                <p>{statusDetail}</p>
                {status.message ? <p className="status-error">{status.message}</p> : null}
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
                    const result = await window.sofliaWorker.startWorker();
                    if (isActionResult(result) && result.message) {
                      addLog(result.message, result.started === false ? 'bad' : 'info');
                      return;
                    }
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
                    <p>Render actual, builds de plantilla y ultimos eventos.</p>
                  </div>
                  <button className="ghost" onClick={() => setLogs([])}>Limpiar</button>
                </div>
                <div className="current-job-card">
                  <div className="current-job-heading">
                    <div>
                      <span className="eyebrow">Job actual</span>
                      <strong>{currentJob?.jobId ? formatJobId(currentJob.jobId) : 'Esperando jobs en cola'}</strong>
                    </div>
                    <Badge text={currentJob ? `${currentJobPercent}%` : 'En espera'} kind={currentJob ? 'busy' : ''} />
                  </div>
                  <div className="job-meta-grid">
                    <div>
                      <span>Tipo</span>
                      <strong>{currentJobScope === 'bundle' ? 'Bundle' : 'Render'}</strong>
                    </div>
                    <div>
                      <span>Etapa</span>
                      <strong>{currentJob ? currentJobStage : 'Esperando claim-next'}</strong>
                    </div>
                    <div>
                      <span>Composicion</span>
                      <strong>{currentJob?.compositionId || 'Sin job activo'}</strong>
                    </div>
                    <div>
                      <span>Build</span>
                      <strong>{currentJob?.buildId ? formatJobId(currentJob.buildId) : 'No aplica'}</strong>
                    </div>
                  </div>
                  <div className="progress-track" aria-label="Progreso del job actual">
                    <span style={{ width: `${currentJobPercent}%` }} />
                  </div>
                  <p className="muted">{currentJob?.message || 'Cuando SofLIA envie un render o build de plantilla, veras aqui el avance del worker local.'}</p>
                  <DetailGrid detail={currentJobDetails} />
                </div>
                <LogList logs={workerLogs} />
              </section>
            </section>
          </>
        ) : activeTab === 'bundle' ? (
          <section className="bundle-layout">
            <section className="panel bundle-status-panel">
              <div className="section-heading compact">
                <div>
                  <h2>Build de Bundle</h2>
                  <p>Compilacion local de plantillas Remotion y artefactos generados.</p>
                </div>
                <Badge
                  text={currentJobScope === 'bundle' ? `${currentJobPercent}%` : 'En espera'}
                  kind={currentJobScope === 'bundle' ? 'busy' : ''}
                />
              </div>
              <div className="current-job-card">
                <div className="current-job-heading">
                  <div>
                    <span className="eyebrow">Build actual</span>
                    <strong>{currentJobScope === 'bundle' && currentJob?.buildId ? formatJobId(currentJob.buildId) : 'Sin bundle activo'}</strong>
                  </div>
                  <Badge text={currentJobScope === 'bundle' ? currentJobStage : 'Esperando'} kind={currentJobScope === 'bundle' ? 'busy' : ''} />
                </div>
                <div className="progress-track" aria-label="Progreso del bundle actual">
                  <span style={{ width: `${currentJobScope === 'bundle' ? currentJobPercent : 0}%` }} />
                </div>
                <p className="muted">
                  {currentJobScope === 'bundle' && currentJob?.message
                    ? currentJob.message
                    : 'Cuando un build sea reclamado, veras descarga, entrypoint, carpeta de salida, ZIP generado y destino de subida.'}
                </p>
                <DetailGrid detail={currentJobScope === 'bundle' ? currentJobDetails : undefined} />
              </div>
            </section>

            <section className="panel">
              <div className="section-heading compact">
                <div>
                  <h2>Registros del Bundle</h2>
                  <p>Eventos con archivos, rutas y hashes reportados por el worker.</p>
                </div>
                <button className="ghost" onClick={() => setLogs((current) => current.filter((line) => line.scope !== 'bundle'))}>Limpiar</button>
              </div>
              <LogList logs={bundleLogs} />
            </section>
          </section>
        ) : (
          <section className="options-layout">
            <section className="panel power-panel">
              <div className="section-heading compact">
                <div>
                  <span className="eyebrow">Configuracion balanceada para la PC</span>
                  <h2>Potencia del worker</h2>
                  <p>El perfil define la capacidad reportada a SofLIA y la concurrencia interna usada por Remotion en renders finales.</p>
                </div>
                <Badge text={selectedPowerProfile.label} kind="busy" />
              </div>
              {optionsError ? <p className="inline-error">{optionsError}</p> : null}
              <div className="power-profile-grid">
                {WORKER_POWER_PROFILES.map((profile) => (
                  <article
                    key={profile.id}
                    className={`power-profile-card ${selectedPowerProfile.id === profile.id ? 'is-active' : ''}`}
                  >
                    <span className="power-card-heading">
                      <strong>{profile.label}</strong>
                      {profile.id === 'balanced' ? <em>Recomendado</em> : null}
                    </span>
                    <span className="power-card-summary">{profile.headline}</span>
                    <span className="power-card-metrics">
                      <span>{profile.maxConcurrentJobs} jobs</span>
                      <span>{profile.renderConcurrency} hilos render</span>
                    </span>
                    <small>{profile.bestFor}</small>
                    <ul>
                      {profile.characteristics.map((item) => <li key={item}>{item}</li>)}
                    </ul>
                    <button
                      className={selectedPowerProfile.id === profile.id ? 'secondary full' : 'primary full'}
                      disabled={busyAction === `power-${profile.id}` || selectedPowerProfile.id === profile.id}
                      onClick={() => savePowerProfile(profile.id)}
                    >
                      {selectedPowerProfile.id === profile.id ? 'Seleccionado' : 'Usar perfil'}
                    </button>
                  </article>
                ))}
              </div>
            </section>

            <section className="options-grid">
              <section className="panel">
                <div className="section-heading">
                  <span className="step">1</span>
                  <div>
                    <h2>Conexion</h2>
                    <p>URL del backend SofLIA usada por este worker.</p>
                  </div>
                </div>
                <label>
                  Direccion de SofLIA
                  <input value={apiUrl} onChange={(event) => setApiUrl(event.target.value)} autoComplete="url" />
                </label>
                <button className="secondary full" disabled={busyAction === 'api-url'} onClick={() => runAction('api-url', async () => {
                  const result = await window.sofliaWorker.setApiUrl(apiUrl);
                  setApiUrl(result.apiUrl);
                  addLog(result.message || 'Direccion de SofLIA guardada.', result.restarted ? 'ok' : 'info');
                })}>
                  Guardar direccion
                </button>
              </section>

              <section className="panel">
                <div className="section-heading">
                  <span className="step">2</span>
                  <div>
                    <h2>Preferencias</h2>
                    <p>Apariencia y comportamiento de ventana.</p>
                  </div>
                </div>
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
                <div className="setting-row">
                  <span>
                    <strong>Retencion local</strong>
                    <small>Artefactos finales despues de confirmar en SofLIA.</small>
                  </span>
                  <div className="segmented-control" aria-label="Politica de retencion local">
                    <button
                      className={(status.localRetentionPolicy || 'delete_on_remote_confirm') === 'delete_on_remote_confirm' ? 'is-active' : ''}
                      disabled={busyAction === 'retention-delete_on_remote_confirm'}
                      onClick={() => saveLocalRetentionPolicy('delete_on_remote_confirm')}
                    >
                      Borrar
                    </button>
                    <button
                      className={status.localRetentionPolicy === 'keep_all' ? 'is-active' : ''}
                      disabled={busyAction === 'retention-keep_all'}
                      onClick={() => saveLocalRetentionPolicy('keep_all')}
                    >
                      Guardar
                    </button>
                  </div>
                </div>
              </section>
            </section>

            <section className="options-grid">
              <section className="panel settings-section">
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
                      Instalar y reiniciar
                    </button>
                  ) : null}
                </div>
              </section>

              <section className="panel">
                <div className="section-heading">
                  <span className="step">3</span>
                  <div>
                    <h2>Mantenimiento</h2>
                    <p>Acciones locales para cerrar o desvincular este equipo.</p>
                  </div>
                </div>
                <div className="job-meta-grid">
                  <div>
                    <span>Subidas pendientes</span>
                    <strong>{status.localRecovery?.pendingUploads ?? 0}</strong>
                  </div>
                  <div>
                    <span>Confirmaciones</span>
                    <strong>{status.localRecovery?.pendingCompletes ?? 0}</strong>
                  </div>
                  <div>
                    <span>Limpieza</span>
                    <strong>{status.localRecovery?.pendingCleanup ?? 0}</strong>
                  </div>
                  <div>
                    <span>Retenido</span>
                    <strong>{formatBytes(status.localRecovery?.retainedBytes || 0)}</strong>
                  </div>
                </div>
                <div className="maintenance-actions">
                  <button className="secondary full" disabled={busyAction === 'clear-link'} onClick={() => runAction('clear-link', async () => {
                    await window.sofliaWorker.clearLink();
                    setStatus((current) => ({ ...current, configured: false, running: false, worker: undefined, message: 'Vinculacion local limpiada.' }));
                    addLog('Vinculacion local limpiada. Usa un codigo nuevo para conectar este equipo.', 'warn');
                  })}>
                    Limpiar vinculacion
                  </button>
                  <button className="danger full" disabled={busyAction === 'quit'} onClick={() => runAction('quit', async () => {
                    addLog('Cerrando la app.', 'warn');
                    await window.sofliaWorker.quit();
                  })}>
                    Cerrar completamente
                  </button>
                </div>
              </section>
            </section>
          </section>
        )}
        </section>
      </main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
