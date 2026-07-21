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

function createTemplateBuildJob(jobId: string): ClaimedJob {
  return {
    jobType: 'template_build',
    jobId,
    buildId: jobId,
    templateVersionId: `version-${jobId}`,
    compositionId: 'full-slides',
    exportMode: 'root',
    bundleUrl: 'https://example.test/source.zip',
    bundleHash: `bundle-${jobId}`,
    outputUploadUrl: `https://example.test/upload/${jobId}.zip`,
    outputStoragePath: `template-bundles/template-builds/${jobId}/bundle.zip`,
    timeoutInMilliseconds: 900000,
  };
}

function createTemplatePreviewJob(jobId: string): ClaimedJob {
  return {
    jobType: 'template_preview',
    jobId,
    previewId: jobId,
    templateId: `template-${jobId}`,
    buildId: `build-${jobId}`,
    templateVersionId: `version-${jobId}`,
    compositionId: 'full-slides',
    resolvedProps: {},
    propsHash: `props-${jobId}`,
    bundleUrl: 'https://example.test/compiled.zip',
    bundleHash: 'f'.repeat(64),
    bundleType: 'zip',
    posterUploadUrl: `https://example.test/upload/${jobId}.png`,
    posterStoragePath: `template-previews/${jobId}/poster.png`,
    previewFrame: 12,
    timeoutInMilliseconds: 300000,
  };
}

describe('startWorkerLoop', () => {
  it('forwards render progress events to the UI event stream', async () => {
    const events: WorkerRuntimeEvent[] = [];
    const controller = new AbortController();
    const job = createJob('job-progress');
    let renderConcurrency: number | undefined;

    await startWorkerLoop({
      signal: controller.signal,
      pollIntervalMs: 1,
      onStatus: (event) => {
        events.push(event);
        if (event.state === 'completed') controller.abort();
      },
      dependencies: {
        loadConfig: async () => ({
          apiUrl: 'http://localhost:4000',
          token: 'token',
          powerProfile: 'high',
          maxConcurrentJobs: 4,
          renderConcurrency: 4,
        }),
        createClient: () => ({
          heartbeat: async () => ({}),
          claimNext: async () => job,
          fail: async () => ({}),
        }),
        renderJob: async (_client, claimedJob, options) => {
          renderConcurrency = options?.renderConcurrency;
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
    assert.equal(renderConcurrency, 4);
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

  it('dispatches template build jobs to the build handler', async () => {
    const controller = new AbortController();
    const job = createTemplateBuildJob('build-1');
    const renderedJobs: string[] = [];
    const builtJobs: string[] = [];

    await startWorkerLoop({
      signal: controller.signal,
      pollIntervalMs: 1,
      onStatus: (event) => {
        if (event.state === 'completed') controller.abort();
      },
      dependencies: {
        loadConfig: async () => ({ apiUrl: 'http://localhost:4000', token: 'token' }),
        createClient: () => ({
          heartbeat: async () => ({}),
          claimNext: async () => job,
          fail: async () => ({}),
        }),
        renderJob: async (_client, claimedJob) => {
          renderedJobs.push(claimedJob.jobId);
        },
        buildTemplate: async (_client, claimedJob) => {
          builtJobs.push(claimedJob.jobId);
        },
        sleep: async () => {},
      },
    });

    assert.deepEqual(renderedJobs, []);
    assert.deepEqual(builtJobs, ['build-1']);
  });

  it('dispatches template preview jobs to the preview handler', async () => {
    const controller = new AbortController();
    const job = createTemplatePreviewJob('preview-1');
    const renderedJobs: string[] = [];
    const builtJobs: string[] = [];
    const previewJobs: string[] = [];

    await startWorkerLoop({
      signal: controller.signal,
      pollIntervalMs: 1,
      onStatus: (event) => {
        if (event.state === 'completed') controller.abort();
      },
      dependencies: {
        loadConfig: async () => ({ apiUrl: 'http://localhost:4000', token: 'token' }),
        createClient: () => ({
          heartbeat: async () => ({}),
          claimNext: async () => job,
          fail: async () => ({}),
        }),
        renderJob: async (_client, claimedJob) => {
          renderedJobs.push(claimedJob.jobId);
        },
        buildTemplate: async (_client, claimedJob) => {
          builtJobs.push(claimedJob.jobId);
        },
        renderTemplatePreview: async (_client, claimedJob) => {
          previewJobs.push(claimedJob.jobId);
        },
        sleep: async () => {},
      },
    });

    assert.deepEqual(renderedJobs, []);
    assert.deepEqual(builtJobs, []);
    assert.deepEqual(previewJobs, ['preview-1']);
  });

  it('processes batched template preview jobs concurrently', async () => {
    const controller = new AbortController();
    const jobs = [
      createTemplatePreviewJob('preview-1'),
      createTemplatePreviewJob('preview-2'),
    ];
    const previewJobs: string[] = [];
    let completedCount = 0;
    let activePreviews = 0;
    let maxActivePreviews = 0;

    await startWorkerLoop({
      signal: controller.signal,
      pollIntervalMs: 1,
      onStatus: (event) => {
        if (event.state === 'completed') {
          completedCount += 1;
          if (completedCount === jobs.length) controller.abort();
        }
      },
      dependencies: {
        loadConfig: async () => ({
          apiUrl: 'http://localhost:4000',
          token: 'token',
          powerProfile: 'balanced',
          maxConcurrentJobs: 2,
          renderConcurrency: 2,
        }),
        createClient: () => ({
          heartbeat: async () => ({}),
          claimNext: async () => null,
          claimNextBatch: async () => jobs,
          fail: async () => ({}),
        }),
        renderJob: async () => {},
        buildTemplate: async () => {},
        renderTemplatePreview: async (_client, claimedJob) => {
          activePreviews += 1;
          maxActivePreviews = Math.max(maxActivePreviews, activePreviews);
          previewJobs.push(claimedJob.jobId);
          await new Promise((resolve) => setTimeout(resolve, 1));
          activePreviews -= 1;
        },
        sleep: async () => {},
      },
    });

    assert.deepEqual(previewJobs.sort(), ['preview-1', 'preview-2']);
    assert.equal(maxActivePreviews, 2);
  });
});
