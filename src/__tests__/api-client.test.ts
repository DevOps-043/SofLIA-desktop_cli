import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { SofliaWorkerApiClient } from '../api-client.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('SofliaWorkerApiClient', () => {
  it('links a worker without sending bearer authorization', async () => {
    let requestHeaders: HeadersInit | undefined;
    let requestBody: any = null;

    globalThis.fetch = (async (_url, init) => {
      requestHeaders = init?.headers;
      requestBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
      return new Response(JSON.stringify({
        worker: {
          id: 'worker-1',
          organization_id: 'org-1',
          device_name: 'devbox',
          status: 'LINKED',
          token_last4: 'abcd',
          created_at: '2026-07-11T00:00:00.000Z',
        },
        workerToken: 'swk_secret',
      }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const client = new SofliaWorkerApiClient('http://localhost:4000');
    const result = await client.linkWorker({
      code: 'SLIA-482913',
      deviceName: 'devbox',
      platform: 'win32',
      arch: 'x64',
      appVersion: '0.1.0',
    });

    assert.equal(result.workerToken, 'swk_secret');
    assert.equal(requestBody?.code, 'SLIA-482913');
    assert.equal((requestHeaders as Record<string, string>).authorization, undefined);
  });

  it('claims the next queued job with bearer authorization', async () => {
    let requestUrl = '';
    let requestHeaders: HeadersInit | undefined;

    globalThis.fetch = (async (url, init) => {
      requestUrl = String(url);
      requestHeaders = init?.headers;
      return new Response(JSON.stringify({
        job: {
          jobId: 'job-1',
          compositionId: 'full-slides',
          resolvedProps: {},
          propsHash: 'props',
          bundleUrl: 'https://example.test/bundle.zip',
          bundleHash: 'bundle',
          outputUploadUrl: 'https://example.test/upload',
          outputStoragePath: 'completed/job-1.mp4',
          timeoutInMilliseconds: 120000,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const client = new SofliaWorkerApiClient('http://localhost:4000', 'swk_secret');
    const job = await client.claimNext();

    assert.equal(requestUrl, 'http://localhost:4000/api/v1/production/remotion/workers/jobs/claim-next');
    assert.equal((requestHeaders as Record<string, string>).authorization, 'Bearer swk_secret');
    assert.equal(job?.jobId, 'job-1');
  });
});
