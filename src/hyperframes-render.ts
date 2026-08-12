import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { inspectMediaArtifact } from './media-artifact-inspector.js';
import { getWorkspaceDir } from './paths.js';
import type { WorkerRenderCapabilities } from './shared/render-capabilities.js';

const require = createRequire(import.meta.url);
const MAX_COMMAND_OUTPUT_CHARS = 2_000_000;

export type HyperframesQuality = 'draft' | 'standard' | 'high';

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type CommandRunner = (input: {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onOutput?: (line: string) => void;
}) => Promise<CommandResult>;

export type HyperframesRenderOptions = {
  projectDirectory: string;
  outputPath: string;
  quality?: HyperframesQuality;
  workers: number;
  videoBitrate?: string;
  browserGpu?: boolean;
  gpuEncoding?: boolean;
  capabilities: WorkerRenderCapabilities;
  run?: CommandRunner;
  onOutput?: (line: string) => void;
};

function appendBounded(current: string, chunk: string) {
  const next = current + chunk;
  return next.length <= MAX_COMMAND_OUTPUT_CHARS
    ? next
    : next.slice(next.length - MAX_COMMAND_OUTPUT_CHARS);
}

const runCommand: CommandRunner = ({ executable, args, cwd, env, onOutput }) => new Promise((resolve, reject) => {
  const child = spawn(executable, args, {
    cwd,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    const value = chunk.toString();
    stdout = appendBounded(stdout, value);
    onOutput?.(value);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    const value = chunk.toString();
    stderr = appendBounded(stderr, value);
    onOutput?.(value);
  });
  child.once('error', reject);
  child.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
});

function getHyperframesCliPath(): string {
  return path.join(
    path.dirname(require.resolve('hyperframes/package.json')),
    'bin',
    'hyperframes.mjs',
  );
}

function normalizeWorkers(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(8, Math.floor(value)));
}

export function buildHyperframesRenderArgs(input: {
  cliPath: string;
  projectDirectory: string;
  outputPath: string;
  quality: HyperframesQuality;
  workers: number;
  videoBitrate?: string;
  browserGpu: boolean;
  gpuEncoding: boolean;
  framesCacheDirectory: string;
}): string[] {
  return [
    input.cliPath,
    'render',
    input.projectDirectory,
    '--output', input.outputPath,
    '--quality', input.quality,
    '--workers', String(normalizeWorkers(input.workers)),
    '--strict',
    '--no-best-effort',
    '--page-side-compositing',
    '--frames-cache-dir', input.framesCacheDirectory,
    ...(input.videoBitrate ? ['--video-bitrate', input.videoBitrate] : []),
    ...(input.browserGpu ? ['--browser-gpu'] : ['--no-browser-gpu']),
    ...(input.gpuEncoding ? ['--gpu'] : []),
  ];
}

export function shouldRetryHyperframesWithoutGpu(result: CommandResult): boolean {
  if (result.code === 0) return false;
  const output = `${result.stdout}\n${result.stderr}`;
  return /(?:amf|nvenc|qsv|videotoolbox|vaapi|gpu|hardware encoder|device creation|encoder.*(?:failed|unavailable)|failed.*encoder)/i.test(output);
}

export function resolveFastCaptureOverride(
  configuredValue: string | undefined,
  browserGpu: boolean,
): string | undefined {
  if (configuredValue !== undefined) return configuredValue;
  return browserGpu ? 'true' : undefined;
}

export function resolveElectronRunAsNode(
  electronVersion: string | undefined,
  configuredValue: string | undefined,
): string | undefined {
  return electronVersion ? '1' : configuredValue;
}

function failureDetail(result: CommandResult): string {
  const detail = `${result.stderr}\n${result.stdout}`.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+/g, ' ').trim();
  return detail.slice(-1_500) || `exit ${result.code}`;
}

async function validatePaths(projectDirectory: string, outputPath: string) {
  const project = await fsp.realpath(path.resolve(projectDirectory));
  const projectStat = await fsp.stat(project);
  if (!projectStat.isDirectory()) throw new Error('HYPERFRAMES_PROJECT_INVALID: el proyecto debe ser una carpeta.');
  await fsp.access(path.join(project, 'index.html'));

  const output = path.resolve(outputPath);
  if (path.extname(output).toLowerCase() !== '.mp4') {
    throw new Error('HYPERFRAMES_OUTPUT_INVALID: el output debe terminar en .mp4.');
  }
  await fsp.mkdir(path.dirname(output), { recursive: true });
  return { project, output };
}

