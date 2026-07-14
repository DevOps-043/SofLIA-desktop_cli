import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type WorkerEvent = {
  state: 'starting' | 'online' | 'idle' | 'claiming' | 'rendering' | 'completed' | 'error' | 'stopped';
  message: string;
  jobId?: string;
};

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
      quit: () => Promise<unknown>;
      openExternal: (url: string) => Promise<void>;
      onSettings: (callback: (payload: { closeToTray: boolean }) => void) => () => void;
      onWorkerEvent: (callback: (event: WorkerEvent) => void) => () => void;
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

function getFriendlyWorkerEvent(event: WorkerEvent): Pick<LogLine, 'message' | 'tone'> {
  if (event.state === 'starting') return { message: 'Preparando la conexion con SofLIA.', tone: 'info' };
  if (event.state === 'online') return { message: 'Tu equipo esta disponible para renderizar.', tone: 'ok' };
  if (event.state === 'idle') return { message: 'Sin videos pendientes por ahora.', tone: 'info' };
  if (event.state === 'claiming') return { message: 'SofLIA envio un video a este equipo.', tone: 'info' };
  if (event.state === 'rendering') return { message: 'Renderizando el video localmente.', tone: 'busy' };
  if (event.state === 'completed') return { message: 'Video terminado y enviado a SofLIA.', tone: 'ok' };
  if (event.state === 'error') return { message: 'No se pudo completar el render. Revisa la conexion e intenta de nuevo.', tone: 'bad' };
  return { message: 'Render local detenido.', tone: 'warn' };
}

function Badge({ text, kind = '' }: { text: string; kind?: 'ok' | 'busy' | 'bad' | 'warn' | '' }) {
  return <span className={`badge ${kind}`.trim()}>{text}</span>;
}

function BrandMark() {
  const [showLogo, setShowLogo] = useState(true);
  if (!showLogo) return <div className="mark" aria-hidden="true">S</div>;
  return (
    <div className="logo-frame">
      <img src="/soflia-logo.png" alt="SofLIA" onError={() => setShowLogo(false)} />
    </div>
  );
}

