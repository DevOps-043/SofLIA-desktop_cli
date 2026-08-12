import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertArtifactMatchesComposition,
  parseFfprobeInspection,
} from '../media-artifact-inspector.js';

describe('media artifact inspection', () => {
  it('reads encoder, dimensions, duration, fps and audio presence', () => {
    const result = parseFfprobeInspection(JSON.stringify({
      streams: [
        { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30/1', tags: { encoder: 'Lavc h264_amf' } },
        { codec_type: 'audio', codec_name: 'aac' },
      ],
      format: { duration: '170.23' },
    }));

    assert.equal(result.durationSeconds, 170.23);
    assert.equal(result.fps, 30);
    assert.equal(result.hasAudio, true);
    assert.equal(result.hardwareEncoded, true);
    assert.equal(result.encoder, 'Lavc h264_amf');
  });

  it('rejects outputs without a video stream', () => {
    assert.throws(
      () => parseFfprobeInspection(JSON.stringify({ streams: [{ codec_type: 'audio' }], format: { duration: 1 } })),
      /no contiene una pista de video/,
    );
  });

  it('rejects a truncated output while tolerating normal muxing drift', () => {
    const artifact = {
      durationSeconds: 160,
      width: 1920,
      height: 1080,
      videoCodec: 'h264',
      hasAudio: false,
      hardwareEncoded: false,
    };
    assert.throws(() => assertArtifactMatchesComposition({
      artifact,
      expectedDurationSeconds: 170,
      expectedWidth: 1920,
      expectedHeight: 1080,
    }), /duracion/);

    assert.doesNotThrow(() => assertArtifactMatchesComposition({
      artifact: { ...artifact, durationSeconds: 169.9 },
      expectedDurationSeconds: 170,
      expectedWidth: 1920,
      expectedHeight: 1080,
    }));
  });
});
