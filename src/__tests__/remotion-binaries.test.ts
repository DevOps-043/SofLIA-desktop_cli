import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  getEsbuildBinaryPath,
  getRemotionBinariesDirectory,
  getRemotionFfmpegPath,
  getRemotionFfprobePath,
} from '../remotion-binaries.js';

describe('native binary resolution', () => {
  it('resolves unpacked native binaries in development as well as packaged builds', async () => {
    const binariesDirectory = getRemotionBinariesDirectory();
    const ffmpegPath = getRemotionFfmpegPath();
    const ffprobePath = getRemotionFfprobePath();
    const esbuildPath = getEsbuildBinaryPath();

    assert.ok(binariesDirectory);
    assert.ok(ffmpegPath);
    assert.ok(ffprobePath);
    assert.ok(esbuildPath);
    await Promise.all([ffmpegPath, ffprobePath, esbuildPath].map((binaryPath) => fsp.access(binaryPath!)));
  });
});
