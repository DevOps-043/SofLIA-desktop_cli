import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ClaimedRenderJob, SofliaWorkerApiClient } from '../api-client.js';
import { RenderProgressReporter } from '../render-progress-reporter.js';

const JOB = {
  jobId: 'job-progress-order',
  compositionId: 'full-slides',
} as ClaimedRenderJob;

describe('RenderProgressReporter', () => {
  it('serializes callback-driven progress updates and forwards safe detail', async () => {
    const remotePercents: number[] = [];
    const localPercents: number[] = [];
    const details: Array<Record<string, unknown> | undefined> = [];
    let releaseFirst: (() => void) | undefined;
    const firstProgressGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const client = {
      progress: async (
        _jobId: string,
        percent: number,
        _message: string,
        _stage: string,
        detail?: Record<string, unknown>,
      ) => {
        remotePercents.push(percent);
        details.push(detail);
        if (percent === 10) await firstProgressGate;
        return {};
      },
    } as unknown as SofliaWorkerApiClient;
    const reporter = new RenderProgressReporter(client, JOB, (event) => {
      localPercents.push(event.percent || 0);
    });

    reporter.schedule(10, 'Primero', 'asset_prepare', { assetKey: 'voiceAudioUrl' });
    reporter.schedule(20, 'Segundo', 'asset_prepare');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(remotePercents, [10]);

    releaseFirst?.();
    await reporter.report(30, 'Tercero', 'render_start');

    assert.deepEqual(remotePercents, [10, 20, 30]);
    assert.deepEqual(localPercents, [10, 20, 30]);
    assert.deepEqual(details[0], { assetKey: 'voiceAudioUrl' });
  });

  it('renews the current render stage while Remotion has no progress callback', async () => {
    const reports: Array<{ percent: number; detail?: Record<string, unknown> }> = [];
    const client = {
      progress: async (
        _jobId: string,
        percent: number,
        _message: string,
        _stage: string,
        detail?: Record<string, unknown>,
      ) => {
        reports.push({ percent, detail });
        return {};
      },
    } as unknown as SofliaWorkerApiClient;
    const reporter = new RenderProgressReporter(client, JOB);

    await reporter.report(31, 'Renderizando fotogramas', 'render_frames');
    const stopKeepAlive = reporter.startKeepAlive(10);
    await new Promise((resolve) => setTimeout(resolve, 35));
    stopKeepAlive();
    await reporter.report(32, 'Render reanudado', 'render_frames');

    assert.ok(reports.some((report) => report.percent === 31 && report.detail?.keepAlive === true));
    assert.equal(reports.at(-1)?.percent, 32);
  });
});
