import type { WorkerChromiumGl, WorkerHardwareAcceleration, WorkerPowerProfile } from './worker-capacity.js';

export type WorkerTelemetryJobType = 'render' | 'template_build' | 'template_preview';

export type WorkerTelemetryRunStatus =
  | 'running'
  | 'completed'
  | 'upload_pending'
  | 'confirm_pending'
  | 'failed'
  | 'interrupted';

export type WorkerGpuAdapterSnapshot = {
  name: string;
  vendor?: string;
  memoryBytes?: number;
  driverVersion?: string;
  videoProcessor?: string;
};

export type WorkerHardwareSnapshot = {
  platform: NodeJS.Platform;
  arch: string;
  cpuModel?: string;
  cpuLogicalThreads: number;
  memoryTotalBytes: number;
  gpuAdapters: WorkerGpuAdapterSnapshot[];
};

export type WorkerTelemetryConfigSnapshot = {
  powerProfile?: WorkerPowerProfile;
  maxConcurrentJobs?: number;
  renderConcurrency?: number;
  hardwareAcceleration?: WorkerHardwareAcceleration;
  chromiumGl?: WorkerChromiumGl;
  videoBitrate?: string;
};

export type WorkerTelemetryRunSummary = {
  sampleCount: number;
  avgAppCpuPercent: number;
  maxAppCpuPercent: number;
  avgAppGpuPercent: number;
  maxAppGpuPercent: number;
  avgAppMemoryBytes: number;
  maxAppMemoryBytes: number;
  avgSystemCpuPercent: number;
  maxSystemCpuPercent: number;
  avgSystemGpuPercent: number;
  maxSystemGpuPercent: number;
  maxSystemMemoryUsedBytes: number;
};

export type WorkerTelemetryRunPayload = {
  localRunId: string;
  jobId: string;
  jobType: WorkerTelemetryJobType;
  buildId?: string;
  templateVersionId?: string;
  compositionId?: string;
  bundleHash?: string;
  propsHash?: string;
  outputStoragePath?: string;
  status: WorkerTelemetryRunStatus;
  startedAt: string;
  config: WorkerTelemetryConfigSnapshot;
  hardware: WorkerHardwareSnapshot;
};

export type WorkerTelemetryProcessSample = {
  pid: number;
  parentPid?: number;
  name: string;
  type: string;
  cpuPercent: number;
  memoryBytes: number;
};

export type WorkerTelemetrySamplePayload = {
  sampledAt: string;
  workerState: string;
  stage?: string;
  progressPercent?: number;
  appCpuPercent: number;
  appGpuPercent: number;
  appMemoryBytes: number;
  appProcessCount: number;
  systemCpuPercent: number;
  systemGpuPercent: number;
  systemMemoryUsedBytes: number;
  systemMemoryTotalBytes: number;
  systemCpuCount: number;
  topProcesses: WorkerTelemetryProcessSample[];
};

export type WorkerTelemetryFinishPayload = {
  localRunId: string;
  remoteRunId?: string;
  status: WorkerTelemetryRunStatus;
  finishedAt: string;
  elapsedMs: number;
  lastStage?: string;
  lastProgressPercent?: number;
  errorCode?: string;
  errorMessage?: string;
  summary: WorkerTelemetryRunSummary;
};