export async function renderHyperframesProject(options: HyperframesRenderOptions) {
  const startedAtMs = Date.now();
  const { project, output } = await validatePaths(options.projectDirectory, options.outputPath);
  const cliPath = getHyperframesCliPath();
  const runner = options.run || runCommand;
  const browserGpu = options.browserGpu !== false;
  const framesCacheDirectory = path.join(getWorkspaceDir(), 'hyperframes-frame-cache');
  await fsp.mkdir(framesCacheDirectory, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // In the packaged desktop app process.execPath is the Electron executable.
    // ELECTRON_RUN_AS_NODE makes that executable a reliable bundled Node runtime
    // for the HyperFrames CLI instead of opening a second app window.
    ELECTRON_RUN_AS_NODE: resolveElectronRunAsNode(
      process.versions.electron,
      process.env.ELECTRON_RUN_AS_NODE,
    ),
    // HyperFrames expects this override to be an existing file path. When the
    // capability probe used a PATH command such as `ffmpeg`, leaving the
    // variable unset lets HyperFrames resolve it correctly on every platform.
    HYPERFRAMES_FFMPEG_PATH: path.isAbsolute(options.capabilities.hyperframes.binary)
      ? options.capabilities.hyperframes.binary
      : undefined,
    HYPERFRAMES_EXTRACT_CACHE_DIR: framesCacheDirectory,
    // On Windows this opt-in enables drawElement capture with built-in PSNR
    // self-verification. It halved capture time on the target RX 580 while
    // preserving HyperFrames' automatic per-frame screenshot fallback.
    PRODUCER_EXPERIMENTAL_FAST_CAPTURE: resolveFastCaptureOverride(
      process.env.PRODUCER_EXPERIMENTAL_FAST_CAPTURE,
      browserGpu,
    ),
  };

  const checkResult = await runner({
    executable: process.execPath,
    args: [
      cliPath,
      'check',
      project,
      '--json',
      '--samples', '9',
      '--at-transitions',
      ...(browserGpu ? ['--browser-gpu'] : ['--no-browser-gpu']),
    ],
    cwd: project,
    env,
    onOutput: options.onOutput,
  });
  if (checkResult.code !== 0) {
    throw new Error(`HYPERFRAMES_PREFLIGHT_FAILED: ${failureDetail(checkResult)}`);
  }

  const gpuEncoding = options.gpuEncoding !== false && options.capabilities.hyperframes.hardwareEncodingAvailable;
  const renderAttempt = (useGpu: boolean) => runner({
    executable: process.execPath,
    args: buildHyperframesRenderArgs({
      cliPath,
      projectDirectory: project,
      outputPath: output,
      quality: options.quality || 'standard',
      workers: options.workers,
      videoBitrate: options.videoBitrate,
      browserGpu,
      gpuEncoding: useGpu,
      framesCacheDirectory,
    }),
    cwd: project,
    env,
    onOutput: options.onOutput,
  });

  let result = await renderAttempt(gpuEncoding);
  let fellBackToCpu = false;
  if (gpuEncoding && shouldRetryHyperframesWithoutGpu(result)) {
    fellBackToCpu = true;
    await fsp.rm(output, { force: true });
    options.onOutput?.('Encoder GPU no disponible durante el render; reintentando con CPU.\n');
    result = await renderAttempt(false);
  }
  if (result.code !== 0) {
    throw new Error(`HYPERFRAMES_RENDER_FAILED: ${failureDetail(result)}`);
  }

  await fsp.access(output);
  const artifact = await inspectMediaArtifact(output);
  const stat = await fsp.stat(output);
  return {
    outputPath: output,
    artifactSizeBytes: stat.size,
    elapsedMs: Date.now() - startedAtMs,
    requestedGpuEncoding: gpuEncoding,
    fellBackToCpu,
    artifact,
  };
}
