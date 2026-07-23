import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getWorkspaceDir } from './paths.js';
import type {
  LocalCleanupPolicy,
  LocalCleanupStatus,
  LocalJobRecord,
  LocalJobRemoteTable,
  LocalJobStatus,
  LocalJobType,
  LocalRecoverySummary,
} from './local-job-state.js';

type LocalJobRow = {
  job_id: string;
  job_type: LocalJobType;
  remote_table: LocalJobRemoteTable;
  local_status: LocalJobStatus;
  stage: string;
  bundle_hash: string | null;
  props_hash: string | null;
  output_storage_path: string | null;
  artifact_path: string | null;
  artifact_checksum: string | null;
  artifact_size_bytes: number | null;
  duration_seconds: number | null;
  retry_count: number;
  last_error_code: string | null;
  last_error_message: string | null;
  remote_confirmed_at: string | null;
  cleanup_policy: LocalCleanupPolicy;
  cleanup_status: LocalCleanupStatus;
  created_at: string;
  updated_at: string;
};

export interface UpsertLocalJobInput {
  jobId: string;
  jobType: LocalJobType;
  remoteTable: LocalJobRemoteTable;
  localStatus: LocalJobStatus;
  stage: string;
  cleanupPolicy: LocalCleanupPolicy;
  bundleHash?: string;
  propsHash?: string;
  outputStoragePath?: string;
}

export interface MarkArtifactReadyInput {
  jobId: string;
  artifactPath: string;
  artifactChecksum: string;
  artifactSizeBytes: number;
  durationSeconds?: number;
  outputStoragePath?: string;
}

export class LocalJobStore {
  private database?: DatabaseSync;

  constructor(private readonly databasePath = getLocalJobStorePath()) {}

