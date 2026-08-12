import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  divideRemotionCacheBudget,
  resolvePreviewExecutionPlan,
  resolveRemotionCacheBudget,
  resolveWorkerPowerProfile,
} from '../shared/worker-capacity.js';

const GIB = 1024 * 1024 * 1024;

describe('worker power profile capacity', () => {
  it('scales a max profile on a workstation without exceeding available CPU', () => {
    const profile = resolveWorkerPowerProfile('max', {
      cpuLogicalThreads: 32,
      memoryTotalBytes: 64 * GIB,
    });

    assert.equal(profile.renderConcurrency, 12);
  });

  it('uses eight render slots on a Ryzen 5 class 12-thread machine in max mode', () => {
    const profile = resolveWorkerPowerProfile('max', {
      cpuLogicalThreads: 12,
      memoryTotalBytes: 32 * GIB,
    });

    assert.equal(profile.renderConcurrency, 8);
    assert.equal(profile.maxParallelPreviews, 3);
  });

  it('shares one global render budget across parallel previews', () => {
    assert.deepEqual(resolvePreviewExecutionPlan({
      jobCount: 8,
      renderConcurrency: 8,
      maxParallelPreviews: 3,
    }), {
      parallelJobs: 3,
      renderConcurrencyPerJob: 2,
      totalRenderSlots: 8,
    });
  });

  it('bounds and divides the media cache for parallel jobs', () => {
    const budget = resolveRemotionCacheBudget({
      memoryTotalBytes: 32 * GIB,
      renderConcurrency: 8,
    });
    const divided = divideRemotionCacheBudget(budget, 3);

    assert.ok(budget.mediaCacheSizeInBytes <= 2 * GIB);
    assert.ok(divided.mediaCacheSizeInBytes < budget.mediaCacheSizeInBytes);
    assert.equal(budget.offthreadVideoThreads, 4);
    assert.equal(divided.offthreadVideoThreads, 1);
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
