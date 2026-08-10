import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { LocalJobRecord, LocalJobType } from './local-job-state.js';
import { getWorkspaceDir } from './paths.js';

const JOB_WORKSPACE_DIRS: Record<LocalJobType, string> = {
  render: 'renders',
  template_build: 'template-builds',
  template_preview: 'template-previews',
};

const STARTUP_STALE_WORKSPACE_AGE_MS = 24 * 60 * 60 * 1000;

export interface JobWorkspaceCleanupResult {
  deleted: boolean;
  skippedReason?: string;
}

export class JobWorkspaceCleanupService {
  constructor(private readonly workspaceDir = getWorkspaceDir()) {}

  async cleanupJobWorkspace(params: {
    jobId: string;
    jobType: LocalJobType;
    jobRecord?: LocalJobRecord | null;
    force?: boolean;
  }): Promise<JobWorkspaceCleanupResult> {
    if (!params.force && shouldPreserveWorkspaceForRecovery(params.jobRecord)) {
      return { deleted: false, skippedReason: 'recoverable_artifact' };
    }

    const workspacePath = this.resolveJobWorkspacePath(params.jobType, params.jobId);
    await fsp.rm(workspacePath, { recursive: true, force: true });
    return { deleted: true };
  }

  async cleanupStaleTransientWorkspaces(params: {
    activeJobIds?: Iterable<string>;
    staleAgeMs?: number;
  } = {}): Promise<{ deletedCount: number; skippedCount: number }> {
    const activeJobIds = new Set(params.activeJobIds || []);
    const staleAgeMs = Math.max(60_000, params.staleAgeMs ?? STARTUP_STALE_WORKSPACE_AGE_MS);
    let deletedCount = 0;
    let skippedCount = 0;

    for (const jobType of Object.keys(JOB_WORKSPACE_DIRS) as LocalJobType[]) {
      const root = path.join(this.workspaceDir, JOB_WORKSPACE_DIRS[jobType]);
      const entries = await fsp.readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          skippedCount += 1;
          continue;
        }
        if (activeJobIds.has(entry.name)) {
          skippedCount += 1;
          continue;
        }

        const candidate = this.resolveJobWorkspacePath(jobType, entry.name);
        const stat = await fsp.stat(candidate).catch(() => null);
        if (!stat || Date.now() - stat.mtimeMs < staleAgeMs) {
          skippedCount += 1;
          continue;
        }

        await fsp.rm(candidate, { recursive: true, force: true });
        deletedCount += 1;
      }
    }

    return { deletedCount, skippedCount };
  }

  /** Removes every job workspace under the worker-owned roots. */
  async cleanupAllJobWorkspaces(): Promise<{ deletedCount: number; skippedCount: number }> {
    let deletedCount = 0;
    let skippedCount = 0;

    for (const jobType of Object.keys(JOB_WORKSPACE_DIRS) as LocalJobType[]) {
      const root = path.resolve(this.workspaceDir, JOB_WORKSPACE_DIRS[jobType]);
      const entries = await fsp.readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          skippedCount += 1;
          continue;
        }
        const candidate = this.resolveJobWorkspacePath(jobType, entry.name);
        await fsp.rm(candidate, { recursive: true, force: true });
        deletedCount += 1;
      }
    }
    return { deletedCount, skippedCount };
  }

  resolveJobWorkspacePath(jobType: LocalJobType, jobId: string): string {
    const baseName = sanitizeJobWorkspaceBaseName(jobId);
    const root = path.resolve(this.workspaceDir, JOB_WORKSPACE_DIRS[jobType]);
    const workspacePath = path.resolve(root, baseName);
    const relativePath = path.relative(root, workspacePath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new Error('JOB_WORKSPACE_CLEANUP_OUTSIDE_ROOT');
    }
    return workspacePath;
  }
}

function shouldPreserveWorkspaceForRecovery(job: LocalJobRecord | null | undefined): boolean {
  if (!job?.artifactPath || !job.artifactChecksum) return false;
  return [
    'artifact_ready',
    'upload_failed',
    'uploaded_pending_complete',
    'confirm_failed',
    'remote_confirmed_pending_cleanup',
  ].includes(job.localStatus);
}

function sanitizeJobWorkspaceBaseName(jobId: string): string {
  const trimmed = jobId.trim();
  if (!/^[a-zA-Z0-9._-]{1,160}$/.test(trimmed)) {
    throw new Error('JOB_WORKSPACE_INVALID_JOB_ID');
  }
  return trimmed;
}
