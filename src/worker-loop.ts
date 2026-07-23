import { SofliaWorkerApiClient } from './api-client.js';
import type { ClaimedJob, ClaimedRenderJob, ClaimedTemplateBuildJob } from './api-client.js';
import { loadConfig } from './config.js';
import { localJobTypeToRemoteTable } from './local-job-state.js';
import { LocalJobStore } from './local-job-store.js';
import { log, logError, sanitizeLog } from './logging.js';
import { RecoveryCoordinator } from './recovery-coordinator.js';
import { isRecoverableJobError } from './recoverable-job-error.js';
import { renderClaimedJob } from './render.js';
import { buildTemplateJob } from './template-build.js';
import { renderTemplatePreviewJob } from './template-preview.js';
import type { WorkerRuntimeEvent } from './shared/worker-events.js';

export interface WorkerLoopEvents {
  onStatus?: (event: WorkerRuntimeEvent) => void;
}

type WorkerLoopClient = Pick<SofliaWorkerApiClient, 'heartbeat' | 'claimNext' | 'fail'> & {
  claimNextBatch?: () => Promise<ClaimedJob[]>;
  complete?: SofliaWorkerApiClient['complete'];
  refreshUploadUrl?: SofliaWorkerApiClient['refreshUploadUrl'];
};

