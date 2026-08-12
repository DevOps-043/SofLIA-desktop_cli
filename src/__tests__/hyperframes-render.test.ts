import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildHyperframesRenderArgs,
  resolveElectronRunAsNode,
  resolveFastCaptureOverride,
  shouldRetryHyperframesWithoutGpu,
} from '../hyperframes-render.js';

describe('HyperFrames render runner', () => {
  it('builds a strict bounded GPU render command', () => {
    const args = buildHyperframesRenderArgs({
      cliPath: 'hyperframes.mjs',
      projectDirectory: 'C:\\project',
      outputPath: 'C:\\output.mp4',
      quality: 'high',
      workers: 99,
      videoBitrate: '8M',
      browserGpu: true,
      gpuEncoding: true,
      framesCacheDirectory: 'C:\\cache',
    });

    assert.deepEqual(args.slice(0, 3), ['hyperframes.mjs', 'render', 'C:\\project']);
    assert.equal(args[args.indexOf('--workers') + 1], '8');
    assert.ok(args.includes('--gpu'));
    assert.ok(args.includes('--browser-gpu'));
    assert.ok(args.includes('--no-best-effort'));
  });

  it('retries only encoder-related GPU failures', () => {
    assert.equal(shouldRetryHyperframesWithoutGpu({
      code: 1,
      stdout: '',
      stderr: 'AMF encoder failed to initialize device',
    }), true);
    assert.equal(shouldRetryHyperframesWithoutGpu({
      code: 1,
      stdout: '',
      stderr: 'Composition script threw an exception',
    }), false);
  });

  it('enables verified fast capture on a GPU browser while preserving explicit overrides', () => {
    assert.equal(resolveFastCaptureOverride(undefined, true), 'true');
    assert.equal(resolveFastCaptureOverride(undefined, false), undefined);
    assert.equal(resolveFastCaptureOverride('false', true), 'false');
  });

  it('uses the packaged Electron executable as a Node runtime for child CLIs', () => {
    assert.equal(resolveElectronRunAsNode('43.1.0', undefined), '1');
    assert.equal(resolveElectronRunAsNode(undefined, undefined), undefined);
    assert.equal(resolveElectronRunAsNode(undefined, '0'), '0');
  });
});
