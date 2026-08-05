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
});
