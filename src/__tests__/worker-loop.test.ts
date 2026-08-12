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
    videoUploadUrl: `https://example.test/upload/${jobId}.mp4`,
    videoStoragePath: `template-previews/${jobId}/preview.mp4`,
    previewFrame: 12,
    timeoutInMilliseconds: 300000,
  };
}

function createNoopWorkspaceCleanup() {
  return {
    cleanupJobWorkspace: async () => ({ deleted: false }),
    cleanupStaleTransientWorkspaces: async () => ({ deletedCount: 0, skippedCount: 0 }),
  };
}

describe('startWorkerLoop', () => {
  it('forwards render progress events to the UI event stream', async () => {
    const events: WorkerRuntimeEvent[] = [];
    const controller = new AbortController();
    const job = createJob('job-progress');
    let renderConcurrency: number | undefined;
    let hardwareAcceleration: string | undefined;
    let chromiumGl: string | null | undefined;
    let videoBitrate: string | undefined;

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
          hardwareAcceleration: 'if-possible',
          chromiumGl: 'angle',
          videoBitrate: '8M',
        }),
        createClient: () => ({
          heartbeat: async () => ({}),
          claimNext: async () => job,
          fail: async () => ({}),
        }),
        createLocalJobStore: async () => null,
        createWorkspaceCleanup: createNoopWorkspaceCleanup,
        renderJob: async (_client, claimedJob, options) => {
          renderConcurrency = options?.renderConcurrency;
          hardwareAcceleration = options?.hardwareAcceleration;
          chromiumGl = options?.chromiumGl;
          videoBitrate = options?.videoBitrate;
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
    assert.equal(hardwareAcceleration, 'if-possible');
    assert.equal(chromiumGl, 'angle');
    assert.equal(videoBitrate, '8M');
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
        createLocalJobStore: async () => null,
        createWorkspaceCleanup: createNoopWorkspaceCleanup,
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
        createLocalJobStore: async () => null,
        createWorkspaceCleanup: createNoopWorkspaceCleanup,
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
        createLocalJobStore: async () => null,
        createWorkspaceCleanup: createNoopWorkspaceCleanup,
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
    const renderConcurrencyByJob = new Map<string, number | undefined>();

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
          maxParallelPreviews: 2,
          renderConcurrency: 2,
        }),
        createClient: () => ({
          heartbeat: async () => ({}),
          claimNext: async () => null,
          claimNextBatch: async () => jobs,
          fail: async () => ({}),
        }),
        createLocalJobStore: async () => null,
        createWorkspaceCleanup: createNoopWorkspaceCleanup,
        renderJob: async () => {},
        buildTemplate: async () => {},
        renderTemplatePreview: async (_client, claimedJob, options) => {
          activePreviews += 1;
          maxActivePreviews = Math.max(maxActivePreviews, activePreviews);
          previewJobs.push(claimedJob.jobId);
          renderConcurrencyByJob.set(claimedJob.jobId, options?.renderConcurrency);
          await new Promise((resolve) => setTimeout(resolve, 1));
          activePreviews -= 1;
        },
        sleep: async () => {},
      },
    });

    assert.deepEqual(previewJobs.sort(), ['preview-1', 'preview-2']);
    assert.equal(maxActivePreviews, 2);
    assert.deepEqual([...renderConcurrencyByJob.values()], [1, 1]);
  });

  it('processes oversized preview batches in bounded chunks', async () => {
    const controller = new AbortController();
    const jobs = Array.from({ length: 5 }, (_, index) => createTemplatePreviewJob(`preview-${index + 1}`));
    let completedCount = 0;
    let activePreviews = 0;
    let maxActivePreviews = 0;
    const perJobConcurrency: number[] = [];

    await startWorkerLoop({
      signal: controller.signal,
      pollIntervalMs: 1,
      onStatus: (event) => {
        if (event.state === 'completed' && ++completedCount === jobs.length) controller.abort();
      },
      dependencies: {
        loadConfig: async () => ({
          apiUrl: 'http://localhost:4000',
          token: 'token',
          maxConcurrentJobs: 3,
          maxParallelPreviews: 2,
          renderConcurrency: 6,
          hardwareAcceleration: 'disable',
          chromiumGl: 'angle',
        }),
        createClient: () => ({
          heartbeat: async () => ({}),
          claimNext: async () => null,
          claimNextBatch: async () => jobs,
          fail: async () => ({}),
        }),
        createLocalJobStore: async () => null,
        createWorkspaceCleanup: createNoopWorkspaceCleanup,
        renderJob: async () => {},
        buildTemplate: async () => {},
        renderTemplatePreview: async (_client, _job, options) => {
          activePreviews += 1;
          maxActivePreviews = Math.max(maxActivePreviews, activePreviews);
          perJobConcurrency.push(options?.renderConcurrency!);
          await new Promise((resolve) => setTimeout(resolve, 1));
          activePreviews -= 1;
        },
        sleep: async () => {},
      },
    });

    assert.equal(maxActivePreviews, 2);
    assert.deepEqual(perJobConcurrency, [3, 3, 3, 3, 3]);
  });

  it('reports the concrete render error code and last observed stage', async () => {
    const controller = new AbortController();
    const job = createJob('job-failure-details');
    let failure: { errorCode: string; message: string; stage: string } | undefined;

    await startWorkerLoop({
      signal: controller.signal,
      pollIntervalMs: 1,
      onStatus: (event) => {
        if (event.state === 'error') controller.abort();
      },
      dependencies: {
        loadConfig: async () => ({ apiUrl: 'http://localhost:4000', token: 'token' }),
        createClient: () => ({
          heartbeat: async () => ({}),
          claimNext: async () => job,
          fail: async (_jobId, input) => {
            failure = input;
            return {};
          },
        }),
        createLocalJobStore: async () => null,
        createWorkspaceCleanup: createNoopWorkspaceCleanup,
        renderJob: async (_client, claimedJob, options) => {
          options?.onProgress?.({
            jobId: claimedJob.jobId,
            compositionId: claimedJob.compositionId,
            percent: 19,
            stage: 'asset_prepare',
            message: 'Validando avatarVideoUrl',
          });
          throw new Error('RENDER_ASSET_INCOMPLETE: avatarVideoUrl expected 4 bytes, got 3');
        },
        sleep: async () => {},
      },
    });

    assert.deepEqual(failure, {
      errorCode: 'RENDER_ASSET_INCOMPLETE',
      message: 'RENDER_ASSET_INCOMPLETE: avatarVideoUrl expected 4 bytes, got 3',
      stage: 'asset_prepare',
    });
  });
});
