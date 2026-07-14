import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getAppDataDir } from '../paths.js';

describe('paths', () => {
  it('uses APPDATA on Windows', () => {
    assert.equal(
      getAppDataDir('win32', { APPDATA: 'C:\\Users\\Demo\\AppData\\Roaming' }),
      'C:\\Users\\Demo\\AppData\\Roaming\\SofLIA Engine Render Worker',
    );
  });

  it('uses XDG config on Linux', () => {
    const dir = getAppDataDir('linux', { XDG_CONFIG_HOME: '/tmp/config' });

    assert.equal(dir.endsWith('soflia-engine-render-worker'), true);
    assert.equal(dir.includes('config'), true);
  });

  it('uses Application Support on macOS', () => {
    const dir = getAppDataDir('darwin', {});

    assert.equal(dir.endsWith('/Library/Application Support/SofLIA Engine Render Worker'), true);
  });
});