function App() {
  const [apiUrl, setApiUrl] = useState('http://localhost:3000');
  const [code, setCode] = useState('');
  const [theme, setTheme] = useState<'light' | 'dark'>(() => getInitialTheme());
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [status, setStatus] = useState<WorkerStatus>({
    configured: false,
    running: false,
    closeToTray: true,
  });
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [busyAction, setBusyAction] = useState<string | null>(null);

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
      if (event.state === 'stopped') {
        setStatus((current) => ({ ...current, running: false }));
      }
      if (event.state === 'claiming' || event.state === 'rendering' || event.state === 'starting') {
        setStatus((current) => ({ ...current, running: true }));
      }
    });
    const removeSettingsListener = window.sofliaWorker.onSettings((payload) => {
      setStatus((current) => ({ ...current, closeToTray: payload.closeToTray }));
    });
    refreshStatus().catch((error) => addLog(getErrorMessage(error), 'bad'));
    return () => {
      removeWorkerListener();
      removeSettingsListener();
    };
  }, [addLog, refreshStatus]);

  const workerMessage = useMemo(() => {
    if (!status.configured) return 'Pega el codigo de SofLIA para vincular este equipo.';
    if (status.worker?.last_heartbeat_at) {
      return `Ultima conexion: ${new Date(status.worker.last_heartbeat_at).toLocaleString()}`;
    }
    return 'Equipo vinculado. Inicia el render local para dejarlo disponible.';
  }, [status]);

  const statusBadge = status.configured
    ? { text: 'Vinculado', kind: 'ok' as const }
    : { text: 'Pendiente', kind: 'warn' as const };

  const runBadge = status.running
    ? { text: 'Disponible', kind: 'busy' as const }
    : { text: 'Pausado', kind: '' as const };

  const primaryStatusText = status.running
    ? 'Listo para recibir videos'
    : status.configured
      ? 'Equipo vinculado, render pausado'
      : 'Vincula este equipo';

  const primaryStatusDetail = status.running
    ? 'Puedes cerrar la ventana y mantener la app en segundo plano mientras SofLIA renderiza.'
    : status.configured
      ? 'Presiona iniciar para que SofLIA pueda usar esta computadora.'
      : 'Abre SofLIA - Engine, copia el codigo temporal y pegalo aqui.';

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
      <div className="window-chrome">
        <span aria-hidden="true" />
      </div>
      <main className="app-shell">
      <section className="hero-panel">
        <div className="brand-row">
          <div className="brand-lockup">
            <BrandMark />
            <div>
              <h1>SofLIA - Engine</h1>
              <p>Worker local de render</p>
            </div>
          </div>
          <button
            className="theme-toggle"
            aria-label="Cambiar tema"
            onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
          >
            {theme === 'dark' ? 'Claro' : 'Oscuro'}
          </button>
        </div>

        <div className="hero-content">
          <Badge {...statusBadge} />
          <h2>{primaryStatusText}</h2>
          <p>{primaryStatusDetail}</p>
        </div>

        <div className="status-card">
          <div>
            <span className="eyebrow">Estado</span>
            <strong>{runBadge.text}</strong>
          </div>
          <div className={`pulse-dot ${status.running ? 'is-on' : ''}`} />
        </div>
      </section>

      <section className="content-panel">
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

          <button
            className="primary full"
            disabled={busyAction === 'link'}
            onClick={() => runAction('link', async () => {
              const result = await window.sofliaWorker.link({ apiUrl, code });
              addLog(`Equipo vinculado: ${result.deviceName || 'SofLIA Render Worker'}`, 'ok');
              setCode('');
            })}
          >
            Conectar equipo
          </button>

          <button className="advanced-toggle" onClick={() => setShowAdvanced((value) => !value)}>
            {showAdvanced ? 'Ocultar configuracion avanzada' : 'Configuracion avanzada'}
          </button>

          {showAdvanced ? (
            <div className="advanced-panel">
              <label>
                Direccion de SofLIA
                <input value={apiUrl} onChange={(event) => setApiUrl(event.target.value)} autoComplete="url" />
              </label>
            </div>
          ) : null}
        </section>

        <section className="panel">
          <div className="section-heading">
            <span className="step">2</span>
            <div>
              <h2>Mantener disponible</h2>
              <p>{workerMessage}</p>
            </div>
          </div>

          <div className="row status-row">
            <div>
              <span className="eyebrow">Render local</span>
              <strong>{status.running ? 'Activo' : 'En pausa'}</strong>
            </div>
            <Badge {...runBadge} />
          </div>

          <div className="actions">
            <button
              className="primary"
              disabled={busyAction === 'start'}
              onClick={() => runAction('start', async () => {
                await window.sofliaWorker.startWorker();
                addLog('Este equipo ya esta disponible.', 'ok');
              })}
            >
              Iniciar
            </button>
            <button
              className="secondary"
              disabled={busyAction === 'stop'}
              onClick={() => runAction('stop', async () => {
                await window.sofliaWorker.stopWorker();
                addLog('El render local quedo en pausa.', 'warn');
              })}
            >
              Detener
            </button>
          </div>

          <label className="switch-row">
            <span>
              <strong>Segundo plano</strong>
              <small>Al cerrar la ventana, la app seguira disponible.</small>
            </span>
            <input
              type="checkbox"
              checked={status.closeToTray}
              onChange={(event) => runAction('tray', async () => {
                const result = await window.sofliaWorker.setCloseToTray(event.target.checked);
                setStatus((current) => ({ ...current, closeToTray: result.closeToTray }));
              })}
            />
          </label>

          <button
            className="danger subtle full"
            disabled={busyAction === 'quit'}
            onClick={() => runAction('quit', async () => {
              addLog('Cerrando la app.', 'warn');
              await window.sofliaWorker.quit();
            })}
          >
            Cerrar completamente
          </button>
        </section>

        <section className="panel log-panel">
          <div className="section-heading compact">
            <span className="step">3</span>
            <div>
              <h2>Actividad reciente</h2>
              <p>Mensajes simples sobre lo que esta ocurriendo.</p>
            </div>
            <button className="ghost" onClick={() => setLogs([])}>Limpiar</button>
          </div>

          <div className="log">
            {logs.length === 0 ? <p className="muted empty">Aun no hay actividad.</p> : null}
            {logs.map((line) => (
              <div className={`log-line ${line.tone}`} key={line.id}>{line.message}</div>
            ))}
          </div>
        </section>
      </section>
      </main>
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
