import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { LocalJobRecord } from './local-job-state.js';
import { getWorkspaceDir } from './paths.js';
import { LocalJobStore } from './local-job-store.js';

export class LocalArtifactRetentionService {
  constructor(
    private readonly store: LocalJobStore,
    private readonly workspaceDir = getWorkspaceDir(),
  ) {}

  async applyRetention(job: LocalJobRecord): Promise<'deleted' | 'retained' | 'skipped'> {
    if (job.cleanupStatus === 'retained_by_policy') return 'retained';
    if (job.cleanupStatus !== 'pending' && job.cleanupStatus !== 'cleanup_failed') return 'skipped';
    if (job.cleanupPolicy === 'keep_all') {
      this.store.markCleanupRetained(job.jobId);
      return 'retained';
    }
    if (!job.artifactPath) {
      this.store.markCleanupDeleted(job.jobId);
      return 'deleted';
    }

    const target = resolveSafeArtifactDeleteTarget(job.artifactPath, this.workspaceDir);
    try {
      await fsp.rm(target, { recursive: true, force: true });
      this.store.markCleanupDeleted(job.jobId);
      return 'deleted';
    } catch (error) {
      this.store.markCleanupFailed(job.jobId, error);
      return 'skipped';
    }
  }
}

function resolveSafeArtifactDeleteTarget(artifactPath: string, workspaceRoot: string): string {
  const workspaceDir = path.resolve(workspaceRoot);
  const resolvedArtifactPath = path.resolve(artifactPath);
  const relative = path.relative(workspaceDir, resolvedArtifactPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('ARTIFACT_DELETE_OUTSIDE_WORKSPACE');
  }

  const pathParts = relative.split(path.sep);
  if (!['renders', 'template-builds', 'template-previews'].includes(pathParts[0] || '')) {
    throw new Error('ARTIFACT_DELETE_UNSUPPORTED_DIRECTORY');
  }

  return pathParts.length > 1
    ? path.join(workspaceDir, pathParts[0], pathParts[1])
    : resolvedArtifactPath;
}
