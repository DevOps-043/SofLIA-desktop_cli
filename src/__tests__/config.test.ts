import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { loadConfig, saveConfig, saveConfigSettings } from '../config.js';
import { configureWritableWorkingDirectory, getWorkspaceDir } from '../paths.js';

const originalAppData = process.env.APPDATA;
const originalCwd = process.cwd();
let tempRoot = '';

beforeEach(async () => {
  tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'soflia-worker-config-'));
  process.env.APPDATA = tempRoot;
});

afterEach(async () => {
  if (originalAppData === undefined) {
    delete process.env.APPDATA;
  } else {
    process.env.APPDATA = originalAppData;
  }
  process.chdir(originalCwd);
  await fsp.rm(tempRoot, { recursive: true, force: true });
});

describe('worker config', () => {
  it('persists power profile settings without removing the worker link', async () => {
    await saveConfig({
      apiUrl: 'http://localhost:3000',
      token: 'swk_secret',
    });

    await saveConfigSettings({ powerProfile: 'high' });
    const config = await loadConfig();

    assert.equal(config.apiUrl, 'http://localhost:3000');
    assert.equal(config.token, 'swk_secret');
    assert.equal(config.powerProfile, 'high');
    assert.equal(config.maxConcurrentJobs, 4);
    assert.equal(config.renderConcurrency, 4);
  });

  it('moves the process cwd to the user workspace for Remotion browser cache writes', async () => {
    const workspace = getWorkspaceDir();

    const configuredWorkspace = configureWritableWorkingDirectory();

    assert.equal(configuredWorkspace, workspace);
    assert.equal(process.cwd(), workspace);
    await fsp.access(workspace);
  });
});
