import { sanitizeLog } from './logging.js';

export interface ClaimedJob {
  jobId: string;
  compositionId: string;
  resolvedProps: Record<string, unknown>;
  propsHash: string;
  bundleUrl: string;
  bundleHash: string;
  bundleType?: 'zip' | 'serve_url';
  outputUploadUrl: string;
  outputStoragePath: string;
  timeoutInMilliseconds: number;
}

export interface LinkedWorker {
  id: string;
  organization_id: string;
  device_name: string;
  platform?: string;
  arch?: string;
  app_version?: string;
  status: string;
  token_last4: string;
  created_at: string;
}

export interface LinkWorkerInput {
  code: string;
  deviceName: string;
  platform: string;
  arch: string;
  appVersion: string;
}

export class SofliaWorkerApiClient {
  constructor(
    private readonly apiUrl: string,
    private readonly token?: string,
  ) {}

  async linkWorker(input: LinkWorkerInput): Promise<{ worker: LinkedWorker; workerToken: string }> {
    return this.post('/api/v1/production/remotion/workers/link', input, { auth: false });
  }

  async heartbeat(status: 'ONLINE' | 'BUSY' | 'OFFLINE' = 'ONLINE') {
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

  async claimNext(): Promise<ClaimedJob | null> {
    const response = await this.post<{ job: ClaimedJob | null }>(
      '/api/v1/production/remotion/workers/jobs/claim-next',
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

  private async post<T = Record<string, unknown>>(
    path: string,
    body: object,
    options: { auth?: boolean } = {},
  ): Promise<T> {
    const url = `${this.apiUrl}${path}`;
    let response: Response;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (options.auth !== false && this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new Error(
        `No se pudo conectar con la API de SofLIA - Engine en ${sanitizeLog(url)}. ` +
          `Verifica que el backend este corriendo y que --api-url apunte al puerto correcto. ` +
          `Detalle: ${sanitizeLog(error instanceof Error ? error.message : String(error))}`,
      );
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${sanitizeLog(text)}`);
    }

    return response.json() as Promise<T>;
  }
}
