import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('renderer assets', () => {
  it('packages the SofLIA logo with a file-relative renderer path', async () => {
    const rendererDir = path.join(__dirname, '..', 'renderer');
    await fsp.access(path.join(rendererDir, 'soflia-logo.png'));

    const assetDir = path.join(rendererDir, 'assets');
    const bundleNames = await fsp.readdir(assetDir);
    const jsBundles = bundleNames.filter((name) => name.endsWith('.js'));
    assert.notEqual(jsBundles.length, 0);

    const bundleContents = await Promise.all(
      jsBundles.map((name) => fsp.readFile(path.join(assetDir, name), 'utf8')),
    );

    const relativeLogoReference = /src:\s*["'`]\.\/soflia-logo\.png["'`]/;
    const absoluteLogoReference = /src:\s*["'`]\/soflia-logo\.png["'`]/;

    assert.equal(bundleContents.some((content) => relativeLogoReference.test(content)), true);
    assert.equal(bundleContents.some((content) => absoluteLogoReference.test(content)), false);
  });
});