type WorkerLoopDependencies = {
  loadConfig: typeof loadConfig;
  createClient: (apiUrl: string, token: string) => WorkerLoopClient;
  renderJob: (
    client: WorkerLoopClient,
    job: ClaimedRenderJob,
    options: Parameters<typeof renderClaimedJob>[2],
  ) => Promise<void>;
  buildTemplate: (
    client: WorkerLoopClient,
    job: ClaimedTemplateBuildJob,
    options: Parameters<typeof buildTemplateJob>[2],
  ) => Promise<void>;
  renderTemplatePreview: (
    client: WorkerLoopClient,
    job: Extract<ClaimedJob, { jobType: 'template_preview' }>,
    options: Parameters<typeof renderTemplatePreviewJob>[2],
  ) => Promise<void>;
  createLocalJobStore: () => Promise<LocalJobStore | null>;
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
    buildTemplate: (client, job, buildOptions) => buildTemplateJob(client as SofliaWorkerApiClient, job, buildOptions),
    renderTemplatePreview: (client, job, previewOptions) => renderTemplatePreviewJob(client as SofliaWorkerApiClient, job, previewOptions),
    createLocalJobStore: async () => {
      const store = new LocalJobStore();
      await store.initialize();
      return store;
    },
    sleep,
    ...options.dependencies,
  };
  const config = await dependencies.loadConfig();
  const client = dependencies.createClient(config.apiUrl, config.token);
  const localJobStore = await dependencies.createLocalJobStore();
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
    powerProfile: config.powerProfile,
    maxConcurrentJobs: config.maxConcurrentJobs,
    renderConcurrency: config.renderConcurrency,
  });
  emit({
    state: 'starting',
    message: 'Worker local iniciado',
    detail: {
      apiUrl: config.apiUrl,
      pollIntervalMs,
      powerProfile: config.powerProfile,
      maxConcurrentJobs: config.maxConcurrentJobs,
      renderConcurrency: config.renderConcurrency,
    },
  });

  async function processClaimedJob(job: ClaimedJob): Promise<void> {
    const claimedJobType = job.jobType;
    try {
      emit({
        state: 'claiming',
        message: 'Job reclamado',
        jobType: job.jobType === 'template_build' ? 'template_build' : job.jobType === 'template_preview' ? 'template_preview' : 'render',
        jobId: job.jobId,
        buildId: job.jobType === 'template_build' || job.jobType === 'template_preview' ? job.buildId : undefined,
        templateVersionId: job.jobType === 'template_build' || job.jobType === 'template_preview' ? job.templateVersionId : undefined,
        compositionId: job.compositionId,
        percent: 0,
        stage: 'claim',
        detail: job.jobType === 'template_build'
          ? {
              buildId: job.buildId,
              templateVersionId: job.templateVersionId,
              bundleHash: job.bundleHash,
              exportMode: job.exportMode,
              outputStoragePath: job.outputStoragePath,
            }
          : job.jobType === 'template_preview'
            ? {
                previewId: job.previewId,
                buildId: job.buildId,
                templateVersionId: job.templateVersionId,
                propsHash: job.propsHash,
                posterStoragePath: job.posterStoragePath,
              }
          : {
              bundleHash: job.bundleHash,
              propsHash: job.propsHash,
              outputStoragePath: job.outputStoragePath,
            },
      });
      log('Job reclamado automaticamente', {
        jobId: job.jobId,
        compositionId: job.compositionId,
        bundleHash: job.bundleHash,
        propsHash: job.jobType === 'template_build' ? undefined : job.propsHash,
      });
      emit({
        state: 'rendering',
        message: job.jobType === 'template_build' ? 'Compilando plantilla' : job.jobType === 'template_preview' ? 'Generando preview de plantilla' : 'Renderizando video',
        jobType: job.jobType === 'template_build' ? 'template_build' : job.jobType === 'template_preview' ? 'template_preview' : 'render',
        jobId: job.jobId,
        buildId: job.jobType === 'template_build' || job.jobType === 'template_preview' ? job.buildId : undefined,
        templateVersionId: job.jobType === 'template_build' || job.jobType === 'template_preview' ? job.templateVersionId : undefined,
        compositionId: job.compositionId,
        percent: 0,
        stage: job.jobType === 'template_build' ? 'template_build_start' : job.jobType === 'template_preview' ? 'template_preview_start' : 'render_start',
      });

      const isTemplateBuild = job.jobType === 'template_build';
      const isTemplatePreview = job.jobType === 'template_preview';
      if (isTemplateBuild) {
        await dependencies.buildTemplate(client, job, {
          localJobStore: localJobStore || undefined,
          localRetentionPolicy: config.localRetentionPolicy,
          onProgress: (progress) => {
            emit({
              state: 'rendering',
              ...progress,
            });
          },
        });
      } else if (isTemplatePreview) {
        await dependencies.renderTemplatePreview(client, job, {
          localJobStore: localJobStore || undefined,
          localRetentionPolicy: config.localRetentionPolicy,
          onProgress: (progress) => {
            emit({
              state: 'rendering',
              ...progress,
            });
          },
        });
      } else {
        await dependencies.renderJob(client, job, {
          renderConcurrency: config.renderConcurrency,
          localJobStore: localJobStore || undefined,
          localRetentionPolicy: config.localRetentionPolicy,
          onProgress: (progress) => {
            emit({
              state: 'rendering',
              ...progress,
            });
          },
        });
      }

      log(isTemplateBuild ? 'Build de plantilla completado' : isTemplatePreview ? 'Preview de plantilla completado' : 'Render completado', { jobId: job.jobId });
      emit({
        state: 'completed',
        message: isTemplateBuild ? 'Build de plantilla completado' : isTemplatePreview ? 'Preview de plantilla completado' : 'Render completado',
        jobType: isTemplateBuild ? 'template_build' : isTemplatePreview ? 'template_preview' : 'render',
        jobId: job.jobId,
        buildId: isTemplateBuild || isTemplatePreview ? job.buildId : undefined,
        templateVersionId: isTemplateBuild || isTemplatePreview ? job.templateVersionId : undefined,
        compositionId: job.compositionId,
        percent: 100,
        stage: 'complete',
      });
    } catch (error) {
      const message = sanitizeLog(error instanceof Error ? error.message : String(error));
      logError('Error procesando job:', error);
      if (isRecoverableJobError(error)) {
        emit({
          state: error.stage === 'upload' ? 'upload_pending' : 'confirm_pending',
          message: error.message,
          jobId: job.jobId,
          jobType: claimedJobType === 'template_build' ? 'template_build' : claimedJobType === 'template_preview' ? 'template_preview' : 'render',
          stage: error.stage,
        });
        return;
      }
      emit({ state: 'error', message, jobId: job.jobId });
      try {
        localJobStore?.markNonRecoverableFailure(
          job.jobId,
          claimedJobType === 'template_build'
            ? 'DESKTOP_WORKER_TEMPLATE_BUILD_FAILED'
            : claimedJobType === 'template_preview'
              ? 'DESKTOP_WORKER_TEMPLATE_PREVIEW_FAILED'
              : 'DESKTOP_WORKER_RENDER_FAILED',
          message,
        );
        await client.fail(job.jobId, {
          errorCode: claimedJobType === 'template_build'
            ? 'DESKTOP_WORKER_TEMPLATE_BUILD_FAILED'
            : claimedJobType === 'template_preview'
              ? 'DESKTOP_WORKER_TEMPLATE_PREVIEW_FAILED'
              : 'DESKTOP_WORKER_RENDER_FAILED',
          message,
          stage: claimedJobType === 'template_build' ? 'template_build' : claimedJobType === 'template_preview' ? 'template_preview' : 'cli_start',
        });
      } catch (failError) {
        logError('No se pudo reportar el fallo al API:', failError);
      }
    }
  }

  while (!shouldStop) {
    try {
      if (localJobStore && client.refreshUploadUrl && client.complete) {
        const recovery = new RecoveryCoordinator(localJobStore, {
          refreshUploadUrl: client.refreshUploadUrl.bind(client),
          complete: client.complete.bind(client),
        }, {
          onEvent: (event) => emit(event),
        });
        await recovery.recoverPendingJobs();
      }

      await client.heartbeat('ONLINE', {
        maxConcurrentJobs: config.maxConcurrentJobs,
        localRecovery: localJobStore ? {
          ...localJobStore.getRecoverySummary(),
          jobs: localJobStore.listRecoverableJobs(25).map((job) => ({
            jobId: job.jobId,
            jobType: job.jobType,
            remoteTable: job.remoteTable,
            localState: job.localStatus,
            artifactReady: Boolean(job.artifactChecksum),
            artifactChecksum: job.artifactChecksum,
            artifactSizeBytes: job.artifactSizeBytes,
            cleanupPolicy: job.cleanupPolicy,
            cleanupStatus: job.cleanupStatus,
          })),
        } : undefined,
      });
      emit({ state: 'online', message: 'Conectado a SofLIA - Engine' });
      const jobs = client.claimNextBatch
        ? await client.claimNextBatch()
        : [await client.claimNext()].filter((job): job is ClaimedJob => Boolean(job));
      if (jobs.length === 0) {
        emit({ state: 'idle', message: 'Sin jobs pendientes' });
        await dependencies.sleep(pollIntervalMs);
        continue;
      }

      if (jobs.every((job) => job.jobType === 'template_preview')) {
        await Promise.all(jobs.map((job) => {
          registerLocalClaim(job);
          return processClaimedJob(job);
        }));
      } else {
        for (const job of jobs) {
          if (shouldStop) break;
          registerLocalClaim(job);
          await processClaimedJob(job);
        }
      }
    } catch (error) {
      const message = sanitizeLog(error instanceof Error ? error.message : String(error));
      logError('Error en worker start:', error);
      emit({ state: 'error', message });
      await dependencies.sleep(pollIntervalMs);
    }
  }

  try {
    await client.heartbeat('OFFLINE', { maxConcurrentJobs: config.maxConcurrentJobs });
  } catch {
    // Best-effort shutdown heartbeat only.
  }
  log('Worker local detenido');
  emit({ state: 'stopped', message: 'Worker local detenido' });
  localJobStore?.close();

  function registerLocalClaim(job: ClaimedJob): void {
    const jobType = job.jobType === 'template_build' ? 'template_build' : job.jobType === 'template_preview' ? 'template_preview' : 'render';
    localJobStore?.upsertClaimedJob({
      jobId: job.jobId,
      jobType,
      remoteTable: localJobTypeToRemoteTable(jobType),
      localStatus: 'claimed',
      stage: 'claim',
      cleanupPolicy: config.localRetentionPolicy || 'delete_on_remote_confirm',
      bundleHash: job.bundleHash,
      propsHash: job.jobType === 'template_build' ? undefined : job.propsHash,
      outputStoragePath: job.jobType === 'template_preview' ? job.posterStoragePath : job.outputStoragePath,
    });
  }
}
