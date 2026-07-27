import { randomUUID } from 'node:crypto';
import { SofliaWorkerApiClient } from './api-client.js';
import { loadConfig, loadOptionalConfig } from './config.js';
import { DEFAULT_WORKER_POWER_PROFILE, getWorkerPowerProfile } from './shared/worker-capacity.js';
import type { ResourceMetricsSnapshot } from './shared/resource-metrics.js';
import type {
  WorkerHardwareSnapshot,
  WorkerTelemetryConfigSnapshot,
  WorkerTelemetryFinishPayload,
  WorkerTelemetryJobType,
  WorkerTelemetryRunPayload,
  WorkerTelemetryRunStatus,
  WorkerTelemetrySamplePayload,
} from './shared/worker-telemetry.js';
import type { WorkerRuntimeEvent } from './shared/worker-events.js';
import { readWorkerHardwareSnapshot } from './worker-hardware.js';
import { WorkerTelemetryStore } from './worker-telemetry-store.js';
import type { TelemetryRunRecord, TelemetrySampleRecord } from './worker-telemetry-store.js';

const FLUSH_BACKOFF_MS = 30000;
const SAMPLE_FLUSH_LIMIT = 100;

type ActiveTelemetryRun = {
  localRunId: string;
  startedAt: string;
};

type WorkerTelemetryServiceDependencies = {
  store?: WorkerTelemetryStore;
  loadConfig?: typeof loadConfig;
  loadOptionalConfig?: typeof loadOptionalConfig;
  createClient?: (apiUrl: string, token: string) => Pick<
    SofliaWorkerApiClient,
    'startTelemetryRun' | 'sendTelemetrySamples' | 'finishTelemetryRun'
  >;
  readHardwareSnapshot?: () => Promise<WorkerHardwareSnapshot>;
  now?: () => number;
};

export class WorkerTelemetryService {
  private readonly store: WorkerTelemetryStore;
  private readonly readConfig: typeof loadConfig;
  private readonly readOptionalConfig: typeof loadOptionalConfig;
  private readonly createClient: NonNullable<WorkerTelemetryServiceDependencies['createClient']>;
  private readonly readHardwareSnapshot: () => Promise<WorkerHardwareSnapshot>;
  private readonly now: () => number;
  private hardwareSnapshot: WorkerHardwareSnapshot | null = null;
  private configSnapshot: WorkerTelemetryConfigSnapshot = {};
  private activeRunsByJobId = new Map<string, ActiveTelemetryRun>();
  private initialized = false;
  private flushPromise: Promise<void> | null = null;
  private nextFlushAtMs = 0;

  constructor(dependencies: WorkerTelemetryServiceDependencies = {}) {
    this.store = dependencies.store || new WorkerTelemetryStore();
    this.readConfig = dependencies.loadConfig || loadConfig;
    this.readOptionalConfig = dependencies.loadOptionalConfig || loadOptionalConfig;
    this.createClient = dependencies.createClient || ((apiUrl, token) => new SofliaWorkerApiClient(apiUrl, token));
    this.readHardwareSnapshot = dependencies.readHardwareSnapshot || readWorkerHardwareSnapshot;
    this.now = dependencies.now || Date.now;
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    this.hardwareSnapshot = await this.readHardwareSnapshot();
    await this.loadInitialConfigSnapshot();
    this.initialized = true;
    this.scheduleFlush(true);
  }

  close(): void {
    if (this.initialized) {
      this.store.markOpenRunsInterrupted(new Date(this.now()).toISOString());
    }
    this.store.close();
    this.initialized = false;
  }

