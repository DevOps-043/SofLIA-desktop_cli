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
});
