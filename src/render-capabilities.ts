import { execFile } from 'node:child_process';
import { getRemotionFfmpegPath } from './remotion-binaries.js';
import type { WorkerHardwareAcceleration } from './shared/worker-capacity.js';
import type {
  FfmpegCapability,
  HardwareVideoEncoder,
  WorkerRenderCapabilities,
} from './shared/render-capabilities.js';

type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
};

type RunCommand = (binary: string, args: string[], timeoutMs: number) => Promise<CommandResult>;

const HARDWARE_ENCODERS: HardwareVideoEncoder[] = [
  'h264_nvenc',
  'h264_amf',
  'h264_qsv',
  'h264_videotoolbox',
  'h264_vaapi',
];

let cachedCapabilities: Promise<WorkerRenderCapabilities> | null = null;

function sanitizeError(value: unknown): string {
  return String(value || 'FFmpeg no disponible').replace(/\s+/g, ' ').trim().slice(0, 300);
}

const runCommand: RunCommand = (binary, args, timeoutMs) => new Promise((resolve) => {
  execFile(
    binary,
    args,
    { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout || ''),
        stderr: String(stderr || error?.message || ''),
      });
    },
  );
});

export function parseH264Encoders(output: string): string[] {
  const encoders = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*[A-Z\.]{6}\s+([\w-]+)\s/.exec(line);
    if (match?.[1]?.toLowerCase().includes('264')) encoders.add(match[1]);
  }
  return [...encoders].sort();
}

export function getRemotionSupportedHardwareEncoders(platform: NodeJS.Platform): HardwareVideoEncoder[] {
  if (platform === 'darwin') return ['h264_videotoolbox'];
  if (platform === 'win32' || platform === 'linux') return ['h264_nvenc'];
  return [];
}

function preferredSystemEncoders(platform: NodeJS.Platform): HardwareVideoEncoder[] {
  if (platform === 'win32') return ['h264_nvenc', 'h264_amf', 'h264_qsv'];
  if (platform === 'darwin') return ['h264_videotoolbox'];
  if (platform === 'linux') return ['h264_nvenc', 'h264_vaapi', 'h264_qsv'];
  return HARDWARE_ENCODERS;
}

async function inspectFfmpeg(input: {
  binary: string;
  supportedHardwareEncoders: HardwareVideoEncoder[];
  verifyHardware: boolean;
  run: RunCommand;
}): Promise<FfmpegCapability> {
  const listed = await input.run(input.binary, ['-hide_banner', '-encoders'], 5_000);
  if (!listed.ok) {
    return {
      available: false,
      binary: input.binary,
      h264Encoders: [],
      hardwareEncoders: [],
      error: sanitizeError(listed.stderr),
    };
  }

  const h264Encoders = parseH264Encoders(`${listed.stdout}\n${listed.stderr}`);
  const hardwareEncoders = input.supportedHardwareEncoders.filter((encoder) => h264Encoders.includes(encoder));
  let verifiedHardwareEncoder: HardwareVideoEncoder | undefined;

  if (input.verifyHardware) {
    for (const encoder of hardwareEncoders) {
      const probe = await input.run(input.binary, [
        '-hide_banner',
        '-loglevel', 'error',
        '-f', 'lavfi',
        '-i', 'color=c=black:s=64x64:r=1:d=0.1',
        '-frames:v', '1',
        '-an',
        '-c:v', encoder,
        '-f', 'null',
        '-',
      ], 8_000);
      if (probe.ok) {
        verifiedHardwareEncoder = encoder;
        break;
      }
    }
  } else {
    verifiedHardwareEncoder = hardwareEncoders[0];
  }

  return {
    available: true,
    binary: input.binary,
    h264Encoders,
    hardwareEncoders,
    verifiedHardwareEncoder,
  };
}

export async function inspectWorkerRenderCapabilities(options: {
  platform?: NodeJS.Platform;
  systemFfmpegPath?: string;
  remotionFfmpegPath?: string | null;
  run?: RunCommand;
} = {}): Promise<WorkerRenderCapabilities> {
  const platform = options.platform || process.platform;
  const runner = options.run || runCommand;
  const remotionBinary = options.remotionFfmpegPath === undefined
    ? getRemotionFfmpegPath()
    : options.remotionFfmpegPath;
  const systemBinary = options.systemFfmpegPath || process.env.SOFLIA_FFMPEG_PATH?.trim() || 'ffmpeg';

  const [remotion, hyperframes] = await Promise.all([
    remotionBinary
      ? inspectFfmpeg({
          binary: remotionBinary,
          supportedHardwareEncoders: getRemotionSupportedHardwareEncoders(platform),
          verifyHardware: true,
          run: runner,
        })
      : Promise.resolve<FfmpegCapability>({
          available: false,
          binary: '',
          h264Encoders: [],
          hardwareEncoders: [],
          error: 'Binarios de Remotion no disponibles para esta plataforma.',
        }),
    inspectFfmpeg({
      binary: systemBinary,
      supportedHardwareEncoders: preferredSystemEncoders(platform),
      verifyHardware: true,
      run: runner,
    }),
  ]);

  return {
    remotion: {
      ...remotion,
      hardwareEncodingAvailable: Boolean(remotion.verifiedHardwareEncoder),
    },
    hyperframes: {
      ...hyperframes,
      hardwareEncodingAvailable: Boolean(hyperframes.verifiedHardwareEncoder),
    },
  };
}

export function readWorkerRenderCapabilities(forceRefresh = false): Promise<WorkerRenderCapabilities> {
  if (forceRefresh || !cachedCapabilities) {
    cachedCapabilities = inspectWorkerRenderCapabilities();
  }
  return cachedCapabilities;
}

export function resolveEffectiveHardwareAcceleration(
  requested: WorkerHardwareAcceleration,
  hardwareEncodingAvailable: boolean,
): WorkerHardwareAcceleration {
  if (requested === 'disable') return 'disable';
  if (!hardwareEncodingAvailable) return 'disable';
  return requested;
}
