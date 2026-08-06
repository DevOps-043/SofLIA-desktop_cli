import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveWorkerPowerProfile } from '../shared/worker-capacity.js';

const GIB = 1024 * 1024 * 1024;

describe('worker power profile capacity', () => {
  it('scales a max profile on a workstation without exceeding available CPU', () => {
    const profile = resolveWorkerPowerProfile('max', {
      cpuLogicalThreads: 32,
      memoryTotalBytes: 64 * GIB,
    });

    assert.equal(profile.renderConcurrency, 28);
  });

  it('reduces max concurrency when a smaller PC would otherwise oversubscribe memory', () => {
    const profile = resolveWorkerPowerProfile('max', {
      cpuLogicalThreads: 4,
      memoryTotalBytes: 8 * GIB,
    });

    assert.equal(profile.renderConcurrency, 3);
  });

  it('keeps the light profile at one renderer on every machine', () => {
    const profile = resolveWorkerPowerProfile('light', {
      cpuLogicalThreads: 64,
      memoryTotalBytes: 128 * GIB,
    });

    assert.equal(profile.renderConcurrency, 1);
  });
});
