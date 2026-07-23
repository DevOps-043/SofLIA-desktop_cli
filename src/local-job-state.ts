export type LocalJobType = 'render' | 'template_build' | 'template_preview';

export type LocalJobRemoteTable =
  | 'production_jobs'
  | 'remotion_template_builds'
  | 'remotion_template_previews';

export type LocalJobStatus =
  | 'claimed'
  | 'running'
  | 'artifact_ready'
  | 'uploading'
  | 'upload_failed'
  | 'uploaded_pending_complete'
  | 'confirm_failed'
  | 'remote_confirmed'
  | 'remote_confirmed_pending_cleanup'
  | 'completed_local'
  | 'failed_non_recoverable';

export type LocalCleanupPolicy = 'delete_on_remote_confirm' | 'keep_all';

export type LocalCleanupStatus =
  | 'not_ready'
  | 'pending'
  | 'deleted'
  | 'retained_by_policy'
  | 'cleanup_failed';

export interface LocalJobRecord {
  jobId: string;
  jobType: LocalJobType;
  remoteTable: LocalJobRemoteTable;
  localStatus: LocalJobStatus;
  stage: string;
  bundleHash?: string;
  propsHash?: string;
  outputStoragePath?: string;
  artifactPath?: string;
  artifactChecksum?: string;
  artifactSizeBytes?: number;
  durationSeconds?: number;
  retryCount: number;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  remoteConfirmedAt?: string;
  cleanupPolicy: LocalCleanupPolicy;
  cleanupStatus: LocalCleanupStatus;
  createdAt: string;
  updatedAt: string;
}

export interface LocalRecoverySummary {
  pendingUploads: number;
  pendingCompletes: number;
  pendingCleanup: number;
  retainedBytes: number;
}

export function localJobTypeToRemoteTable(jobType: LocalJobType): LocalJobRemoteTable {
  if (jobType === 'template_build') return 'remotion_template_builds';
  if (jobType === 'template_preview') return 'remotion_template_previews';
  return 'production_jobs';
}

export function normalizeLocalRetentionPolicy(value: unknown): LocalCleanupPolicy {
  return value === 'keep_all' ? 'keep_all' : 'delete_on_remote_confirm';
}
