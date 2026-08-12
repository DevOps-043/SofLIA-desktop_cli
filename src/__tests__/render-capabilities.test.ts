import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  inspectWorkerRenderCapabilities,
  parseH264Encoders,
  resolveEffectiveHardwareAcceleration,
} from '../render-capabilities.js';

describe('render capabilities', () => {
  it('parses software and hardware H.264 encoders from FFmpeg output', () => {
    const encoders = parseH264Encoders([
      ' V....D libx264               libx264 H.264',
      ' V....D h264_amf              AMD AMF H.264 Encoder',
      ' V....D h264_nvenc            NVIDIA NVENC H.264 encoder',
      ' A....D aac                   AAC',
    ].join('\n'));

    assert.deepEqual(encoders, ['h264_amf', 'h264_nvenc', 'libx264']);
  });

  it('does not advertise AMD AMF as Remotion hardware encoding on Windows', async () => {
    const capabilities = await inspectWorkerRenderCapabilities({
      platform: 'win32',
      remotionFfmpegPath: 'remotion-ffmpeg',
      systemFfmpegPath: 'system-ffmpeg',
      run: async (binary, args) => {
        if (args.includes('-encoders')) {
          return {
            ok: true,
            stdout: binary === 'remotion-ffmpeg'
              ? ' V....D libx264               libx264 H.264'
              : ' V....D libx264               libx264 H.264\n V....D h264_amf              AMD AMF H.264 Encoder',
            stderr: '',
          };
        }
        return { ok: args.includes('h264_amf'), stdout: '', stderr: '' };
      },
    });

    assert.equal(capabilities.remotion.hardwareEncodingAvailable, false);
    assert.equal(capabilities.hyperframes.verifiedHardwareEncoder, 'h264_amf');
    assert.equal(capabilities.hyperframes.hardwareEncodingAvailable, true);
  });

  it('disables a requested encoder when the active engine cannot provide one', () => {
    assert.equal(resolveEffectiveHardwareAcceleration('if-possible', false), 'disable');
    assert.equal(resolveEffectiveHardwareAcceleration('required', true), 'required');
  });
});

