import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import JSZip from 'jszip';
import { downloadAndExtractBundle } from '../bundle.js';
import { getWorkspaceDir } from '../paths.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function createZipBuffer(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('index.html', '<!doctype html><html><body><script src="./bundle.js"></script></body></html>');
  zip.file('bundle.js', 'export {};\n');
  zip.file('courseforge-remotion-template.json', JSON.stringify({ entryPoint: 'src/index.tsx' }));
  zip.file('src/index.tsx', 'export {};\n');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function createSourceZipBuffer(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('courseforge-remotion-template.json', JSON.stringify({ entryPoint: 'src/index.tsx' }));
  zip.file('src/index.tsx', 'export {};\n');
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

describe('downloadAndExtractBundle', () => {
  it('extracts a bundle when the SHA-256 hash matches', async () => {
    const zipBuffer = await createZipBuffer();
    const bundleHash = crypto.createHash('sha256').update(zipBuffer).digest('hex');

    globalThis.fetch = (async () => new Response(new Uint8Array(zipBuffer))) as typeof fetch;

    const bundleRoot = await downloadAndExtractBundle('https://example.test/template.zip', bundleHash, {
      requireSha256: true,
    });

    assert.equal(
      await fsp.readFile(path.join(bundleRoot, 'courseforge-remotion-template.json'), 'utf8'),
      JSON.stringify({ entryPoint: 'src/index.tsx' }),
    );
    assert.equal(await fsp.readFile(path.join(bundleRoot, 'index.html'), 'utf8'), '<!doctype html><html><body><script src="./bundle.js"></script></body></html>');
  });

  it('rejects a template bundle when the SHA-256 hash mismatches', async () => {
    const zipBuffer = await createZipBuffer();

    globalThis.fetch = (async () => new Response(new Uint8Array(zipBuffer))) as typeof fetch;

    await assert.rejects(
      () => downloadAndExtractBundle('https://example.test/template.zip', '0'.repeat(64), { requireSha256: true }),
      /Bundle hash mismatch/,
    );
  });

  it('rejects a source ZIP that has no compiled Remotion index.html', async () => {
    const zipBuffer = await createSourceZipBuffer();
    const bundleHash = crypto.createHash('sha256').update(zipBuffer).digest('hex');

    globalThis.fetch = (async () => new Response(new Uint8Array(zipBuffer))) as typeof fetch;

    await assert.rejects(
      () => downloadAndExtractBundle('https://example.test/template-source.zip', bundleHash, { requireSha256: true }),
      /REMOTION_BUNDLE_INVALID/,
    );
  });

  it('invalidates stale ready caches that are missing index.html', async () => {
    const zipBuffer = await createZipBuffer();
    const bundleHash = crypto.createHash('sha256').update(zipBuffer).digest('hex');
    const bundleRoot = path.join(getWorkspaceDir(), 'bundles', bundleHash);
    await fsp.rm(bundleRoot, { recursive: true, force: true });
    await fsp.mkdir(bundleRoot, { recursive: true });
    await fsp.writeFile(path.join(bundleRoot, '.ready'), new Date().toISOString());

    globalThis.fetch = (async () => new Response(new Uint8Array(zipBuffer))) as typeof fetch;

    const extractedRoot = await downloadAndExtractBundle('https://example.test/template.zip', bundleHash, {
      requireSha256: true,
    });

    assert.equal(extractedRoot, bundleRoot);
    assert.equal(
      await fsp.readFile(path.join(extractedRoot, 'index.html'), 'utf8'),
      '<!doctype html><html><body><script src="./bundle.js"></script></body></html>',
    );
  });
});
