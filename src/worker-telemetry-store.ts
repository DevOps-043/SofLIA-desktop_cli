import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getLocalJobStorePath } from './local-job-store.js';
import type {
  WorkerHardwareSnapshot,
  WorkerTelemetryConfigSnapshot,
  WorkerTelemetryFinishPayload,
  WorkerTelemetryJobType,
  WorkerTelemetryProcessSample,
  WorkerTelemetryRunPayload,
  WorkerTelemetryRunStatus,
  WorkerTelemetryRunSummary,
  WorkerTelemetrySamplePayload,
} from './shared/worker-telemetry.js';

type TelemetryRunRow = {
  local_run_id: string;
  remote_run_id: string | null;
  job_id: string;
  job_type: WorkerTelemetryJobType;
  build_id: string | null;
  template_version_id: string | null;
  composition_id: string | null;
  bundle_hash: string | null;
  props_hash: string | null;
  output_storage_path: string | null;
  status: WorkerTelemetryRunStatus;
  started_at: string;
  finished_at: string | null;
  elapsed_ms: number | null;
  last_stage: string | null;
  last_progress_percent: number | null;
  power_profile: string | null;
  max_concurrent_jobs: number | null;
  render_concurrency: number | null;
  hardware_acceleration: string | null;
  chromium_gl: string | null;
  video_bitrate: string | null;
  platform: NodeJS.Platform;
  arch: string;
  cpu_model: string | null;
  cpu_logical_threads: number;
  memory_total_bytes: number;
  gpu_adapters_json: string;
  sample_count: number;
  avg_app_cpu_percent: number;
  max_app_cpu_percent: number;
  avg_app_gpu_percent: number;
  max_app_gpu_percent: number;
  avg_app_memory_bytes: number;
  max_app_memory_bytes: number;
  avg_system_cpu_percent: number;
  max_system_cpu_percent: number;
  avg_system_gpu_percent: number;
  max_system_gpu_percent: number;
  max_system_memory_used_bytes: number;
  error_code: string | null;
  error_message: string | null;
  start_synced_at: string | null;
  finish_synced_at: string | null;
  last_sync_error: string | null;
  created_at: string;
  updated_at: string;
};

type TelemetrySampleRow = {
  id: number;
  local_run_id: string;
  job_id: string;
  sampled_at: string;
  worker_state: string;
  stage: string | null;
  progress_percent: number | null;
  app_cpu_percent: number;
  app_gpu_percent: number;
  app_memory_bytes: number;
  app_process_count: number;
  system_cpu_percent: number;
  system_gpu_percent: number;
  system_memory_used_bytes: number;
  system_memory_total_bytes: number;
  system_cpu_count: number;
  top_processes_json: string;
  system_top_processes_json: string;
  synced_at: string | null;
  created_at: string;
};

export type TelemetryRunRecord = WorkerTelemetryRunPayload & {
  remoteRunId?: string;
  finishedAt?: string;
  elapsedMs?: number;
  lastStage?: string;
  lastProgressPercent?: number;
  errorCode?: string;
  errorMessage?: string;
  startSyncedAt?: string;
  finishSyncedAt?: string;
  lastSyncError?: string;
  summary: WorkerTelemetryRunSummary;
};

export type TelemetrySampleRecord = WorkerTelemetrySamplePayload & {
  id: number;
  localRunId: string;
  jobId: string;
};

export type StartTelemetryRunInput = WorkerTelemetryRunPayload;

export type UpdateTelemetryRunProgressInput = {
  localRunId: string;
  status?: WorkerTelemetryRunStatus;
  stage?: string;
  progressPercent?: number;
};

export type FinishTelemetryRunInput = Omit<WorkerTelemetryFinishPayload, 'summary' | 'remoteRunId'>;

export type RecordTelemetrySampleInput = WorkerTelemetrySamplePayload & {
  localRunId: string;
  jobId: string;
};

export class WorkerTelemetryStore {
  private database?: DatabaseSync;

