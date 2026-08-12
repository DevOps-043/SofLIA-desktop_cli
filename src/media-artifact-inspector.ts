import { execFile } from 'node:child_process';
import { getRemotionFfprobePath } from './remotion-binaries.js';

export type MediaArtifactInspection = {
  durationSeconds: number;
  width: number;
  height: number;
  fps?: number;
  videoCodec: string;
  encoder?: string;
  hasAudio: boolean;
  hardwareEncoded: boolean;
};

type RunProbe = (binary: string, args: string[]) => Promise<string>;

const HARDWARE_ENCODER_PATTERN = /(?:nvenc|amf|qsv|videotoolbox|vaapi)/i;

const runProbe: RunProbe = (binary, args) => new Promise((resolve, reject) => {
  execFile(
    binary,
    args,
    { timeout: 10_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`OUTPUT_VALIDATION_FAILED: ffprobe no pudo leer el artefacto: ${String(stderr || error.message).trim().slice(0, 300)}`));
        return;
      }
      resolve(String(stdout || ''));
    },
  );
});

function finitePositive(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseFps(value: unknown): number | undefined {
  if (typeof value !== 'string') return finitePositive(value);
  const [numerator, denominator] = value.split('/').map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return undefined;
  return finitePositive(numerator / denominator);
}

export function parseFfprobeInspection(raw: string): MediaArtifactInspection {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error('OUTPUT_VALIDATION_FAILED: ffprobe devolvio JSON invalido.');
  }

  const streams = Array.isArray(parsed.streams)
    ? parsed.streams.filter((stream): stream is Record<string, unknown> => Boolean(stream && typeof stream === 'object'))
    : [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  const format = parsed.format && typeof parsed.format === 'object'
    ? parsed.format as Record<string, unknown>
    : {};
  if (!video) throw new Error('OUTPUT_VALIDATION_FAILED: el MP4 no contiene una pista de video.');

  const durationSeconds = finitePositive(format.duration) || finitePositive(video.duration);
  const width = finitePositive(video.width);
  const height = finitePositive(video.height);
  if (!durationSeconds || !width || !height) {
    throw new Error('OUTPUT_VALIDATION_FAILED: duracion o dimensiones invalidas en el MP4.');
  }

  const streamTags = video.tags && typeof video.tags === 'object' ? video.tags as Record<string, unknown> : {};
  const formatTags = format.tags && typeof format.tags === 'object' ? format.tags as Record<string, unknown> : {};
  const encoder = String(streamTags.encoder || formatTags.encoder || '').trim() || undefined;
  return {
    durationSeconds,
    width,
    height,
    fps: parseFps(video.avg_frame_rate),
    videoCodec: String(video.codec_name || 'unknown'),
    encoder,
    hasAudio: Boolean(audio),
    hardwareEncoded: HARDWARE_ENCODER_PATTERN.test(encoder || ''),
  };
}

export async function inspectMediaArtifact(
  filePath: string,
  options: { ffprobePath?: string; run?: RunProbe } = {},
): Promise<MediaArtifactInspection> {
  const ffprobePath = options.ffprobePath || getRemotionFfprobePath() || 'ffprobe';
  const output = await (options.run || runProbe)(ffprobePath, [
    '-v', 'error',
    '-show_entries', 'format=duration:format_tags=encoder:stream=codec_type,codec_name,width,height,duration,avg_frame_rate:stream_tags=encoder',
    '-of', 'json',
    filePath,
  ]);
  return parseFfprobeInspection(output);
}

export function assertArtifactMatchesComposition(input: {
  artifact: MediaArtifactInspection;
  expectedDurationSeconds: number;
  expectedWidth: number;
  expectedHeight: number;
}): void {
  const durationTolerance = Math.max(1.5, input.expectedDurationSeconds * 0.03);
  const durationDelta = Math.abs(input.artifact.durationSeconds - input.expectedDurationSeconds);
  if (durationDelta > durationTolerance) {
    throw new Error(
      `OUTPUT_VALIDATION_FAILED: duracion ${input.artifact.durationSeconds.toFixed(2)}s; se esperaban ${input.expectedDurationSeconds.toFixed(2)}s.`,
    );
  }
  if (input.artifact.width !== input.expectedWidth || input.artifact.height !== input.expectedHeight) {
    throw new Error(
      `OUTPUT_VALIDATION_FAILED: resolucion ${input.artifact.width}x${input.artifact.height}; se esperaba ${input.expectedWidth}x${input.expectedHeight}.`,
    );
  }
}
