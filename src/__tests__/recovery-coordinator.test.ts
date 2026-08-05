import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { localJobTypeToRemoteTable } from '../local-job-state.js';
import { LocalJobStore } from '../local-job-store.js';
import { getWorkspaceDir } from '../paths.js';
import { RecoveryCoordinator } from '../recovery-coordinator.js';

let tempRoot = '';
let originalFetch: typeof fetch;
let originalAppData: string | undefined;
let originalXdgConfigHome: string | undefined;

beforeEach(async () => {
  tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'soflia-worker-recovery-'));
  originalFetch = globalThis.fetch;
  originalAppData = process.env.APPDATA;
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.APPDATA = tempRoot;
  process.env.XDG_CONFIG_HOME = tempRoot;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalAppData === undefined) {
    delete process.env.APPDATA;
  } else {
    process.env.APPDATA = originalAppData;
  }
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
  await fsp.rm(tempRoot, { recursive: true, force: true });
});

function createTestStore() {
  return new LocalJobStore(path.join(tempRoot, 'state', 'worker-state.db'));
}

describe('RecoveryCoordinator', () => {
  it('uploads recoverable artifacts before applying cleanup retention', async () => {
    const store = createTestStore();
    await store.initialize();
    const artifactDir = path.join(getWorkspaceDir(), 'renders', 'recoverable-job');
    const artifactPath = path.join(artifactDir, 'output.mp4');
    await fsp.mkdir(artifactDir, { recursive: true });
    await fsp.writeFile(artifactPath, 'video');

    store.upsertClaimedJob({
      jobId: 'recoverable-job',
      jobType: 'render',
      remoteTable: localJobTypeToRemoteTable('render'),
      localStatus: 'claimed',
      stage: 'claim',
      cleanupPolicy: 'delete_on_remote_confirm',
      outputStoragePath: 'completed/recoverable-job.mp4',
    });
    store.markArtifactReady({
      jobId: 'recoverable-job',
      artifactPath,
      artifactChecksum: 'a'.repeat(64),
      artifactSizeBytes: 5,
      outputStoragePath: 'completed/recoverable-job.mp4',
    });

    let uploadCount = 0;
    let completeCount = 0;
    globalThis.fetch = async () => {
      uploadCount += 1;
      return new Response(null, { status: 200 });
    };

    const recovery = new RecoveryCoordinator(store, {
      refreshUploadUrl: async () => ({
        uploadUrl: 'https://example.test/upload',
        outputStoragePath: 'completed/recoverable-job.mp4',
      }),
      complete: async () => {
        completeCount += 1;
      },
    });

    const summary = await recovery.recoverPendingJobs();

    assert.equal(uploadCount, 1);
    assert.equal(completeCount, 1);
    assert.deepEqual(summary, {
      pendingUploads: 0,
      pendingCompletes: 0,
      pendingCleanup: 0,
      retainedBytes: 0,
    });
    await assert.rejects(() => fsp.access(artifactDir));

    store.close();
  });
});