  handleWorkerEvent(event: WorkerRuntimeEvent): void {
    if (!this.initialized) return;
    if (event.state === 'starting') {
      this.updateConfigSnapshot(event.detail);
      this.scheduleFlush(true);
      return;
    }
    if (event.state === 'stopped') {
      this.store.markOpenRunsInterrupted(event.finishedAt || new Date(this.now()).toISOString());
      this.activeRunsByJobId.clear();
      this.scheduleFlush(true);
      return;
    }
    if (!event.jobId) return;

    if (event.state === 'claiming') {
      this.ensureRunForEvent(event);
      return;
    }

    const activeRun = this.findRunForJobId(event.jobId);
    if (!activeRun) return;

    if (event.state === 'rendering') {
      this.store.updateRunProgress({
        localRunId: activeRun.localRunId,
        status: 'running',
        stage: event.stage,
        progressPercent: event.percent,
      });
      return;
    }

    const finishStatus = getFinishStatus(event.state);
    if (!finishStatus) return;
    const finishedAt = event.finishedAt || new Date(this.now()).toISOString();
    const elapsedMs = event.elapsedMs ?? getElapsedMs(activeRun.startedAt, finishedAt);
    this.store.finishRun({
      localRunId: activeRun.localRunId,
      status: finishStatus,
      finishedAt,
      elapsedMs,
      lastStage: event.stage,
      lastProgressPercent: event.percent,
      errorCode: finishStatus === 'failed' ? 'DESKTOP_WORKER_JOB_FAILED' : undefined,
      errorMessage: finishStatus === 'failed' ? event.message : undefined,
    });
    this.activeRunsByJobId.delete(event.jobId);
    this.scheduleFlush(true);
  }

  handleResourceSnapshot(snapshot: ResourceMetricsSnapshot): void {
    if (!this.initialized || !snapshot.activeJob?.jobId) return;
    const activeRun = this.activeRunsByJobId.get(snapshot.activeJob.jobId)
      || this.store.getOpenRunByJobId(snapshot.activeJob.jobId);
    if (!activeRun) return;

    this.store.recordSample({
      localRunId: activeRun.localRunId,
      jobId: snapshot.activeJob.jobId,
      sampledAt: snapshot.sampledAt,
      workerState: snapshot.workerState,
      stage: snapshot.activeJob.stage,
      progressPercent: snapshot.activeJob.percent,
      appCpuPercent: snapshot.app.cpuPercent,
      appGpuPercent: snapshot.app.gpuPercent,
      appMemoryBytes: snapshot.app.memoryBytes,
      appProcessCount: snapshot.app.processCount,
      systemCpuPercent: snapshot.system.cpuPercent,
      systemGpuPercent: snapshot.system.gpuPercent,
      systemMemoryUsedBytes: snapshot.system.memoryUsedBytes,
      systemMemoryTotalBytes: snapshot.system.memoryTotalBytes,
      systemCpuCount: snapshot.system.cpuCount,
      topProcesses: snapshot.processes.slice(0, 8).map((processMetric) => ({
        pid: processMetric.pid,
        parentPid: processMetric.parentPid,
        name: processMetric.name,
        type: processMetric.type,
        cpuPercent: processMetric.cpuPercent,
        memoryBytes: processMetric.memoryBytes,
      })),
      systemTopProcesses: snapshot.systemProcesses.slice(0, 8).map((processMetric) => ({
        pid: processMetric.pid,
        parentPid: processMetric.parentPid,
        name: processMetric.name,
        type: processMetric.type,
        cpuPercent: processMetric.cpuPercent,
        memoryBytes: processMetric.memoryBytes,
      })),
    });
    this.scheduleFlush(false);
  }

  private ensureRunForEvent(event: WorkerRuntimeEvent): ActiveTelemetryRun | null {
    if (!event.jobId || !this.hardwareSnapshot) return null;
    const existingRun = this.findRunForJobId(event.jobId);
    if (existingRun) return existingRun;

    const startedAt = event.startedAt || new Date(this.now()).toISOString();
    const activeRun = {
      localRunId: `wjr_${randomUUID()}`,
      startedAt,
    };
    this.store.startRun({
      localRunId: activeRun.localRunId,
      jobId: event.jobId,
      jobType: normalizeTelemetryJobType(event.jobType),
      buildId: event.buildId,
      templateVersionId: event.templateVersionId,
      compositionId: event.compositionId,
      bundleHash: readDetailString(event.detail, 'bundleHash'),
      propsHash: readDetailString(event.detail, 'propsHash'),
      outputStoragePath: readDetailString(event.detail, 'outputStoragePath')
        || readDetailString(event.detail, 'posterStoragePath'),
      status: 'running',
      startedAt,
      config: this.configSnapshot,
      hardware: this.hardwareSnapshot,
    });
    this.activeRunsByJobId.set(event.jobId, activeRun);
    this.scheduleFlush(true);
    return activeRun;
  }

