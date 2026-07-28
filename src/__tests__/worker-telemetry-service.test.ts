import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { WorkerTelemetryService } from '../worker-telemetry-service.js';
import { WorkerTelemetryStore } from '../worker-telemetry-store.js';

let tempRoot = '';

beforeEach(async () => {
  tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'soflia-worker-telemetry-service-'));
});

afterEach(async () => {
  await fsp.rm(tempRoot, { recursive: true, force: true });
});

function createStore() {
  return new WorkerTelemetryStore(path.join(tempRoot, 'state', 'worker-state.db'));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('WorkerTelemetryService', () => {
  it('does not reopen a finished run when a late event arrives for the same job', async () => {
    const store = createStore();
    const service = new WorkerTelemetryService({
      store,
      loadConfig: async () => {
        throw new Error('offline');
      },
      loadOptionalConfig: async () => ({ apiUrl: 'http://localhost:4000', token: 'token' }),
      readHardwareSnapshot: async () => ({
        platform: 'win32',
        arch: 'x64',
        cpuModel: 'Test CPU',
        cpuLogicalThreads: 4,
        memoryTotalBytes: 16 * 1024 * 1024 * 1024,
        gpuAdapters: [],
      }),
      now: () => Date.parse('2026-07-27T23:00:00.000Z'),
    });
    await service.initialize();

    service.handleWorkerEvent({
      state: 'claiming',
      message: 'Job reclamado',
      jobId: 'job-1',
      jobType: 'render',
      compositionId: 'full-slides',
      percent: 0,
      stage: 'claim',
      startedAt: '2026-07-27T22:40:00.000Z',
    });
    service.handleWorkerEvent({
      state: 'completed',
      message: 'Render completado',
      jobId: 'job-1',
      jobType: 'render',
      compositionId: 'full-slides',
      percent: 100,
      stage: 'complete',
      startedAt: '2026-07-27T22:40:00.000Z',
      finishedAt: '2026-07-27T23:00:00.000Z',
      elapsedMs: 1200000,
    });
    service.handleWorkerEvent({
      state: 'rendering',
      message: 'Evento tardio',
      jobId: 'job-1',
      jobType: 'render',
      compositionId: 'full-slides',
      percent: 90,
      stage: 'upload',
      startedAt: '2026-07-27T23:00:01.000Z',
    });

    const runs = store.listRunsNeedingStart(10);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.status, 'completed');
    assert.equal(runs[0]?.startedAt, '2026-07-27T22:40:00.000Z');

    service.close();
  });

  it('retries pending sample flushes after a transient send failure while idle', async () => {
    const store = createStore();
    let sendAttempts = 0;
    const service = new WorkerTelemetryService({
      store,
      loadConfig: async () => ({ apiUrl: 'http://localhost:4000', token: 'token' }),
      loadOptionalConfig: async () => ({ apiUrl: 'http://localhost:4000', token: 'token' }),
      createClient: () => ({
        startTelemetryRun: async () => ({ runId: 'remote-run-1' }),
        sendTelemetrySamples: async () => {
          sendAttempts += 1;
          if (sendAttempts === 1) throw new Error('temporary outage');
          return { accepted: 1 };
        },
        finishTelemetryRun: async () => ({ runId: 'remote-run-1' }),
      }),
      readHardwareSnapshot: async () => ({
        platform: 'win32',
        arch: 'x64',
        cpuModel: 'Test CPU',
        cpuLogicalThreads: 4,
        memoryTotalBytes: 16 * 1024 * 1024 * 1024,
        gpuAdapters: [],
      }),
      flushBackoffMs: 10,
    });
    await service.initialize();

    service.handleWorkerEvent({
      state: 'claiming',
      message: 'Job reclamado',
      jobId: 'job-1',
      jobType: 'render',
      compositionId: 'full-slides',
      percent: 0,
      stage: 'claim',
      startedAt: '2026-07-27T22:40:00.000Z',
    });
    service.handleResourceSnapshot({
      sampledAt: '2026-07-27T22:40:02.000Z',
      platform: 'win32',
      workerState: 'rendering',
      system: {
        cpuPercent: 80,
        gpuPercent: 0,
        memoryUsedBytes: 1000,
        memoryTotalBytes: 2000,
        cpuCount: 4,
      },
      app: {
        cpuPercent: 10,
        gpuPercent: 0,
        memoryBytes: 500,
        processCount: 1,
      },
      processes: [{ pid: 10, name: 'worker.exe', type: 'Process', cpuPercent: 10, memoryBytes: 500 }],
      systemProcesses: [{ pid: 20, name: 'chrome.exe', type: 'Process', cpuPercent: 30, memoryBytes: 800 }],
      activeJob: {
        jobId: 'job-1',
        jobType: 'render',
        compositionId: 'full-slides',
        percent: 42,
        stage: 'render_frames',
      },
    });

    await waitFor(() => sendAttempts >= 2 && store.listPendingSamples().length === 0);

    assert.equal(sendAttempts, 2);
    service.close();
  });

  it('finishes remote runs even when sample uploads keep failing', async () => {
    const store = createStore();
    let finishAttempts = 0;
    const service = new WorkerTelemetryService({
      store,
      loadConfig: async () => ({ apiUrl: 'http://localhost:4000', token: 'token' }),
      loadOptionalConfig: async () => ({ apiUrl: 'http://localhost:4000', token: 'token' }),
      createClient: () => ({
        startTelemetryRun: async () => ({ runId: 'remote-run-1' }),
        sendTelemetrySamples: async () => {
          throw new Error('sample schema mismatch');
        },
        finishTelemetryRun: async () => {
          finishAttempts += 1;
          return { runId: 'remote-run-1' };
        },
      }),
      readHardwareSnapshot: async () => ({
        platform: 'win32',
        arch: 'x64',
        cpuModel: 'Test CPU',
        cpuLogicalThreads: 4,
        memoryTotalBytes: 16 * 1024 * 1024 * 1024,
        gpuAdapters: [],
      }),
      flushBackoffMs: 10,
    });
    await service.initialize();

    service.handleWorkerEvent({
      state: 'claiming',
      message: 'Job reclamado',
      jobId: 'job-1',
      jobType: 'render',
      compositionId: 'full-slides',
      percent: 0,
      stage: 'claim',
      startedAt: '2026-07-27T22:40:00.000Z',
    });
    service.handleResourceSnapshot({
      sampledAt: '2026-07-27T22:40:02.000Z',
      platform: 'win32',
      workerState: 'rendering',
      system: {
        cpuPercent: 80,
        gpuPercent: 0,
        memoryUsedBytes: 1000,
        memoryTotalBytes: 2000,
        cpuCount: 4,
      },
      app: {
        cpuPercent: 10,
        gpuPercent: 0,
        memoryBytes: 500,
        processCount: 1,
      },
      processes: [{ pid: 10, name: 'worker.exe', type: 'Process', cpuPercent: 10, memoryBytes: 500 }],
      systemProcesses: [{ pid: 20, name: 'chrome.exe', type: 'Process', cpuPercent: 30, memoryBytes: 800 }],
      activeJob: {
        jobId: 'job-1',
        jobType: 'render',
        compositionId: 'full-slides',
        percent: 42,
        stage: 'render_frames',
      },
    });
    service.handleWorkerEvent({
      state: 'completed',
      message: 'Render completado',
      jobId: 'job-1',
      jobType: 'render',
      compositionId: 'full-slides',
      percent: 100,
      stage: 'complete',
      startedAt: '2026-07-27T22:40:00.000Z',
      finishedAt: '2026-07-27T23:00:00.000Z',
      elapsedMs: 1200000,
    });

    await waitFor(() => finishAttempts >= 1 && store.listRunsNeedingFinish().length === 0);

    assert.equal(finishAttempts, 1);
    assert.equal(store.listPendingSamples().length, 1);
    service.close();
  });

  it('records system process snapshots for a single open run without active job context', async () => {
    const store = createStore();
    let sentSamples: any[] = [];
    const service = new WorkerTelemetryService({
      store,
      loadConfig: async () => ({ apiUrl: 'http://localhost:4000', token: 'token' }),
      loadOptionalConfig: async () => ({ apiUrl: 'http://localhost:4000', token: 'token' }),
      createClient: () => ({
        startTelemetryRun: async () => ({ runId: 'remote-run-1' }),
        sendTelemetrySamples: async (_jobId, _localRunId, input) => {
          sentSamples = input.samples;
          return { accepted: input.samples.length };
        },
        finishTelemetryRun: async () => ({ runId: 'remote-run-1' }),
      }),
      readHardwareSnapshot: async () => ({
        platform: 'win32',
        arch: 'x64',
        cpuModel: 'Test CPU',
        cpuLogicalThreads: 4,
        memoryTotalBytes: 16 * 1024 * 1024 * 1024,
        gpuAdapters: [],
      }),
    });
    await service.initialize();

    service.handleWorkerEvent({
      state: 'claiming',
      message: 'Job reclamado',
      jobId: 'job-1',
      jobType: 'render',
      compositionId: 'full-slides',
      percent: 0,
      stage: 'claim',
      startedAt: '2026-07-27T22:40:00.000Z',
    });
    service.handleResourceSnapshot({
      sampledAt: '2026-07-27T22:40:02.000Z',
      platform: 'win32',
      workerState: 'idle',
      system: {
        cpuPercent: 2,
        gpuPercent: 0,
        memoryUsedBytes: 1000,
        memoryTotalBytes: 2000,
        cpuCount: 4,
      },
      app: {
        cpuPercent: 0,
        gpuPercent: 0,
        memoryBytes: 500,
        processCount: 1,
      },
      processes: [{ pid: 10, name: 'worker.exe', type: 'Process', cpuPercent: 0, memoryBytes: 500 }],
      systemProcesses: [{ pid: 20, name: 'chrome.exe', type: 'Process', cpuPercent: 0, memoryBytes: 800 }],
    });

    await waitFor(() => sentSamples.length === 1);

    assert.equal(sentSamples[0]?.workerState, 'idle');
    assert.equal(sentSamples[0]?.stage, 'idle');
    assert.equal(sentSamples[0]?.systemTopProcesses[0]?.name, 'chrome.exe');
    service.close();
  });
});
