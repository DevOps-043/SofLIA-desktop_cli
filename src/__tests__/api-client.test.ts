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

  it('sends worker capacity in heartbeat payloads', async () => {
    let requestBody: any = null;

    globalThis.fetch = (async (_url, init) => {
      requestBody = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
      return new Response(JSON.stringify({ worker: { id: 'worker-1' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const client = new SofliaWorkerApiClient('http://localhost:4000', 'swk_secret');
    await client.heartbeat('ONLINE', { maxConcurrentJobs: 4 });

    assert.equal(requestBody?.status, 'ONLINE');
    assert.equal(requestBody?.maxConcurrentJobs, 4);
  });

  it('claims template build jobs returned by the control plane', async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({
        job: {
          jobType: 'template_build',
          jobId: 'build-1',
          buildId: 'build-1',
          templateVersionId: 'version-1',
          compositionId: 'full-slides',
          exportMode: 'root',
          bundleUrl: 'https://example.test/source.zip',
          bundleHash: 'abc123',
          outputUploadUrl: 'https://example.test/upload/build.zip',
          outputStoragePath: 'template-bundles/template-builds/build-1/abc123.zip',
          timeoutInMilliseconds: 900000,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const client = new SofliaWorkerApiClient('http://localhost:4000', 'swk_secret');
    const job = await client.claimNext();

    assert.equal(job?.jobType, 'template_build');
    if (job?.jobType !== 'template_build') {
      assert.fail('Expected a template build job');
    }
    assert.equal(job.buildId, 'build-1');
    assert.equal(job.outputStoragePath, 'template-bundles/template-builds/build-1/abc123.zip');
  });

  it('claims batched jobs returned by the control plane', async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({
        job: null,
        jobs: [
          {
            jobType: 'template_preview',
            jobId: 'preview-1',
            previewId: 'preview-1',
            templateId: 'template-1',
            buildId: 'build-1',
            templateVersionId: 'version-1',
            compositionId: 'full-slides',
            resolvedProps: {},
            propsHash: 'props-1',
            bundleUrl: 'https://example.test/compiled.zip',
            bundleHash: 'f'.repeat(64),
            bundleType: 'zip',
            posterUploadUrl: 'https://example.test/upload/preview-1.png',
            posterStoragePath: 'template-previews/preview-1/poster.png',
            previewFrame: 12,
            timeoutInMilliseconds: 300000,
          },
          {
            jobType: 'template_preview',
            jobId: 'preview-2',
            previewId: 'preview-2',
            templateId: 'template-1',
            buildId: 'build-1',
            templateVersionId: 'version-1',
            compositionId: 'full-slides',
            resolvedProps: {},
            propsHash: 'props-2',
            bundleUrl: 'https://example.test/compiled.zip',
            bundleHash: 'f'.repeat(64),
            bundleType: 'zip',
            posterUploadUrl: 'https://example.test/upload/preview-2.png',
            posterStoragePath: 'template-previews/preview-2/poster.png',
            previewFrame: 24,
            timeoutInMilliseconds: 300000,
          },
        ],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const client = new SofliaWorkerApiClient('http://localhost:4000', 'swk_secret');
    const jobs = await client.claimNextBatch();

    assert.equal(jobs.length, 2);
    assert.equal(jobs[0]?.jobType, 'template_preview');
    assert.equal(jobs[1]?.jobId, 'preview-2');
  });
});
