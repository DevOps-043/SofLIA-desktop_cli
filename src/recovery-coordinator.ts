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

export class RecoveryCoordinator {
  private readonly retention: LocalArtifactRetentionService;

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

    if (job.localStatus === 'remote_confirmed_pending_cleanup' || job.cleanupStatus === 'pending' || job.cleanupStatus === 'cleanup_failed') {
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
        const body = await fsp.readFile(job.artifactPath);
        const response = await fetch(upload.uploadUrl, {
          method: 'PUT',
          headers: { 'content-type': contentTypeForJob(job.jobType) },
          body,
        });
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
        buildHash: job.jobType === 'template_build' ? job.artifactChecksum : undefined,
        buildLog: job.jobType === 'template_build' ? `Template build recovered locally. jobId=${job.jobId}` : undefined,
      });
      this.store.markRemoteConfirmed(job.jobId);
      const refreshed = this.store.listRecoverableJobs(50).find((item) => item.jobId === job.jobId) || job;
      await this.applyCleanup(refreshed);
    } catch (error) {
      if (job.localStatus === 'artifact_ready' || job.localStatus === 'upload_failed') {
        this.store.markUploadFailed(job.jobId, error);
      } else {
        this.store.markConfirmFailed(job.jobId, error);
      }
      this.events.onEvent?.({
        state: 'error',
        message: error instanceof Error ? error.message : String(error),
        jobId: job.jobId,
        jobType: job.jobType,
      });
    }
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

function contentTypeForJob(jobType: LocalJobRecord['jobType']): string {
  if (jobType === 'template_build') return 'application/zip';
  if (jobType === 'template_preview') return 'image/png';
  return 'video/mp4';
}
