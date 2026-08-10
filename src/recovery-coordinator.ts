import { createReadStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import type { LocalJobRecord, LocalRecoverySummary } from './local-job-state.js';
import { LocalArtifactRetentionService } from './local-artifact-retention.js';
import { LocalJobStore } from './local-job-store.js';

export interface RecoveryUploadUrl {
  uploadUrl: string;
  outputStoragePath: string;
  expiresInSeconds?: number;
}

export interface RecoveryClient {
  refreshUploadUrl: (jobId: string, input: {
    jobType: LocalJobRecord['jobType'];
    outputStoragePath: string;
  }) => Promise<RecoveryUploadUrl>;
  complete: (jobId: string, input: {
    outputStoragePath: string;
    checksum: string;
    durationSeconds?: number;
    previewDurationSeconds?: number;
    posterStoragePath?: string;
    videoStoragePath?: string;
    buildHash?: string;
    buildLog?: string;
  }) => Promise<unknown>;
}

export interface RecoveryCoordinatorEvents {
  onEvent?: (event: {
    state: 'recovering' | 'upload_pending' | 'confirm_pending' | 'cleanup_completed' | 'cleanup_skipped' | 'error';
    message: string;
    jobId?: string;
    jobType?: LocalJobRecord['jobType'];
    percent?: number;
    stage?: string;
    detail?: Record<string, unknown>;
  }) => void;
}

type StreamingRequestInit = RequestInit & {
  duplex: 'half';
};

export class RecoveryCoordinator {
  private readonly retention: LocalArtifactRetentionService;
  private readonly retryAfterByJobId = new Map<string, number>();
  private readonly retryDelayByJobId = new Map<string, number>();

  constructor(
    private readonly store: LocalJobStore,
    private readonly client: RecoveryClient,
    private readonly events: RecoveryCoordinatorEvents = {},
  ) {
    this.retention = new LocalArtifactRetentionService(store);
  }

  async recoverPendingJobs(limit = 10): Promise<LocalRecoverySummary> {
    const jobs = this.store.listRecoverableJobs(limit);
    for (const job of jobs) {
      if (!this.isReadyToRetry(job.jobId)) continue;
      await this.recoverJob(job);
    }
    return this.store.getRecoverySummary();
  }

  private async recoverJob(job: LocalJobRecord): Promise<void> {
    this.events.onEvent?.({
      state: 'recovering',
      message: 'Recuperando job local pendiente',
      jobId: job.jobId,
      jobType: job.jobType,
      stage: job.stage,
    });

    if (
      job.localStatus === 'remote_confirmed_pending_cleanup' &&
      (job.cleanupStatus === 'pending' || job.cleanupStatus === 'cleanup_failed')
    ) {
      await this.applyCleanup(job);
      return;
    }

    if (!job.artifactPath || !job.artifactChecksum || !job.outputStoragePath) return;

    try {
      await fsp.access(job.artifactPath);
      if (job.localStatus === 'artifact_ready' || job.localStatus === 'upload_failed') {
        this.events.onEvent?.({
          state: 'upload_pending',
          message: 'Reintentando subida de artefacto local',
          jobId: job.jobId,
          jobType: job.jobType,
          percent: 90,
          stage: 'recovery_upload',
        });
        const upload = await this.client.refreshUploadUrl(job.jobId, {
          jobType: job.jobType,
          outputStoragePath: job.outputStoragePath,
        });
        const stat = await fsp.stat(job.artifactPath);
        const uploadRequest: StreamingRequestInit = {
          method: 'PUT',
          headers: {
            'content-type': contentTypeForJob(job),
            'content-length': String(stat.size),
          },
          body: createReadStream(job.artifactPath) as unknown as BodyInit,
          duplex: 'half',
        };
        const response = await fetch(upload.uploadUrl, uploadRequest);
        if (!response.ok) throw new Error(`RECOVERY_UPLOAD_FAILED: HTTP ${response.status}`);
        this.store.markUploadedPendingComplete(job.jobId);
      }

      this.events.onEvent?.({
        state: 'confirm_pending',
        message: 'Reintentando confirmacion remota',
        jobId: job.jobId,
        jobType: job.jobType,
        percent: 95,
        stage: 'recovery_complete',
      });
      await this.client.complete(job.jobId, {
        outputStoragePath: job.outputStoragePath,
        checksum: job.artifactChecksum,
        durationSeconds: job.durationSeconds,
        previewDurationSeconds: job.jobType === 'template_preview' ? job.durationSeconds : undefined,
        posterStoragePath: job.jobType === 'template_preview' && isPreviewPosterPath(job.outputStoragePath) ? job.outputStoragePath : undefined,
        videoStoragePath: job.jobType === 'template_preview' && isPreviewVideoPath(job.outputStoragePath) ? job.outputStoragePath : undefined,
        buildHash: job.jobType === 'template_build' ? job.artifactChecksum : undefined,
        buildLog: job.jobType === 'template_build' ? `Template build recovered locally. jobId=${job.jobId}` : undefined,
      });
      this.store.markRemoteConfirmed(job.jobId);
      this.clearRetry(job.jobId);
      const refreshed = this.store.listRecoverableJobs(50).find((item) => item.jobId === job.jobId) || job;
      await this.applyCleanup(refreshed);
    } catch (error) {
      if (isTerminalRemoteCompletionError(error)) {
        const message = 'SofLIA ya no acepta confirmar este job porque fue cancelado o termino en otro estado. El archivo local se conserva para revision.';
        this.store.markNonRecoverableFailure(job.jobId, 'REMOTE_JOB_NOT_RECOVERABLE', message);
        this.events.onEvent?.({
          state: 'error',
          message,
          jobId: job.jobId,
          jobType: job.jobType,
          stage: 'remote_job_not_recoverable',
        });
        return;
      }
      if (job.localStatus === 'artifact_ready' || job.localStatus === 'upload_failed') {
        this.store.markUploadFailed(job.jobId, error);
      } else {
        this.store.markConfirmFailed(job.jobId, error);
      }
      this.scheduleRetry(job.jobId);
      this.events.onEvent?.({
        state: 'error',
        message: error instanceof Error ? error.message : String(error),
        jobId: job.jobId,
        jobType: job.jobType,
      });
    }
  }

  private isReadyToRetry(jobId: string): boolean {
    return (this.retryAfterByJobId.get(jobId) || 0) <= Date.now();
  }

  private scheduleRetry(jobId: string): void {
    const previousDelay = this.retryDelayByJobId.get(jobId) || 0;
    const delay = previousDelay === 0
      ? 10_000
      : Math.min(previousDelay * 2, 5 * 60_000);
    this.retryDelayByJobId.set(jobId, delay);
    this.retryAfterByJobId.set(jobId, Date.now() + delay);
  }

  private clearRetry(jobId: string): void {
    this.retryAfterByJobId.delete(jobId);
    this.retryDelayByJobId.delete(jobId);
  }

  private async applyCleanup(job: LocalJobRecord): Promise<void> {
    const result = await this.retention.applyRetention(job);
    this.events.onEvent?.({
      state: result === 'deleted' ? 'cleanup_completed' : 'cleanup_skipped',
      message: result === 'deleted' ? 'Artefacto local eliminado' : 'Artefacto local conservado',
      jobId: job.jobId,
      jobType: job.jobType,
      stage: 'cleanup',
    });
  }
}

function isTerminalRemoteCompletionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP 409:.*JOB_(?:NOT_CLAIM(?:ABLE|EABLE)|ALREADY_COMPLETED_WITH_DIFFERENT_OUTPUT|FORBIDDEN_FOR_WORKER|TYPE_NOT_SUPPORTED|PROVIDER_NOT_DESKTOP_WORKER)/i.test(message);
}

function contentTypeForJob(job: LocalJobRecord): string {
  if (job.jobType === 'template_build') return 'application/zip';
  if (job.jobType === 'template_preview') {
    return isPreviewVideoPath(job.outputStoragePath) ? 'video/mp4' : 'image/png';
  }
  return 'video/mp4';
}

function isPreviewVideoPath(value: string | undefined): value is string {
  return Boolean(value?.toLowerCase().match(/\.(mp4|webm|mov)$/));
}

function isPreviewPosterPath(value: string | undefined): value is string {
  return Boolean(value?.toLowerCase().match(/\.(png|jpe?g|webp)$/));
}
