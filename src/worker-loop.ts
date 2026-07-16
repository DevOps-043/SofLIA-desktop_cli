import { SofliaWorkerApiClient } from './api-client.js';
import type { ClaimedJob } from './api-client.js';
import { loadConfig } from './config.js';
import { log, logError, sanitizeLog } from './logging.js';
import { renderClaimedJob } from './render.js';
import type { WorkerRuntimeEvent } from './shared/worker-events.js';

export interface WorkerLoopEvents {
  onStatus?: (event: WorkerRuntimeEvent) => void;
}

type WorkerLoopClient = Pick<SofliaWorkerApiClient, 'heartbeat' | 'claimNext' | 'fail'>;

type WorkerLoopDependencies = {
  loadConfig: typeof loadConfig;
  createClient: (apiUrl: string, token: string) => WorkerLoopClient;
  renderJob: (
    client: WorkerLoopClient,
    job: ClaimedJob,
    options: Parameters<typeof renderClaimedJob>[2],
  ) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startWorkerLoop(
  options: { pollIntervalMs?: number; signal?: AbortSignal; dependencies?: Partial<WorkerLoopDependencies> } & WorkerLoopEvents = {},
): Promise<void> {
  const dependencies: WorkerLoopDependencies = {
    loadConfig,
    createClient: (apiUrl, token) => new SofliaWorkerApiClient(apiUrl, token),
    renderJob: (client, job, renderOptions) => renderClaimedJob(client as SofliaWorkerApiClient, job, renderOptions),
    sleep,
    ...options.dependencies,
  };
  const config = await dependencies.loadConfig();
  const client = dependencies.createClient(config.apiUrl, config.token);
  const pollIntervalMs = Math.max(1000, options.pollIntervalMs || 5000);
  let shouldStop = false;
  const emit = options.onStatus || (() => {});

  process.once('SIGINT', () => {
    shouldStop = true;
    log('Deteniendo worker despues del ciclo actual...');
  });
  process.once('SIGTERM', () => {
    shouldStop = true;
  });
  options.signal?.addEventListener('abort', () => {
    shouldStop = true;
  }, { once: true });

  log('Worker local iniciado', {
    apiUrl: config.apiUrl,
    pollIntervalMs,
  });
  emit({ state: 'starting', message: 'Worker local iniciado', detail: { apiUrl: config.apiUrl, pollIntervalMs } });

  while (!shouldStop) {
    let claimedJobId: string | null = null;
    try {
      await client.heartbeat('ONLINE');
      emit({ state: 'online', message: 'Conectado a SofLIA - Engine' });
      const job = await client.claimNext();
      if (!job) {
        emit({ state: 'idle', message: 'Sin jobs pendientes' });
        await dependencies.sleep(pollIntervalMs);
        continue;
      }

      claimedJobId = job.jobId;
      emit({
        state: 'claiming',
        message: 'Job reclamado',
        jobId: job.jobId,
        compositionId: job.compositionId,
        percent: 0,
        stage: 'claim',
      });
      log('Job reclamado automaticamente', {
        jobId: job.jobId,
        compositionId: job.compositionId,
        bundleHash: job.bundleHash,
        propsHash: job.propsHash,
      });
      emit({
        state: 'rendering',
        message: 'Renderizando video',
        jobId: job.jobId,
        compositionId: job.compositionId,
        percent: 0,
        stage: 'render_start',
      });
      await dependencies.renderJob(client, job, {
        onProgress: (progress) => {
          emit({
            state: 'rendering',
            ...progress,
          });
        },
      });
      log('Render completado', { jobId: job.jobId });
      emit({
        state: 'completed',
        message: 'Render completado',
        jobId: job.jobId,
        compositionId: job.compositionId,
        percent: 100,
        stage: 'complete',
      });
    } catch (error) {
      const message = sanitizeLog(error instanceof Error ? error.message : String(error));
      logError('Error en worker start:', error);
      emit({ state: 'error', message, jobId: claimedJobId || undefined });
      if (claimedJobId) {
        try {
          await client.fail(claimedJobId, {
            errorCode: 'DESKTOP_WORKER_RENDER_FAILED',
            message,
            stage: 'cli_start',
          });
        } catch (failError) {
          logError('No se pudo reportar el fallo al API:', failError);
        }
      }
      await dependencies.sleep(pollIntervalMs);
    }
  }

  try {
    await client.heartbeat('OFFLINE');
  } catch {
    // Best-effort shutdown heartbeat only.
  }
  log('Worker local detenido');
  emit({ state: 'stopped', message: 'Worker local detenido' });
}
