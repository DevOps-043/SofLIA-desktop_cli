import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { LocalArtifactRetentionService } from '../local-artifact-retention.js';
import { localJobTypeToRemoteTable } from '../local-job-state.js';
import { LocalJobStore } from '../local-job-store.js';

let tempRoot = '';

beforeEach(async () => {
  tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'soflia-worker-local-store-'));
});

afterEach(async () => {
  await fsp.rm(tempRoot, { recursive: true, force: true });
});

function createTestStore() {
  return new LocalJobStore(path.join(tempRoot, 'state', 'worker-state.db'));
}

function getTestWorkspaceDir() {
  return path.join(tempRoot, 'workspace');
}

describe('LocalJobStore', () => {
  it('tracks recoverable artifact state and recovery summary', async () => {
    const store = createTestStore();
    await store.initialize();

    store.upsertClaimedJob({
      jobId: 'job-1',
      jobType: 'render',
      remoteTable: localJobTypeToRemoteTable('render'),
      localStatus: 'claimed',
      stage: 'claim',
      cleanupPolicy: 'delete_on_remote_confirm',
      bundleHash: 'bundle',
      propsHash: 'props',
      outputStoragePath: 'completed/job-1.mp4',
    });
    store.markArtifactReady({
      jobId: 'job-1',
      artifactPath: path.join(getTestWorkspaceDir(), 'renders', 'job-1', 'output.mp4'),
      artifactChecksum: 'a'.repeat(64),
      artifactSizeBytes: 123,
      durationSeconds: 12,
    });

    const [job] = store.listRecoverableJobs();
    assert.equal(job?.jobId, 'job-1');
    assert.equal(job?.localStatus, 'artifact_ready');
    assert.deepEqual(store.getRecoverySummary(), {
      pendingUploads: 1,
      pendingCompletes: 0,
      pendingCleanup: 1,
      retainedBytes: 0,
    });

    store.close();
  });

  it('deletes confirmed artifacts when policy is delete_on_remote_confirm', async () => {
    const store = createTestStore();
    await store.initialize();
    const artifactDir = path.join(getTestWorkspaceDir(), 'renders', 'job-2');
    const artifactPath = path.join(artifactDir, 'output.mp4');
    await fsp.mkdir(artifactDir, { recursive: true });
    await fsp.writeFile(artifactPath, 'video');

    store.upsertClaimedJob({
      jobId: 'job-2',
      jobType: 'render',
      remoteTable: localJobTypeToRemoteTable('render'),
      localStatus: 'claimed',
      stage: 'claim',
      cleanupPolicy: 'delete_on_remote_confirm',
      outputStoragePath: 'completed/job-2.mp4',
    });
    store.markArtifactReady({
      jobId: 'job-2',
      artifactPath,
      artifactChecksum: 'b'.repeat(64),
      artifactSizeBytes: 5,
    });
    store.markRemoteConfirmed('job-2');

    const retention = new LocalArtifactRetentionService(store, getTestWorkspaceDir());
    const job = store.listRecoverableJobs().find((item) => item.jobId === 'job-2');
    assert.ok(job);
    assert.equal(await retention.applyRetention(job), 'deleted');
    await assert.rejects(() => fsp.access(artifactDir));

    store.close();
  });

  it('retains confirmed artifacts when policy is keep_all', async () => {
    const store = createTestStore();
    await store.initialize();
    const artifactDir = path.join(getTestWorkspaceDir(), 'renders', 'job-3');
    const artifactPath = path.join(artifactDir, 'output.mp4');
    await fsp.mkdir(artifactDir, { recursive: true });
    await fsp.writeFile(artifactPath, 'video');

    store.upsertClaimedJob({
      jobId: 'job-3',
      jobType: 'render',
      remoteTable: localJobTypeToRemoteTable('render'),
      localStatus: 'claimed',
      stage: 'claim',
      cleanupPolicy: 'keep_all',
      outputStoragePath: 'completed/job-3.mp4',
    });
    store.markArtifactReady({
      jobId: 'job-3',
      artifactPath,
      artifactChecksum: 'c'.repeat(64),
      artifactSizeBytes: 5,
    });
    store.markRemoteConfirmed('job-3');

    const retention = new LocalArtifactRetentionService(store, getTestWorkspaceDir());
    const job = store.listRecoverableJobs().find((item) => item.jobId === 'job-3');
    assert.ok(job);
    assert.equal(await retention.applyRetention(job), 'retained');
    await fsp.access(artifactPath);

    store.close();
  });
});
