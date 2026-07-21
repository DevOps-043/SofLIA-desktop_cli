import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { loadConfig, saveConfig, saveConfigSettings } from '../config.js';

const originalAppData = process.env.APPDATA;
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
});
