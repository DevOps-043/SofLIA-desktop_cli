import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { WorkerTelemetryStore } from '../worker-telemetry-store.js';

let tempRoot = '';

beforeEach(async () => {
  tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'soflia-worker-telemetry-store-'));
});

afterEach(async () => {
  await fsp.rm(tempRoot, { recursive: true, force: true });
});

function createStore() {
  return new WorkerTelemetryStore(path.join(tempRoot, 'state', 'worker-state.db'));
}

describe('WorkerTelemetryStore', () => {
  it('persists run lifecycle, samples and finish summary', async () => {
    const store = createStore();
    await store.initialize();

    store.startRun({
      localRunId: 'run-1',
      jobId: 'job-1',
      jobType: 'render',
      compositionId: 'full-slides',
      bundleHash: 'bundle',
      propsHash: 'props',
      status: 'running',
      startedAt: '2026-07-25T20:00:00.000Z',
      config: {
        powerProfile: 'balanced',
        renderConcurrency: 2,
        maxConcurrentJobs: 2,
        hardwareAcceleration: 'if-possible',
        chromiumGl: null,
      },
      hardware: {
        platform: 'win32',
        arch: 'x64',
        cpuModel: 'Test CPU',
        cpuLogicalThreads: 8,
        memoryTotalBytes: 16000,
        gpuAdapters: [{ name: 'Test GPU', memoryBytes: 4000 }],
      },
    });

    store.recordSample({
      localRunId: 'run-1',
      jobId: 'job-1',
      sampledAt: '2026-07-25T20:00:02.000Z',
      workerState: 'rendering',
      stage: 'render',
      progressPercent: 50,
      appCpuPercent: 10,
      appGpuPercent: 5,
      appMemoryBytes: 100,
      appProcessCount: 2,
      systemCpuPercent: 25,
      systemGpuPercent: 15,
      systemMemoryUsedBytes: 500,
      systemMemoryTotalBytes: 1000,
      systemCpuCount: 8,
      topProcesses: [{ pid: 10, name: 'soflia.exe', type: 'Browser', cpuPercent: 10, memoryBytes: 100 }],
      systemTopProcesses: [{ pid: 20, name: 'chrome.exe', type: 'Process', cpuPercent: 25, memoryBytes: 500 }],
    });
    store.recordSample({
      localRunId: 'run-1',
      jobId: 'job-1',
      sampledAt: '2026-07-25T20:00:04.000Z',
      workerState: 'rendering',
      stage: 'render',
      progressPercent: 75,
      appCpuPercent: 30,
      appGpuPercent: 15,
      appMemoryBytes: 300,
      appProcessCount: 3,
      systemCpuPercent: 45,
      systemGpuPercent: 35,
      systemMemoryUsedBytes: 700,
      systemMemoryTotalBytes: 1000,
      systemCpuCount: 8,
      topProcesses: [],
      systemTopProcesses: [],
    });

    const summary = store.finishRun({
      localRunId: 'run-1',
      status: 'completed',
      finishedAt: '2026-07-25T20:01:00.000Z',
      elapsedMs: 60000,
      lastStage: 'complete',
      lastProgressPercent: 100,
    });

    assert.equal(summary.sampleCount, 2);
    assert.equal(summary.avgAppCpuPercent, 20);
    assert.equal(summary.maxAppGpuPercent, 15);
    assert.equal(summary.maxSystemMemoryUsedBytes, 700);
    assert.equal(store.listRunsNeedingStart()[0]?.localRunId, 'run-1');

    store.markRunStartSynced('run-1', 'remote-run-1');
    assert.equal(store.listPendingSamples().length, 2);
    assert.equal(store.listPendingSamples()[0]?.systemTopProcesses?.[0]?.name, 'chrome.exe');
    store.markSamplesSynced(store.listPendingSamples().map((sample) => sample.id));
    assert.equal(store.listPendingSamples().length, 0);
    assert.equal(store.listRunsNeedingFinish()[0]?.summary.sampleCount, 2);

    store.close();
  });
});
