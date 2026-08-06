import type { ClaimedRenderJob, SofliaWorkerApiClient } from './api-client.js';
import { logError } from './logging.js';
import type { RenderProgressEvent } from './shared/worker-events.js';

export class RenderProgressReporter {
  private queue: Promise<void> = Promise.resolve();
  private lastReport: {
    percent: number;
    message: string;
    stage: string;
    detail?: Record<string, unknown>;
  } | null = null;

  constructor(
    private readonly client: SofliaWorkerApiClient,
    private readonly job: ClaimedRenderJob,
    private readonly onProgress?: (event: RenderProgressEvent) => void,
  ) {}

  report(
    percent: number,
    message: string,
    stage: string,
    detail?: Record<string, unknown>,
  ): Promise<void> {
    return this.enqueue(percent, message, stage, detail);
  }

  schedule(
    percent: number,
    message: string,
    stage: string,
    detail?: Record<string, unknown>,
  ): void {
    void this.enqueue(percent, message, stage, detail).catch(() => undefined);
  }

  startKeepAlive(intervalMs = 45_000): () => void {
    const timer = setInterval(() => {
      const lastReport = this.lastReport;
      if (!lastReport) return;
      this.schedule(
        lastReport.percent,
        lastReport.message,
        lastReport.stage,
        { ...lastReport.detail, keepAlive: true },
      );
    }, Math.max(1, Math.round(intervalMs)));
    timer.unref?.();
    return () => clearInterval(timer);
  }

  private enqueue(
    percent: number,
    message: string,
    stage: string,
    detail?: Record<string, unknown>,
  ): Promise<void> {
    this.lastReport = { percent, message, stage, detail };
    const operation = this.queue.then(async () => {
      this.onProgress?.({
        jobId: this.job.jobId,
        compositionId: this.job.compositionId,
        percent,
        message,
        stage,
        detail,
      });
      await this.client.progress(this.job.jobId, percent, message, stage, detail);
    });
    this.queue = operation.catch((error) => {
      logError('No se pudo reportar el progreso del render:', error);
    });
    return operation;
  }
}
