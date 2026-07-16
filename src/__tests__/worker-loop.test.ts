import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ClaimedJob } from '../api-client.js';
import { startWorkerLoop } from '../worker-loop.js';
import type { WorkerRuntimeEvent } from '../shared/worker-events.js';

function createJob(jobId: string): ClaimedJob {
  return {
    jobId,
    compositionId: 'full-slides',
    resolvedProps: {},
    propsHash: `props-${jobId}`,
    bundleUrl: 'https://example.test/bundle.zip',
    bundleHash: `bundle-${jobId}`,
    outputUploadUrl: `https://example.test/upload/${jobId}`,
    outputStoragePath: `completed/${jobId}.mp4`,
    timeoutInMilliseconds: 120000,
  };
}

describe('startWorkerLoop', () => {
  it('forwards render progress events to the UI event stream', async () => {
    const events: WorkerRuntimeEvent[] = [];
    const controller = new AbortController();
    const job = createJob('job-progress');

    await startWorkerLoop({
      signal: controller.signal,
      pollIntervalMs: 1,
      onStatus: (event) => {
        events.push(event);
        if (event.state === 'completed') controller.abort();
      },
      dependencies: {
        loadConfig: async () => ({ apiUrl: 'http://localhost:4000', token: 'token' }),
        createClient: () => ({
          heartbeat: async () => ({}),
          claimNext: async () => job,
          fail: async () => ({}),
        }),
        renderJob: async (_client, claimedJob, options) => {
          options?.onProgress?.({
            jobId: claimedJob.jobId,
            compositionId: claimedJob.compositionId,
            percent: 42,
            stage: 'render',
            message: 'Renderizando fotogramas (22%)',
          });
        },
        sleep: async () => {},
      },
    });

    const progressEvent = events.find((event) => event.state === 'rendering' && event.percent === 42);
    assert.equal(progressEvent?.jobId, 'job-progress');
    assert.equal(progressEvent?.compositionId, 'full-slides');
    assert.equal(progressEvent?.stage, 'render');
  });

  it('claims queued jobs sequentially instead of rendering in parallel', async () => {
    const events: WorkerRuntimeEvent[] = [];
    const renderOrder: string[] = [];
    const controller = new AbortController();
    const jobs = [createJob('job-1'), createJob('job-2')];
    let claimIndex = 0;

    await startWorkerLoop({
      signal: controller.signal,
      pollIntervalMs: 1,
      onStatus: (event) => {
        events.push(event);
        if (event.state === 'completed' && event.jobId === 'job-2') controller.abort();
      },
      dependencies: {
        loadConfig: async () => ({ apiUrl: 'http://localhost:4000', token: 'token' }),
        createClient: () => ({
          heartbeat: async () => ({}),
          claimNext: async () => jobs[claimIndex++] || null,
          fail: async () => ({}),
        }),
        renderJob: async (_client, claimedJob) => {
          renderOrder.push(claimedJob.jobId);
        },
        sleep: async () => {},
      },
    });

    assert.deepEqual(renderOrder, ['job-1', 'job-2']);
    assert.deepEqual(
      events.filter((event) => event.state === 'completed').map((event) => event.jobId),
      ['job-1', 'job-2'],
    );
  });
});