  constructor(private readonly databasePath = getLocalJobStorePath()) {}

  async initialize(): Promise<void> {
    await fsp.mkdir(path.dirname(this.databasePath), { recursive: true });
    const database = this.getDatabase();
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS worker_job_runs (
        local_run_id TEXT PRIMARY KEY,
        remote_run_id TEXT,
        job_id TEXT NOT NULL,
        job_type TEXT NOT NULL,
        build_id TEXT,
        template_version_id TEXT,
        composition_id TEXT,
        bundle_hash TEXT,
        props_hash TEXT,
        output_storage_path TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        elapsed_ms INTEGER,
        last_stage TEXT,
        last_progress_percent REAL,
        power_profile TEXT,
        max_concurrent_jobs INTEGER,
        render_concurrency INTEGER,
        hardware_acceleration TEXT,
        chromium_gl TEXT,
        video_bitrate TEXT,
        platform TEXT NOT NULL,
        arch TEXT NOT NULL,
        cpu_model TEXT,
        cpu_logical_threads INTEGER NOT NULL,
        memory_total_bytes INTEGER NOT NULL,
        gpu_adapters_json TEXT NOT NULL DEFAULT '[]',
        sample_count INTEGER NOT NULL DEFAULT 0,
        avg_app_cpu_percent REAL NOT NULL DEFAULT 0,
        max_app_cpu_percent REAL NOT NULL DEFAULT 0,
        avg_app_gpu_percent REAL NOT NULL DEFAULT 0,
        max_app_gpu_percent REAL NOT NULL DEFAULT 0,
        avg_app_memory_bytes REAL NOT NULL DEFAULT 0,
        max_app_memory_bytes INTEGER NOT NULL DEFAULT 0,
        avg_system_cpu_percent REAL NOT NULL DEFAULT 0,
        max_system_cpu_percent REAL NOT NULL DEFAULT 0,
        avg_system_gpu_percent REAL NOT NULL DEFAULT 0,
        max_system_gpu_percent REAL NOT NULL DEFAULT 0,
        max_system_memory_used_bytes INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        error_message TEXT,
        start_synced_at TEXT,
        finish_synced_at TEXT,
        last_sync_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS worker_job_metric_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        local_run_id TEXT NOT NULL REFERENCES worker_job_runs(local_run_id) ON DELETE CASCADE,
        job_id TEXT NOT NULL,
        sampled_at TEXT NOT NULL,
        worker_state TEXT NOT NULL,
        stage TEXT,
        progress_percent REAL,
        app_cpu_percent REAL NOT NULL,
        app_gpu_percent REAL NOT NULL,
        app_memory_bytes INTEGER NOT NULL,
        app_process_count INTEGER NOT NULL,
        system_cpu_percent REAL NOT NULL,
        system_gpu_percent REAL NOT NULL,
        system_memory_used_bytes INTEGER NOT NULL,
        system_memory_total_bytes INTEGER NOT NULL,
        system_cpu_count INTEGER NOT NULL,
        top_processes_json TEXT NOT NULL DEFAULT '[]',
        system_top_processes_json TEXT NOT NULL DEFAULT '[]',
        synced_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_worker_job_runs_job ON worker_job_runs (job_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_worker_job_runs_status ON worker_job_runs (status, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_worker_job_runs_sync_start ON worker_job_runs (start_synced_at, started_at);
      CREATE INDEX IF NOT EXISTS idx_worker_job_runs_sync_finish ON worker_job_runs (finish_synced_at, finished_at);
      CREATE INDEX IF NOT EXISTS idx_worker_job_metric_samples_run ON worker_job_metric_samples (local_run_id, id);
      CREATE INDEX IF NOT EXISTS idx_worker_job_metric_samples_sync ON worker_job_metric_samples (synced_at, id);
    `);
    this.ensureColumn('worker_job_metric_samples', 'system_top_processes_json', "TEXT NOT NULL DEFAULT '[]'");
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }

  startRun(input: StartTelemetryRunInput): void {
    const now = new Date().toISOString();
    const hardware = input.hardware;
    const config = input.config;
    this.getDatabase().prepare(`
      INSERT INTO worker_job_runs (
        local_run_id, job_id, job_type, build_id, template_version_id, composition_id,
        bundle_hash, props_hash, output_storage_path, status, started_at, last_stage,
        power_profile, max_concurrent_jobs, render_concurrency, hardware_acceleration,
        chromium_gl, video_bitrate, platform, arch, cpu_model, cpu_logical_threads,
        memory_total_bytes, gpu_adapters_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(local_run_id) DO UPDATE SET
        status = excluded.status,
        last_stage = excluded.last_stage,
        updated_at = excluded.updated_at
    `).run(
      input.localRunId,
      input.jobId,
      input.jobType,
      input.buildId || null,
      input.templateVersionId || null,
      input.compositionId || null,
      input.bundleHash || null,
      input.propsHash || null,
      input.outputStoragePath || null,
      input.status,
      input.startedAt,
      'claim',
      config.powerProfile || null,
      config.maxConcurrentJobs ?? null,
      config.renderConcurrency ?? null,
      config.hardwareAcceleration || null,
      config.chromiumGl || null,
      config.videoBitrate || null,
      hardware.platform,
      hardware.arch,
      hardware.cpuModel || null,
      hardware.cpuLogicalThreads,
      hardware.memoryTotalBytes,
      JSON.stringify(hardware.gpuAdapters.slice(0, 8)),
      now,
      now,
    );
  }

  updateRunProgress(input: UpdateTelemetryRunProgressInput): void {
    this.getDatabase().prepare(`
      UPDATE worker_job_runs
      SET status = COALESCE(?, status),
          last_stage = COALESCE(?, last_stage),
          last_progress_percent = COALESCE(?, last_progress_percent),
          updated_at = ?
      WHERE local_run_id = ?
    `).run(
      input.status || null,
      input.stage || null,
      input.progressPercent ?? null,
      new Date().toISOString(),
      input.localRunId,
    );
  }

  finishRun(input: FinishTelemetryRunInput): WorkerTelemetryRunSummary {
    const summary = this.getRunSummary(input.localRunId);
    this.getDatabase().prepare(`
      UPDATE worker_job_runs
      SET status = ?,
          finished_at = ?,
          elapsed_ms = ?,
          last_stage = COALESCE(?, last_stage),
          last_progress_percent = COALESCE(?, last_progress_percent),
          sample_count = ?,
          avg_app_cpu_percent = ?,
          max_app_cpu_percent = ?,
          avg_app_gpu_percent = ?,
          max_app_gpu_percent = ?,
          avg_app_memory_bytes = ?,
          max_app_memory_bytes = ?,
          avg_system_cpu_percent = ?,
          max_system_cpu_percent = ?,
          avg_system_gpu_percent = ?,
          max_system_gpu_percent = ?,
          max_system_memory_used_bytes = ?,
          error_code = ?,
          error_message = ?,
          updated_at = ?
      WHERE local_run_id = ?
    `).run(
      input.status,
      input.finishedAt,
      input.elapsedMs,
      input.lastStage || null,
      input.lastProgressPercent ?? null,
      summary.sampleCount,
      summary.avgAppCpuPercent,
      summary.maxAppCpuPercent,
      summary.avgAppGpuPercent,
      summary.maxAppGpuPercent,
      summary.avgAppMemoryBytes,
      summary.maxAppMemoryBytes,
      summary.avgSystemCpuPercent,
      summary.maxSystemCpuPercent,
      summary.avgSystemGpuPercent,
      summary.maxSystemGpuPercent,
      summary.maxSystemMemoryUsedBytes,
      input.errorCode || null,
      input.errorMessage ? input.errorMessage.slice(0, 500) : null,
      new Date().toISOString(),
      input.localRunId,
    );
    return summary;
  }

  recordSample(input: RecordTelemetrySampleInput): number {
    const result = this.getDatabase().prepare(`
      INSERT INTO worker_job_metric_samples (
        local_run_id, job_id, sampled_at, worker_state, stage, progress_percent,
        app_cpu_percent, app_gpu_percent, app_memory_bytes, app_process_count,
        system_cpu_percent, system_gpu_percent, system_memory_used_bytes,
        system_memory_total_bytes, system_cpu_count, top_processes_json,
        system_top_processes_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.localRunId,
      input.jobId,
      input.sampledAt,
      input.workerState,
      input.stage || null,
      input.progressPercent ?? null,
      input.appCpuPercent,
      input.appGpuPercent,
      input.appMemoryBytes,
      input.appProcessCount,
      input.systemCpuPercent,
      input.systemGpuPercent,
      input.systemMemoryUsedBytes,
      input.systemMemoryTotalBytes,
      input.systemCpuCount,
      JSON.stringify(input.topProcesses.slice(0, 8)),
      JSON.stringify((input.systemTopProcesses || []).slice(0, 8)),
      new Date().toISOString(),
    );
    return Number(result.lastInsertRowid);
  }

  getOpenRunByJobId(jobId: string): TelemetryRunRecord | null {
    const row = this.getDatabase().prepare(`
      SELECT * FROM worker_job_runs
      WHERE job_id = ? AND status = 'running' AND finished_at IS NULL
      ORDER BY started_at DESC
      LIMIT 1
    `).get(jobId) as TelemetryRunRow | undefined;
    return row ? mapRunRow(row) : null;
  }

  listRunsNeedingStart(limit = 10): TelemetryRunRecord[] {
    const rows = this.getDatabase().prepare(`
      SELECT * FROM worker_job_runs
      WHERE start_synced_at IS NULL
      ORDER BY started_at ASC
      LIMIT ?
    `).all(limit) as TelemetryRunRow[];
    return rows.map(mapRunRow);
  }

  markRunStartSynced(localRunId: string, remoteRunId?: string): void {
    const now = new Date().toISOString();
    this.getDatabase().prepare(`
      UPDATE worker_job_runs
      SET remote_run_id = COALESCE(?, remote_run_id),
          start_synced_at = ?,
          last_sync_error = NULL,
          updated_at = ?
      WHERE local_run_id = ?
    `).run(remoteRunId || null, now, now, localRunId);
  }

  listPendingSamples(limit = 100): TelemetrySampleRecord[] {
    const rows = this.getDatabase().prepare(`
      SELECT samples.*
      FROM worker_job_metric_samples samples
      JOIN worker_job_runs runs ON runs.local_run_id = samples.local_run_id
      WHERE samples.synced_at IS NULL
        AND runs.start_synced_at IS NOT NULL
      ORDER BY samples.id ASC
      LIMIT ?
    `).all(limit) as TelemetrySampleRow[];
    return rows.map(mapSampleRow);
  }

  markSamplesSynced(sampleIds: number[]): void {
    if (sampleIds.length === 0) return;
    const now = new Date().toISOString();
    const update = this.getDatabase().prepare(`
      UPDATE worker_job_metric_samples
      SET synced_at = ?
      WHERE id = ?
    `);
    for (const id of sampleIds) update.run(now, id);
  }

  listRunsNeedingFinish(limit = 10): TelemetryRunRecord[] {
    const rows = this.getDatabase().prepare(`
      SELECT * FROM worker_job_runs
      WHERE finished_at IS NOT NULL
        AND start_synced_at IS NOT NULL
        AND finish_synced_at IS NULL
      ORDER BY finished_at ASC
      LIMIT ?
    `).all(limit) as TelemetryRunRow[];
    return rows.map(mapRunRow);
  }

  markRunFinishSynced(localRunId: string): void {
    const now = new Date().toISOString();
    this.getDatabase().prepare(`
      UPDATE worker_job_runs
      SET finish_synced_at = ?,
          last_sync_error = NULL,
          updated_at = ?
      WHERE local_run_id = ?
    `).run(now, now, localRunId);
  }

  markRunSyncError(localRunId: string, error: unknown): void {
    const message = sanitizeSyncError(error);
    this.getDatabase().prepare(`
      UPDATE worker_job_runs
      SET last_sync_error = ?,
          updated_at = ?
      WHERE local_run_id = ?
    `).run(message, new Date().toISOString(), localRunId);
  }

  markOpenRunsInterrupted(finishedAt = new Date().toISOString()): void {
    const rows = this.getDatabase().prepare(`
      SELECT local_run_id, started_at FROM worker_job_runs
      WHERE status = 'running' AND finished_at IS NULL
    `).all() as Array<{ local_run_id: string; started_at: string }>;
    for (const row of rows) {
      const elapsedMs = Math.max(0, Date.parse(finishedAt) - Date.parse(row.started_at));
      this.finishRun({
        localRunId: row.local_run_id,
        status: 'interrupted',
        finishedAt,
        elapsedMs,
        lastStage: 'worker_stopped',
      });
    }
  }

  private getRunSummary(localRunId: string): WorkerTelemetryRunSummary {
    const row = this.getDatabase().prepare(`
      SELECT
        COUNT(*) AS sample_count,
        COALESCE(AVG(app_cpu_percent), 0) AS avg_app_cpu_percent,
        COALESCE(MAX(app_cpu_percent), 0) AS max_app_cpu_percent,
        COALESCE(AVG(app_gpu_percent), 0) AS avg_app_gpu_percent,
        COALESCE(MAX(app_gpu_percent), 0) AS max_app_gpu_percent,
        COALESCE(AVG(app_memory_bytes), 0) AS avg_app_memory_bytes,
        COALESCE(MAX(app_memory_bytes), 0) AS max_app_memory_bytes,
        COALESCE(AVG(system_cpu_percent), 0) AS avg_system_cpu_percent,
        COALESCE(MAX(system_cpu_percent), 0) AS max_system_cpu_percent,
        COALESCE(AVG(system_gpu_percent), 0) AS avg_system_gpu_percent,
        COALESCE(MAX(system_gpu_percent), 0) AS max_system_gpu_percent,
        COALESCE(MAX(system_memory_used_bytes), 0) AS max_system_memory_used_bytes
      FROM worker_job_metric_samples
      WHERE local_run_id = ?
    `).get(localRunId) as Record<string, number> | undefined;

    return {
      sampleCount: Number(row?.sample_count || 0),
      avgAppCpuPercent: roundMetric(row?.avg_app_cpu_percent),
      maxAppCpuPercent: roundMetric(row?.max_app_cpu_percent),
      avgAppGpuPercent: roundMetric(row?.avg_app_gpu_percent),
      maxAppGpuPercent: roundMetric(row?.max_app_gpu_percent),
      avgAppMemoryBytes: Math.round(Number(row?.avg_app_memory_bytes || 0)),
      maxAppMemoryBytes: Math.round(Number(row?.max_app_memory_bytes || 0)),
      avgSystemCpuPercent: roundMetric(row?.avg_system_cpu_percent),
      maxSystemCpuPercent: roundMetric(row?.max_system_cpu_percent),
      avgSystemGpuPercent: roundMetric(row?.avg_system_gpu_percent),
      maxSystemGpuPercent: roundMetric(row?.max_system_gpu_percent),
      maxSystemMemoryUsedBytes: Math.round(Number(row?.max_system_memory_used_bytes || 0)),
    };
  }

  private getDatabase(): DatabaseSync {
    if (!this.database) {
      this.database = new DatabaseSync(this.databasePath);
    }
    return this.database;
  }

  private ensureColumn(tableName: string, columnName: string, definition: string): void {
    const columns = this.getDatabase().prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === columnName)) return;
    this.getDatabase().exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

function mapRunRow(row: TelemetryRunRow): TelemetryRunRecord {
  const config: WorkerTelemetryConfigSnapshot = {
    powerProfile: row.power_profile as WorkerTelemetryConfigSnapshot['powerProfile'],
    maxConcurrentJobs: row.max_concurrent_jobs ?? undefined,
    renderConcurrency: row.render_concurrency ?? undefined,
    hardwareAcceleration: row.hardware_acceleration as WorkerTelemetryConfigSnapshot['hardwareAcceleration'],
    chromiumGl: row.chromium_gl as WorkerTelemetryConfigSnapshot['chromiumGl'],
    videoBitrate: row.video_bitrate || undefined,
  };
  const hardware: WorkerHardwareSnapshot = {
    platform: row.platform,
    arch: row.arch,
    cpuModel: row.cpu_model || undefined,
    cpuLogicalThreads: row.cpu_logical_threads,
    memoryTotalBytes: row.memory_total_bytes,
    gpuAdapters: parseJsonArray(row.gpu_adapters_json),
  };
  return {
    localRunId: row.local_run_id,
    remoteRunId: row.remote_run_id || undefined,
    jobId: row.job_id,
    jobType: row.job_type,
    buildId: row.build_id || undefined,
    templateVersionId: row.template_version_id || undefined,
    compositionId: row.composition_id || undefined,
    bundleHash: row.bundle_hash || undefined,
    propsHash: row.props_hash || undefined,
    outputStoragePath: row.output_storage_path || undefined,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at || undefined,
    elapsedMs: row.elapsed_ms ?? undefined,
    lastStage: row.last_stage || undefined,
    lastProgressPercent: row.last_progress_percent ?? undefined,
    errorCode: row.error_code || undefined,
    errorMessage: row.error_message || undefined,
    startSyncedAt: row.start_synced_at || undefined,
    finishSyncedAt: row.finish_synced_at || undefined,
    lastSyncError: row.last_sync_error || undefined,
    config,
    hardware,
    summary: {
      sampleCount: row.sample_count,
      avgAppCpuPercent: row.avg_app_cpu_percent,
      maxAppCpuPercent: row.max_app_cpu_percent,
      avgAppGpuPercent: row.avg_app_gpu_percent,
      maxAppGpuPercent: row.max_app_gpu_percent,
      avgAppMemoryBytes: row.avg_app_memory_bytes,
      maxAppMemoryBytes: row.max_app_memory_bytes,
      avgSystemCpuPercent: row.avg_system_cpu_percent,
      maxSystemCpuPercent: row.max_system_cpu_percent,
      avgSystemGpuPercent: row.avg_system_gpu_percent,
      maxSystemGpuPercent: row.max_system_gpu_percent,
      maxSystemMemoryUsedBytes: row.max_system_memory_used_bytes,
    },
  };
}

function mapSampleRow(row: TelemetrySampleRow): TelemetrySampleRecord {
  return {
    id: row.id,
    localRunId: row.local_run_id,
    jobId: row.job_id,
    sampledAt: row.sampled_at,
    workerState: row.worker_state,
    stage: row.stage || undefined,
    progressPercent: row.progress_percent ?? undefined,
    appCpuPercent: row.app_cpu_percent,
    appGpuPercent: row.app_gpu_percent,
    appMemoryBytes: row.app_memory_bytes,
    appProcessCount: row.app_process_count,
    systemCpuPercent: row.system_cpu_percent,
    systemGpuPercent: row.system_gpu_percent,
    systemMemoryUsedBytes: row.system_memory_used_bytes,
    systemMemoryTotalBytes: row.system_memory_total_bytes,
    systemCpuCount: row.system_cpu_count,
    topProcesses: parseJsonArray(row.top_processes_json),
    systemTopProcesses: parseJsonArray(row.system_top_processes_json),
  };
}

function parseJsonArray<T = WorkerTelemetryProcessSample>(value: string): T[] {
  try {
    const parsed = JSON.parse(value || '[]') as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function roundMetric(value: unknown): number {
  return Math.round(Number(value || 0) * 100) / 100;
}

function sanitizeSyncError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').slice(0, 500);
}
