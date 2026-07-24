import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildProcessTree, calculateCpuPercent, ResourceMonitor } from '../resource-monitor.js';
import type { RawGpuEngineRow, RawProcessRow } from '../resource-monitor.js';

describe('resource-monitor', () => {
  it('calculates CPU percent from process time deltas', () => {
    assert.equal(
      calculateCpuPercent(
        { cpuTimeMs: 1000, sampledAt: 1000 },
        { cpuTimeMs: 1500, sampledAt: 2000 },
        2,
      ),
      25,
    );
  });

  it('builds a descendant process tree from root pid', () => {
    const rows: RawProcessRow[] = [
      { pid: 1, name: 'system' },
      { pid: 10, parentPid: 1, name: 'soflia.exe' },
      { pid: 11, parentPid: 10, name: 'chrome.exe' },
      { pid: 12, parentPid: 11, name: 'ffmpeg.exe' },
      { pid: 20, parentPid: 1, name: 'other.exe' },
    ];

    assert.deepEqual(buildProcessTree(rows, 10).map((row) => row.pid), [10, 11, 12]);
  });

  it('summarizes process tree CPU and memory across samples', async () => {
    let now = 1000;
    let rows: RawProcessRow[] = [
      { pid: 10, name: 'soflia.exe', workingSetBytes: 100, cpuTimeMs: 1000 },
      { pid: 11, parentPid: 10, name: 'chrome.exe', workingSetBytes: 200, cpuTimeMs: 500 },
    ];
    const monitor = new ResourceMonitor({
      platform: 'win32',
      rootPid: 10,
      cpuCount: 2,
      now: () => now,
      getCpuTimes: () => ({ idleMs: now, totalMs: now * 2 }),
      getMemoryInfo: () => ({ totalBytes: 1000, freeBytes: 250 }),
      getProcessRows: async () => rows,
      getGpuEngineRows: async () => [],
    });

    await monitor.sample({ workerState: 'idle' });
    now = 2000;
    rows = [
      { pid: 10, name: 'soflia.exe', workingSetBytes: 150, cpuTimeMs: 2000 },
      { pid: 11, parentPid: 10, name: 'chrome.exe', workingSetBytes: 250, cpuTimeMs: 700 },
    ];
    const snapshot = await monitor.sample({ workerState: 'rendering', activeJob: { jobId: 'job-1', percent: 40 } });

    assert.equal(snapshot.app.cpuPercent, 60);
    assert.equal(snapshot.app.memoryBytes, 400);
    assert.equal(snapshot.app.processCount, 2);
    assert.equal(snapshot.activeJob?.jobId, 'job-1');
    assert.equal(snapshot.system.memoryUsedBytes, 750);
  });

  it('summarizes GPU usage for the whole system and SofLIA process tree', async () => {
    const rows: RawProcessRow[] = [
      { pid: 10, name: 'soflia.exe', workingSetBytes: 100, cpuTimeMs: 1000 },
      { pid: 11, parentPid: 10, name: 'chrome.exe', workingSetBytes: 200, cpuTimeMs: 500 },
    ];
    const gpuRows: RawGpuEngineRow[] = [
      { pid: 10, instanceName: 'pid_10_luid_0x000_engtype_3D', utilizationPercent: 3 },
      { pid: 11, instanceName: 'pid_11_luid_0x000_engtype_VideoEncode', utilizationPercent: 8 },
      { pid: 44, instanceName: 'pid_44_luid_0x000_engtype_3D', utilizationPercent: 21 },
    ];
    const monitor = new ResourceMonitor({
      platform: 'win32',
      rootPid: 10,
      cpuCount: 2,
      now: () => 1000,
      getCpuTimes: () => ({ idleMs: 100, totalMs: 200 }),
      getMemoryInfo: () => ({ totalBytes: 1000, freeBytes: 250 }),
      getProcessRows: async () => rows,
      getGpuEngineRows: async () => gpuRows,
    });

    const snapshot = await monitor.sample({ workerState: 'rendering' });

    assert.equal(snapshot.app.gpuPercent, 11);
    assert.equal(snapshot.system.gpuPercent, 32);
    assert.equal(snapshot.app.gpuUnavailableReason, undefined);
  });

  it('falls back cleanly when process tree sampling is unavailable', async () => {
    const monitor = new ResourceMonitor({
      platform: 'linux',
      cpuCount: 4,
      now: () => 1000,
      getCpuTimes: () => ({ idleMs: 100, totalMs: 200 }),
      getMemoryInfo: () => ({ totalBytes: 1000, freeBytes: 500 }),
    });

    const snapshot = await monitor.sample({ workerState: 'stopped' });

    assert.equal(snapshot.app.cpuPercent, 0);
    assert.equal(snapshot.app.gpuPercent, 0);
    assert.equal(snapshot.app.memoryBytes, 0);
    assert.equal(snapshot.app.processCount, 0);
    assert.match(snapshot.app.unavailableReason || '', /Windows/);
    assert.match(snapshot.app.gpuUnavailableReason || '', /GPU/);
  });

  it('clamps invalid and oversized percentages', async () => {
    const monitor = new ResourceMonitor({
      platform: 'linux',
      cpuCount: 1,
      now: () => 1000,
      getCpuTimes: () => ({ idleMs: 0, totalMs: 0 }),
      getMemoryInfo: () => ({ totalBytes: 1000, freeBytes: 900 }),
      getElectronAppMetrics: () => [{
        pid: 10,
        type: 'Browser',
        cpu: { percentCPUUsage: 250 },
        memory: { workingSetSize: 2 },
      }],
    });

    const snapshot = await monitor.sample({ workerState: 'idle' });

    assert.equal(snapshot.app.cpuPercent, 100);
    assert.equal(snapshot.processes[0]?.cpuPercent, 100);
    assert.equal(snapshot.processes[0]?.memoryBytes, 2048);
  });
});