  private findRunForJobId(jobId?: string): ActiveTelemetryRun | null {
    if (!jobId) return null;
    const currentRun = this.activeRunsByJobId.get(jobId);
    if (currentRun) return currentRun;
    const openRun = this.store.getOpenRunByJobId(jobId);
    if (!openRun) return null;
    const activeRun = { localRunId: openRun.localRunId, startedAt: openRun.startedAt };
    this.activeRunsByJobId.set(jobId, activeRun);
    return activeRun;
  }

  private async loadInitialConfigSnapshot(): Promise<void> {
    try {
      const optionalConfig = await this.readOptionalConfig();
      const profile = getWorkerPowerProfile(optionalConfig.powerProfile || DEFAULT_WORKER_POWER_PROFILE);
      this.configSnapshot = {
        powerProfile: profile.id,
        maxConcurrentJobs: profile.maxConcurrentJobs,
        renderConcurrency: profile.renderConcurrency,
        hardwareAcceleration: profile.hardwareAcceleration,
        chromiumGl: profile.chromiumGl,
        videoBitrate: profile.videoBitrate,
      };
    } catch {
      this.configSnapshot = {};
    }
  }

  private updateConfigSnapshot(detail?: Record<string, unknown>): void {
    if (!detail) return;
    const nextProfile = typeof detail.powerProfile === 'string'
      ? getWorkerPowerProfile(detail.powerProfile)
      : undefined;
    this.configSnapshot = {
      powerProfile: nextProfile?.id || this.configSnapshot.powerProfile,
      maxConcurrentJobs: readDetailNumber(detail, 'maxConcurrentJobs') ?? nextProfile?.maxConcurrentJobs ?? this.configSnapshot.maxConcurrentJobs,
      renderConcurrency: readDetailNumber(detail, 'renderConcurrency') ?? nextProfile?.renderConcurrency ?? this.configSnapshot.renderConcurrency,
      hardwareAcceleration: readDetailString(detail, 'hardwareAcceleration') as WorkerTelemetryConfigSnapshot['hardwareAcceleration']
        || nextProfile?.hardwareAcceleration
        || this.configSnapshot.hardwareAcceleration,
      chromiumGl: readDetailString(detail, 'chromiumGl') as WorkerTelemetryConfigSnapshot['chromiumGl']
        || nextProfile?.chromiumGl
        || this.configSnapshot.chromiumGl,
      videoBitrate: readDetailString(detail, 'videoBitrate') || nextProfile?.videoBitrate || this.configSnapshot.videoBitrate,
    };
  }

  private scheduleFlush(force: boolean): void {
    if (this.flushPromise) return;
    if (!force && this.now() < this.nextFlushAtMs) return;
    this.flushPromise = this.flushPending().finally(() => {
      this.flushPromise = null;
    });
  }

  private async flushPending(): Promise<void> {
    let client: ReturnType<WorkerTelemetryService['createClient']>;
    try {
      const config = await this.readConfig();
      client = this.createClient(config.apiUrl, config.token);
    } catch {
      return;
    }

    try {
      for (const run of this.store.listRunsNeedingStart(10)) {
        const response = await client.startTelemetryRun(run.jobId, toRunPayload(run));
        this.store.markRunStartSynced(run.localRunId, response.runId);
      }

      const samples = this.store.listPendingSamples(SAMPLE_FLUSH_LIMIT);
      for (const sampleGroup of groupSamplesByRun(samples)) {
        const firstSample = sampleGroup[0];
        if (!firstSample) continue;
        const run = this.store.getOpenRunByJobId(firstSample.jobId)
          || this.store.listRunsNeedingFinish(50).find((item) => item.localRunId === firstSample.localRunId)
          || this.store.listRunsNeedingStart(50).find((item) => item.localRunId === firstSample.localRunId);
        await client.sendTelemetrySamples(firstSample.jobId, firstSample.localRunId, {
          remoteRunId: run?.remoteRunId,
          samples: sampleGroup.map(toSamplePayload),
        });
        this.store.markSamplesSynced(sampleGroup.map((sample) => sample.id));
      }

      for (const run of this.store.listRunsNeedingFinish(10)) {
        await client.finishTelemetryRun(run.jobId, run.localRunId, toFinishPayload(run));
        this.store.markRunFinishSynced(run.localRunId);
      }
      this.nextFlushAtMs = 0;
    } catch (error) {
      const impactedRun = this.store.listRunsNeedingStart(1)[0] || this.store.listRunsNeedingFinish(1)[0];
      if (impactedRun) this.store.markRunSyncError(impactedRun.localRunId, error);
      this.nextFlushAtMs = this.now() + FLUSH_BACKOFF_MS;
    }
  }
}

