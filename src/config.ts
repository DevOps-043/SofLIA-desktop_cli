import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { getConfigPath } from './paths.js';
import { normalizeLocalRetentionPolicy } from './local-job-state.js';
import type { LocalCleanupPolicy } from './local-job-state.js';
import { DEFAULT_WORKER_POWER_PROFILE, resolveRemotionCacheBudget, resolveWorkerPowerProfile } from './shared/worker-capacity.js';
import type { WorkerChromiumGl, WorkerHardwareAcceleration, WorkerPowerProfile } from './shared/worker-capacity.js';
import { readWorkerRenderCapabilities, resolveEffectiveHardwareAcceleration } from './render-capabilities.js';
import type { WorkerRenderCapabilities } from './shared/render-capabilities.js';

export interface WorkerConfig {
  apiUrl: string;
  token: string;
  closeToTray?: boolean;
  powerProfile?: WorkerPowerProfile;
  maxConcurrentJobs?: number;
  maxParallelPreviews?: number;
  renderConcurrency?: number;
  hardwareAcceleration?: WorkerHardwareAcceleration;
  chromiumGl?: WorkerChromiumGl;
  videoBitrate?: string;
  renderCapabilities?: WorkerRenderCapabilities;
  mediaCacheSizeInBytes?: number;
  offthreadVideoCacheSizeInBytes?: number;
  offthreadVideoThreads?: number;
  localRetentionPolicy?: LocalCleanupPolicy;
}

export async function loadOptionalConfig(): Promise<Partial<WorkerConfig>> {
  try {
    const raw = await fsp.readFile(getConfigPath(), 'utf8');
    return JSON.parse(raw) as Partial<WorkerConfig>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export async function saveConfig(config: WorkerConfig): Promise<void> {
  const configPath = getConfigPath();
  const current = await loadOptionalConfig();
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  await fsp.writeFile(configPath, `${JSON.stringify({ ...current, ...config }, null, 2)}\n`, { mode: 0o600 });
}

export async function saveConfigSettings(settings: Partial<Pick<WorkerConfig, 'apiUrl' | 'closeToTray' | 'powerProfile' | 'localRetentionPolicy'>>): Promise<void> {
  const configPath = getConfigPath();
  const current = await loadOptionalConfig();
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  await fsp.writeFile(configPath, `${JSON.stringify({ ...current, ...settings }, null, 2)}\n`, { mode: 0o600 });
}

export async function clearWorkerLink(): Promise<void> {
  const configPath = getConfigPath();
  const current = await loadOptionalConfig();
  const { token: _token, ...settings } = current;
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  await fsp.writeFile(configPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}

export async function loadConfig(): Promise<WorkerConfig> {
  const parsed = await loadOptionalConfig();
  if (!parsed.apiUrl || !parsed.token) {
    throw new Error('Config incompleta. Vincula este equipo desde la app o ejecuta link con un codigo temporal.');
  }
  const powerProfile = await getEffectiveRuntimeWorkerPowerProfile(parsed.powerProfile);
  const renderCapabilities = powerProfile.renderCapabilities;
  const cacheBudget = resolveRemotionCacheBudget({
    memoryTotalBytes: os.totalmem(),
    renderConcurrency: powerProfile.renderConcurrency,
  });

  return {
    apiUrl: parsed.apiUrl.replace(/\/+$/, ''),
    token: parsed.token,
    closeToTray: parsed.closeToTray !== false,
    powerProfile: powerProfile.id,
    maxConcurrentJobs: powerProfile.maxConcurrentJobs,
    maxParallelPreviews: powerProfile.maxParallelPreviews,
    renderConcurrency: powerProfile.renderConcurrency,
    hardwareAcceleration: powerProfile.hardwareAcceleration,
    chromiumGl: powerProfile.chromiumGl,
    videoBitrate: powerProfile.videoBitrate,
    renderCapabilities,
    ...cacheBudget,
    localRetentionPolicy: normalizeLocalRetentionPolicy(parsed.localRetentionPolicy),
  };
}

export function getRuntimeWorkerPowerProfile(profile?: string) {
  const availableParallelism = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length;
  return resolveWorkerPowerProfile(profile || DEFAULT_WORKER_POWER_PROFILE, {
    cpuLogicalThreads: Math.max(1, availableParallelism || 1),
    memoryTotalBytes: Math.max(0, os.totalmem()),
  });
}

export async function getEffectiveRuntimeWorkerPowerProfile(profile?: string) {
  const powerProfile = getRuntimeWorkerPowerProfile(profile);
  const renderCapabilities = await readWorkerRenderCapabilities();
  return {
    ...powerProfile,
    hardwareAcceleration: resolveEffectiveHardwareAcceleration(
      powerProfile.hardwareAcceleration,
      renderCapabilities.remotion.hardwareEncodingAvailable,
    ),
    renderCapabilities,
  };
}