  async initialize(): Promise<void> {
    await fsp.mkdir(path.dirname(this.databasePath), { recursive: true });
    const database = this.getDatabase();
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS local_jobs (
        job_id TEXT PRIMARY KEY,
        job_type TEXT NOT NULL,
        remote_table TEXT NOT NULL,
        local_status TEXT NOT NULL,
        stage TEXT NOT NULL,
        bundle_hash TEXT,
        props_hash TEXT,
        output_storage_path TEXT,
        artifact_path TEXT,
        artifact_checksum TEXT,
        artifact_size_bytes INTEGER,
        duration_seconds INTEGER,
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_error_code TEXT,
        last_error_message TEXT,
        remote_confirmed_at TEXT,
        cleanup_policy TEXT NOT NULL DEFAULT 'delete_on_remote_confirm',
        cleanup_status TEXT NOT NULL DEFAULT 'not_ready',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS local_job_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        stage TEXT NOT NULL,
        message TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS bundle_cache_entries (
        bundle_hash TEXT PRIMARY KEY,
        bundle_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        ready INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_local_jobs_status ON local_jobs (local_status);
      CREATE INDEX IF NOT EXISTS idx_local_jobs_cleanup ON local_jobs (cleanup_status);
    `);
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }

  upsertClaimedJob(input: UpsertLocalJobInput): void {
    const now = new Date().toISOString();
    this.getDatabase().prepare(`
      INSERT INTO local_jobs (
        job_id, job_type, remote_table, local_status, stage, bundle_hash, props_hash,
        output_storage_path, cleanup_policy, cleanup_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_ready', ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        job_type = excluded.job_type,
        remote_table = excluded.remote_table,
        local_status = excluded.local_status,
        stage = excluded.stage,
        bundle_hash = excluded.bundle_hash,
        props_hash = excluded.props_hash,
        output_storage_path = excluded.output_storage_path,
        cleanup_policy = excluded.cleanup_policy,
        updated_at = excluded.updated_at
    `).run(
      input.jobId,
      input.jobType,
      input.remoteTable,
      input.localStatus,
      input.stage,
      input.bundleHash || null,
      input.propsHash || null,
      input.outputStoragePath || null,
      input.cleanupPolicy,
      now,
      now,
    );
    this.addEvent(input.jobId, input.stage, input.localStatus, 'Job registrado localmente');
  }

  updateStage(jobId: string, localStatus: LocalJobStatus, stage: string): void {
    this.getDatabase().prepare(`
      UPDATE local_jobs
      SET local_status = ?, stage = ?, updated_at = ?
      WHERE job_id = ?
    `).run(localStatus, stage, new Date().toISOString(), jobId);
    this.addEvent(jobId, stage, localStatus);
  }

  markArtifactReady(input: MarkArtifactReadyInput): void {
    const now = new Date().toISOString();
    this.getDatabase().prepare(`
      UPDATE local_jobs
      SET local_status = 'artifact_ready',
          stage = 'artifact_ready',
          artifact_path = ?,
          artifact_checksum = ?,
          artifact_size_bytes = ?,
          duration_seconds = COALESCE(?, duration_seconds),
          output_storage_path = COALESCE(?, output_storage_path),
          cleanup_status = 'pending',
          last_error_code = NULL,
          last_error_message = NULL,
          updated_at = ?
      WHERE job_id = ?
    `).run(
      input.artifactPath,
      input.artifactChecksum,
      input.artifactSizeBytes,
      input.durationSeconds ?? null,
      input.outputStoragePath ?? null,
      now,
      input.jobId,
    );
    this.addEvent(input.jobId, 'artifact_ready', 'artifact_ready', 'Artefacto final listo localmente');
  }

  markUploadFailed(jobId: string, error: unknown): void {
    this.markRetryableFailure(jobId, 'upload_failed', 'upload_failed', error);
  }

  markConfirmFailed(jobId: string, error: unknown): void {
    this.markRetryableFailure(jobId, 'confirm_failed', 'confirm_failed', error);
  }

  markUploadedPendingComplete(jobId: string): void {
    this.updateStage(jobId, 'uploaded_pending_complete', 'uploaded_pending_complete');
  }

  markRemoteConfirmed(jobId: string): void {
    const now = new Date().toISOString();
    this.getDatabase().prepare(`
      UPDATE local_jobs
      SET local_status = 'remote_confirmed_pending_cleanup',
          stage = 'remote_confirmed',
          remote_confirmed_at = ?,
          cleanup_status = CASE
            WHEN cleanup_policy = 'keep_all' THEN 'retained_by_policy'
            ELSE 'pending'
          END,
          last_error_code = NULL,
          last_error_message = NULL,
          updated_at = ?
      WHERE job_id = ?
    `).run(now, now, jobId);
    this.addEvent(jobId, 'remote_confirmed', 'remote_confirmed', 'Confirmacion remota recibida');
  }

  markCleanupDeleted(jobId: string): void {
    this.getDatabase().prepare(`
      UPDATE local_jobs
      SET local_status = 'completed_local',
          stage = 'cleanup_deleted',
          cleanup_status = 'deleted',
          artifact_path = NULL,
          updated_at = ?
      WHERE job_id = ?
    `).run(new Date().toISOString(), jobId);
    this.addEvent(jobId, 'cleanup_deleted', 'completed_local', 'Artefacto local eliminado');
  }

  markCleanupRetained(jobId: string): void {
    this.getDatabase().prepare(`
      UPDATE local_jobs
      SET local_status = 'completed_local',
          stage = 'cleanup_retained',
          cleanup_status = 'retained_by_policy',
          updated_at = ?
      WHERE job_id = ?
    `).run(new Date().toISOString(), jobId);
    this.addEvent(jobId, 'cleanup_retained', 'completed_local', 'Artefacto conservado por politica local');
  }

  markCleanupFailed(jobId: string, error: unknown): void {
    const detail = sanitizeLocalError(error);
    this.getDatabase().prepare(`
      UPDATE local_jobs
      SET cleanup_status = 'cleanup_failed',
          last_error_code = ?,
          last_error_message = ?,
          updated_at = ?
      WHERE job_id = ?
    `).run(detail.code, detail.message, new Date().toISOString(), jobId);
    this.addEvent(jobId, 'cleanup_failed', 'cleanup_failed', detail.message);
  }

  markNonRecoverableFailure(jobId: string, errorCode: string, message: string): void {
    this.getDatabase().prepare(`
      UPDATE local_jobs
      SET local_status = 'failed_non_recoverable',
          stage = 'failed_non_recoverable',
          cleanup_status = 'not_ready',
          last_error_code = ?,
          last_error_message = ?,
          updated_at = ?
      WHERE job_id = ?
    `).run(errorCode, message.slice(0, 500), new Date().toISOString(), jobId);
    this.addEvent(jobId, 'failed_non_recoverable', 'failed_non_recoverable', message.slice(0, 500));
  }

  listRecoverableJobs(limit = 10): LocalJobRecord[] {
    const rows = this.getDatabase().prepare(`
      SELECT * FROM local_jobs
      WHERE local_status IN ('artifact_ready', 'upload_failed', 'uploaded_pending_complete', 'confirm_failed', 'remote_confirmed_pending_cleanup')
         OR cleanup_status IN ('pending', 'cleanup_failed')
      ORDER BY updated_at ASC
      LIMIT ?
    `).all(limit) as LocalJobRow[];
    return rows.map(mapLocalJobRow);
  }

  getRecoverySummary(): LocalRecoverySummary {
    const row = this.getDatabase().prepare(`
      SELECT
        SUM(CASE WHEN local_status IN ('artifact_ready', 'upload_failed') THEN 1 ELSE 0 END) AS pending_uploads,
        SUM(CASE WHEN local_status IN ('uploaded_pending_complete', 'confirm_failed') THEN 1 ELSE 0 END) AS pending_completes,
        SUM(CASE WHEN cleanup_status IN ('pending', 'cleanup_failed') THEN 1 ELSE 0 END) AS pending_cleanup,
        SUM(CASE WHEN cleanup_status = 'retained_by_policy' THEN COALESCE(artifact_size_bytes, 0) ELSE 0 END) AS retained_bytes
      FROM local_jobs
    `).get() as {
      pending_uploads: number | null;
      pending_completes: number | null;
      pending_cleanup: number | null;
      retained_bytes: number | null;
    } | undefined;

    return {
      pendingUploads: Number(row?.pending_uploads || 0),
      pendingCompletes: Number(row?.pending_completes || 0),
      pendingCleanup: Number(row?.pending_cleanup || 0),
      retainedBytes: Number(row?.retained_bytes || 0),
    };
  }

  recordBundleCache(bundleHash: string, bundlePath: string, sizeBytes: number, ready: boolean): void {
    const now = new Date().toISOString();
    this.getDatabase().prepare(`
      INSERT INTO bundle_cache_entries (bundle_hash, bundle_path, size_bytes, ready, last_used_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(bundle_hash) DO UPDATE SET
        bundle_path = excluded.bundle_path,
        size_bytes = excluded.size_bytes,
        ready = excluded.ready,
        last_used_at = excluded.last_used_at,
        updated_at = excluded.updated_at
    `).run(bundleHash, bundlePath, sizeBytes, ready ? 1 : 0, now, now);
  }

  private markRetryableFailure(
    jobId: string,
    localStatus: LocalJobStatus,
    stage: string,
    error: unknown,
  ): void {
    const detail = sanitizeLocalError(error);
    this.getDatabase().prepare(`
      UPDATE local_jobs
      SET local_status = ?,
          stage = ?,
          retry_count = retry_count + 1,
          last_error_code = ?,
          last_error_message = ?,
          updated_at = ?
      WHERE job_id = ?
    `).run(localStatus, stage, detail.code, detail.message, new Date().toISOString(), jobId);
    this.addEvent(jobId, stage, localStatus, detail.message);
  }

  private addEvent(jobId: string, stage: string, eventType: string, message = ''): void {
    this.getDatabase().prepare(`
      INSERT INTO local_job_events (job_id, event_type, stage, message, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(jobId, eventType, stage, message.slice(0, 500), new Date().toISOString());
  }

  private getDatabase(): DatabaseSync {
    if (!this.database) {
      this.database = new DatabaseSync(this.databasePath);
    }
    return this.database;
  }
}

export function getLocalJobStorePath(): string {
  return path.join(getWorkspaceDir(), 'state', 'worker-state.db');
}

function mapLocalJobRow(row: LocalJobRow): LocalJobRecord {
  return {
    jobId: row.job_id,
    jobType: row.job_type,
    remoteTable: row.remote_table,
    localStatus: row.local_status,
    stage: row.stage,
    bundleHash: row.bundle_hash || undefined,
    propsHash: row.props_hash || undefined,
    outputStoragePath: row.output_storage_path || undefined,
    artifactPath: row.artifact_path || undefined,
    artifactChecksum: row.artifact_checksum || undefined,
    artifactSizeBytes: row.artifact_size_bytes ?? undefined,
    durationSeconds: row.duration_seconds ?? undefined,
    retryCount: row.retry_count,
    lastErrorCode: row.last_error_code || undefined,
    lastErrorMessage: row.last_error_message || undefined,
    remoteConfirmedAt: row.remote_confirmed_at || undefined,
    cleanupPolicy: row.cleanup_policy,
    cleanupStatus: row.cleanup_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sanitizeLocalError(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const code = /fetch|network|ECONN|ENOTFOUND|ETIMEDOUT|HTTP \d{3}/i.test(message)
    ? 'RECOVERABLE_REMOTE_IO_FAILED'
    : 'RECOVERABLE_LOCAL_STEP_FAILED';
  return {
    code,
    message: message.replace(/\s+/g, ' ').slice(0, 500),
  };
}