function normalizeTelemetryJobType(jobType?: WorkerRuntimeEvent['jobType']): WorkerTelemetryJobType {
  if (jobType === 'template_build' || jobType === 'template_preview') return jobType;
  return 'render';
}

function getFinishStatus(state: WorkerRuntimeEvent['state']): WorkerTelemetryRunStatus | null {
  if (state === 'completed') return 'completed';
  if (state === 'upload_pending') return 'upload_pending';
  if (state === 'confirm_pending') return 'confirm_pending';
  if (state === 'error') return 'failed';
  return null;
}

function getElapsedMs(startedAt: string, finishedAt: string): number {
  return Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
}

function readDetailString(detail: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = detail?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readDetailNumber(detail: Record<string, unknown>, key: string): number | undefined {
  const value = Number(detail[key]);
  return Number.isFinite(value) ? value : undefined;
}

function toRunPayload(run: TelemetryRunRecord): WorkerTelemetryRunPayload {
  return {
    localRunId: run.localRunId,
    jobId: run.jobId,
    jobType: run.jobType,
    buildId: run.buildId,
    templateVersionId: run.templateVersionId,
    compositionId: run.compositionId,
    bundleHash: run.bundleHash,
    propsHash: run.propsHash,
    outputStoragePath: run.outputStoragePath,
    status: run.status,
    startedAt: run.startedAt,
    config: run.config,
    hardware: run.hardware,
  };
}

function toSamplePayload(sample: TelemetrySampleRecord): WorkerTelemetrySamplePayload {
  return {
    sampledAt: sample.sampledAt,
    workerState: sample.workerState,
    stage: sample.stage,
    progressPercent: sample.progressPercent,
    appCpuPercent: sample.appCpuPercent,
    appGpuPercent: sample.appGpuPercent,
    appMemoryBytes: sample.appMemoryBytes,
    appProcessCount: sample.appProcessCount,
    systemCpuPercent: sample.systemCpuPercent,
    systemGpuPercent: sample.systemGpuPercent,
    systemMemoryUsedBytes: sample.systemMemoryUsedBytes,
    systemMemoryTotalBytes: sample.systemMemoryTotalBytes,
    systemCpuCount: sample.systemCpuCount,
    topProcesses: sample.topProcesses,
    systemTopProcesses: sample.systemTopProcesses || [],
  };
}

function toFinishPayload(run: TelemetryRunRecord): WorkerTelemetryFinishPayload {
  return {
    localRunId: run.localRunId,
    remoteRunId: run.remoteRunId,
    status: run.status,
    finishedAt: run.finishedAt || new Date().toISOString(),
    elapsedMs: run.elapsedMs || 0,
    lastStage: run.lastStage,
    lastProgressPercent: run.lastProgressPercent,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    summary: run.summary,
  };
}

function groupSamplesByRun(samples: TelemetrySampleRecord[]): TelemetrySampleRecord[][] {
  const groups = new Map<string, TelemetrySampleRecord[]>();
  for (const sample of samples) {
    const group = groups.get(sample.localRunId) || [];
    group.push(sample);
    groups.set(sample.localRunId, group);
  }
  return [...groups.values()];
}
