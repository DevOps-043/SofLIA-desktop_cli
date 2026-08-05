import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { JobWorkspaceCleanupService } from '../job-workspace-cleanup.js';
import type { LocalJobRecord } from '../local-job-state.js';

let tempRoot = '';

beforeEach(async () => {
  tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'soflia-worker-cleanup-'));
});

afterEach(async () => {
  await fsp.rm(tempRoot, { recursive: true, force: true });
});

function createJobRecord(overrides: Partial<LocalJobRecord> = {}): LocalJobRecord {
  return {
    jobId: 'job-1',
    jobType: 'render',
    remoteTable: 'production_jobs',
    localStatus: 'failed_non_recoverable',
    stage: 'failed_non_recoverable',
    retryCount: 0,
    cleanupPolicy: 'delete_on_remote_confirm',
    cleanupStatus: 'not_ready',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('JobWorkspaceCleanupService', () => {
  it('deletes a non-recoverable render workspace', async () => {
    const service = new JobWorkspaceCleanupService(tempRoot);
    const workspace = path.join(tempRoot, 'renders', 'job-1');
    await fsp.mkdir(path.join(workspace, 'assets'), { recursive: true });
    await fsp.writeFile(path.join(workspace, 'assets', 'clip.mp4'), 'partial-video');

    const result = await service.cleanupJobWorkspace({
      jobId: 'job-1',
      jobType: 'render',
      jobRecord: createJobRecord(),
    });

    assert.equal(result.deleted, true);
    await assert.rejects(() => fsp.access(workspace));
  });

  it('preserves a workspace while its artifact can still be recovered', async () => {
    const service = new JobWorkspaceCleanupService(tempRoot);
    const workspace = path.join(tempRoot, 'renders', 'job-2');
    const artifactPath = path.join(workspace, 'output.mp4');
    await fsp.mkdir(workspace, { recursive: true });
    await fsp.writeFile(artifactPath, 'video');

    const result = await service.cleanupJobWorkspace({
      jobId: 'job-2',
      jobType: 'render',
      jobRecord: createJobRecord({
        jobId: 'job-2',
        localStatus: 'upload_failed',
        stage: 'upload_failed',
        artifactPath,
        artifactChecksum: 'a'.repeat(64),
        cleanupStatus: 'pending',
      }),
    });

    assert.equal(result.deleted, false);
    assert.equal(result.skippedReason, 'recoverable_artifact');
    await fsp.access(artifactPath);
  });

  it('rejects unsafe job ids before resolving a cleanup target', async () => {
    const service = new JobWorkspaceCleanupService(tempRoot);

    await assert.rejects(
      () => service.cleanupJobWorkspace({
        jobId: '../outside',
        jobType: 'render',
        force: true,
      }),
      /JOB_WORKSPACE_INVALID_JOB_ID/,
    );
  });

  it('removes stale untracked workspaces on startup cleanup', async () => {
    const service = new JobWorkspaceCleanupService(tempRoot);
    const staleWorkspace = path.join(tempRoot, 'renders', 'old-job');
    const activeWorkspace = path.join(tempRoot, 'renders', 'active-job');
    await fsp.mkdir(staleWorkspace, { recursive: true });
    await fsp.mkdir(activeWorkspace, { recursive: true });

    const oldDate = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fsp.utimes(staleWorkspace, oldDate, oldDate);

    const result = await service.cleanupStaleTransientWorkspaces({
      activeJobIds: ['active-job'],
      staleAgeMs: 60_000,
    });

    assert.equal(result.deletedCount, 1);
    await assert.rejects(() => fsp.access(staleWorkspace));
    await fsp.access(activeWorkspace);
  });
});
