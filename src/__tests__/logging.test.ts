import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { getErrorLogPath, getWorkerLogPath, log, logError, sanitizeLog } from '../logging.js';

const originalAppData = process.env.APPDATA;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

afterEach(() => {
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
});

describe('sanitizeLog', () => {
  it('redacts worker tokens and signed URL tokens', () => {
    const sanitized = sanitizeLog('Bearer swk_secret123 SLIA-482913 https://x.test/file?token=abc&expires=123');

    assert.equal(sanitized.includes('swk_secret123'), false);
    assert.equal(sanitized.includes('SLIA-482913'), false);
    assert.equal(sanitized.includes('token=abc'), false);
    assert.equal(sanitized.includes('[redacted]'), true);
  });

  it('writes worker and error logs under the app data logs directory', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'soflia-logs-'));
    process.env.APPDATA = tempDir;
    process.env.XDG_CONFIG_HOME = tempDir;

    log('Worker activo', { jobId: 'job-1' });
    logError('Fallo de prueba:', new Error('Bearer swk_secret123 no debe persistir'));

    const workerLog = await fs.readFile(getWorkerLogPath(), 'utf8');
    const errorLog = await fs.readFile(getErrorLogPath(), 'utf8');

    assert.match(getWorkerLogPath(), /logs[\\/]worker\.log$/);
    assert.match(getErrorLogPath(), /logs[\\/]error\.log$/);
    assert.match(workerLog, /Worker activo/);
    assert.match(workerLog, /Fallo de prueba/);
    assert.match(errorLog, /Fallo de prueba/);
    assert.equal(errorLog.includes('swk_secret123'), false);
    assert.equal(errorLog.includes('[redacted]'), true);
  });
});
