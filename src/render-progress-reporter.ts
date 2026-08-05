import type { ClaimedRenderJob, SofliaWorkerApiClient } from './api-client.js';
import { logError } from './logging.js';
import type { RenderProgressEvent } from './shared/worker-events.js';

export class RenderProgressReporter {
  private queue: Promise<void> = Promise.resolve();

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

  private enqueue(
    percent: number,
    message: string,
    stage: string,
    detail?: Record<string, unknown>,
  ): Promise<void> {
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
