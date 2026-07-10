import { sanitizeLog } from './logging.js';

export interface ClaimedJob {
  jobId: string;
  compositionId: string;
  resolvedProps: Record<string, unknown>;
  propsHash: string;
  bundleUrl: string;
  bundleHash: string;
  outputUploadUrl: string;
  outputStoragePath: string;
  timeoutInMilliseconds: number;
}

export class SofliaWorkerApiClient {
  constructor(
    private readonly apiUrl: string,
    private readonly token: string,
  ) {}

  async heartbeat(status: 'ONLINE' | 'BUSY' = 'ONLINE') {
    return this.post('/api/v1/production/remotion/workers/heartbeat', {
      status,
      platform: process.platform,
      arch: process.arch,
      appVersion: process.env.npm_package_version || 'dev',
    });
  }

  async claim(jobId: string): Promise<ClaimedJob> {
    const response = await this.post<{ job: ClaimedJob }>(
      `/api/v1/production/remotion/workers/jobs/${encodeURIComponent(jobId)}/claim`,
      {},
    );
    return response.job;
  }

  async progress(jobId: string, percent: number, message: string, stage: string) {
    return this.post(`/api/v1/production/remotion/workers/jobs/${encodeURIComponent(jobId)}/progress`, {
      percent,
      message,
      stage,
    });
  }

  async complete(jobId: string, input: {
    outputStoragePath: string;
    checksum: string;
    durationSeconds: number;
  }) {
    return this.post(`/api/v1/production/remotion/workers/jobs/${encodeURIComponent(jobId)}/complete`, input);
  }

  async fail(jobId: string, input: {
    errorCode: string;
    message: string;
    stage: string;
  }) {
    return this.post(`/api/v1/production/remotion/workers/jobs/${encodeURIComponent(jobId)}/fail`, input);
  }

  private async post<T = Record<string, unknown>>(path: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.apiUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${sanitizeLog(text)}`);
    }

    return response.json() as Promise<T>;
  }
}
