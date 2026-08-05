import assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { getWorkspaceDir } from '../paths.js';
import { prepareRenderAssetsForJob, type LocalMediaProbe } from '../render-asset-preparer.js';

const createdDirs: string[] = [];

afterEach(async () => {
  await Promise.all(createdDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

function createOutputDir(name: string) {
  const outputDir = path.join(getWorkspaceDir(), 'renders', `asset-preparer-${name}-${Date.now()}`);
  createdDirs.push(outputDir);
  return outputDir;
}

const successfulMediaProbe: LocalMediaProbe = async () => ({ durationSeconds: 1 });

describe('render asset preparer', () => {
  it('downloads known render asset URLs and rewrites props to the local asset server', async () => {
    const outputDir = createOutputDir('rewrite');
    const requestedUrls: string[] = [];
    const prepared = await prepareRenderAssetsForJob({
      jobId: 'job-1',
      outputDir,
      resolvedProps: {
        voiceAudioUrl: 'https://cdn.example.test/voice.mp3',
        avatarVideoUrl: 'https://cdn.example.test/avatar.mp4',
        avatarClips: [{ url: 'https://cdn.example.test/avatar-scene.mp4', order: 1 }],
        brollClips: [{ url: 'https://cdn.example.test/broll.mp4', order: 1 }],
        slides: [{ kind: 'image', url: 'https://cdn.example.test/slide.png', index: 0 }],
        deckFonts: [{ family: 'Inter', href: 'https://fonts.example.test/inter.css' }],
      },
      fetchImpl: (async (url) => {
        const source = String(url);
        requestedUrls.push(source);
        const body = source.endsWith('.png')
          ? new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
          : new Uint8Array([1, 2, 3]);
        const contentType = source.endsWith('.css')
          ? 'text/css'
          : source.endsWith('.png')
            ? 'image/png'
            : source.endsWith('.mp3')
              ? 'audio/mpeg'
              : 'video/mp4';
        return new Response(body, {
          status: 200,
          headers: {
            'content-length': String(body.byteLength),
            'content-type': contentType,
          },
        });
      }) as typeof fetch,
      mediaProbe: successfulMediaProbe,
    });

    try {
      const props = prepared.resolvedProps as any;
      assert.equal(prepared.assetCount, 6);
      assert.equal(prepared.assetBytes, 23);
      assert.equal(requestedUrls.length, 6);
      assert.match(props.avatarVideoUrl, /^http:\/\/127\.0\.0\.1:\d+\/assets\/[a-f0-9]+\//);
      assert.match(props.avatarClips[0].url, /^http:\/\/127\.0\.0\.1:\d+\/assets\/[a-f0-9]+\//);
      assert.match(props.brollClips[0].url, /^http:\/\/127\.0\.0\.1:\d+\/assets\/[a-f0-9]+\//);
      assert.match(props.slides[0].url, /^http:\/\/127\.0\.0\.1:\d+\/assets\/[a-f0-9]+\//);
      assert.match(props.deckFonts[0].href, /^http:\/\/127\.0\.0\.1:\d+\/assets\/[a-f0-9]+\//);

      const response = await fetch(props.avatarVideoUrl);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('accept-ranges'), 'bytes');
      assert.equal(response.headers.get('content-length'), '3');
      assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3]);

      const headResponse = await fetch(props.avatarVideoUrl, { method: 'HEAD' });
      assert.equal(headResponse.status, 200);
      assert.equal(headResponse.headers.get('content-length'), '3');
      assert.equal((await headResponse.arrayBuffer()).byteLength, 0);

      const rangeResponse = await fetch(props.avatarVideoUrl, {
        headers: { range: 'bytes=1-2' },
      });
      assert.equal(rangeResponse.status, 206);
      assert.equal(rangeResponse.headers.get('content-range'), 'bytes 1-2/3');
      assert.equal(rangeResponse.headers.get('content-length'), '2');
      assert.deepEqual([...new Uint8Array(await rangeResponse.arrayBuffer())], [2, 3]);
    } finally {
      await prepared.close();
    }
  });

  it('accepts chunked responses without content-length and validates the downloaded bytes', async () => {
    const outputDir = createOutputDir('chunked');
    const prepared = await prepareRenderAssetsForJob({
      jobId: 'job-chunked',
      outputDir,
      resolvedProps: {
        avatarVideoUrl: 'https://cdn.example.test/avatar.mp4',
      },
      fetchImpl: (async () => new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      })) as typeof fetch,
      mediaProbe: successfulMediaProbe,
    });

    try {
      assert.equal(prepared.assetCount, 1);
      assert.equal(prepared.assetBytes, 3);
    } finally {
      await prepared.close();
    }
  });

  it('infers a media content type from a known extension when storage returns octet-stream', async () => {
    const outputDir = createOutputDir('content-type');
    let probedContentType: string | undefined;
    const prepared = await prepareRenderAssetsForJob({
      jobId: 'job-content-type',
      outputDir,
      resolvedProps: {
        avatarVideoUrl: 'https://cdn.example.test/avatar.mp4',
      },
      fetchImpl: (async () => new Response(new Uint8Array([1]), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      })) as typeof fetch,
      mediaProbe: async (asset) => {
        probedContentType = asset.contentType;
        return { durationSeconds: 1 };
      },
    });

    try {
      assert.equal(probedContentType, 'video/mp4');
      const props = prepared.resolvedProps as any;
      const response = await fetch(props.avatarVideoUrl);
      assert.equal(response.headers.get('content-type'), 'video/mp4');
    } finally {
      await prepared.close();
    }
  });

  it('deduplicates repeated remote asset URLs', async () => {
    const outputDir = createOutputDir('dedupe');
    let fetchCount = 0;
    const prepared = await prepareRenderAssetsForJob({
      jobId: 'job-2',
      outputDir,
      resolvedProps: {
        avatarVideoUrl: 'https://cdn.example.test/shared.mp4',
        avatarClips: [{ url: 'https://cdn.example.test/shared.mp4', order: 1 }],
      },
      fetchImpl: (async () => {
        fetchCount += 1;
        return new Response(new Uint8Array([4]), {
          status: 200,
          headers: {
            'content-length': '1',
            'content-type': 'video/mp4',
          },
        });
      }) as typeof fetch,
      mediaProbe: successfulMediaProbe,
    });

    try {
      const props = prepared.resolvedProps as any;
      assert.equal(fetchCount, 1);
      assert.equal(prepared.assetCount, 1);
      assert.equal(props.avatarVideoUrl, props.avatarClips[0].url);
    } finally {
      await prepared.close();
    }
  });

  it('rejects unsafe URL schemes in render asset fields', async () => {
    await assert.rejects(
      () => prepareRenderAssetsForJob({
        jobId: 'job-3',
        outputDir: createOutputDir('unsafe'),
        resolvedProps: {
          avatarVideoUrl: 'file:///C:/secret.mp4',
        },
        fetchImpl: (async () => {
          throw new Error('fetch should not run');
        }) as typeof fetch,
      }),
      /RENDER_ASSET_UNSUPPORTED_URL_SCHEME/,
    );
  });

  it('requires the per-job token when serving prepared assets', async () => {
    const outputDir = createOutputDir('token');
    const prepared = await prepareRenderAssetsForJob({
      jobId: 'job-4',
      outputDir,
      resolvedProps: {
        avatarVideoUrl: 'https://cdn.example.test/avatar.mp4',
      },
      fetchImpl: (async () => new Response(new Uint8Array([7]), {
        status: 200,
        headers: {
          'content-length': '1',
          'content-type': 'video/mp4',
        },
      })) as typeof fetch,
      mediaProbe: successfulMediaProbe,
    });

    try {
      const props = prepared.resolvedProps as any;
      const blockedUrl = String(props.avatarVideoUrl).replace(/\/assets\/[^/]+\//, '/assets/wrong-token/');
      const response = await fetch(blockedUrl);
      assert.equal(response.status, 404);
    } finally {
      await prepared.close();
    }
  });

  it('rejects invalid or out-of-bounds byte ranges', async () => {
    const outputDir = createOutputDir('invalid-range');
    const prepared = await prepareRenderAssetsForJob({
      jobId: 'job-invalid-range',
      outputDir,
      resolvedProps: {
        avatarVideoUrl: 'https://cdn.example.test/avatar.mp4',
      },
      fetchImpl: (async () => new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          'content-length': '3',
          'content-type': 'video/mp4',
        },
      })) as typeof fetch,
      mediaProbe: successfulMediaProbe,
    });

    try {
      const props = prepared.resolvedProps as any;
      const response = await fetch(props.avatarVideoUrl, {
        headers: { range: 'bytes=4-5' },
      });
      assert.equal(response.status, 416);
      assert.equal(response.headers.get('content-range'), 'bytes */3');
    } finally {
      await prepared.close();
    }
  });

  it('rejects downloaded media when content-length does not match local bytes', async () => {
    await assert.rejects(
      () => prepareRenderAssetsForJob({
        jobId: 'job-5',
        outputDir: createOutputDir('incomplete'),
        resolvedProps: {
          avatarVideoUrl: 'https://cdn.example.test/avatar.mp4',
        },
        fetchImpl: (async () => new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: {
            'content-length': '4',
            'content-type': 'video/mp4',
          },
        })) as typeof fetch,
        mediaProbe: successfulMediaProbe,
      }),
      /RENDER_ASSET_INCOMPLETE: avatarVideoUrl/,
    );
  });

  it('rejects downloaded media when local metadata cannot be read', async () => {
    await assert.rejects(
      () => prepareRenderAssetsForJob({
        jobId: 'job-6',
        outputDir: createOutputDir('metadata-failed'),
        resolvedProps: {
          avatarClips: [{ url: 'https://cdn.example.test/avatar-scene.mp4', order: 1 }],
        },
        fetchImpl: (async () => new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: {
            'content-length': '3',
            'content-type': 'video/mp4',
          },
        })) as typeof fetch,
        mediaProbe: async () => {
          throw new Error('metadata failed');
        },
      }),
      /RENDER_ASSET_PREFLIGHT_FAILED: avatarClips\.1: metadata failed/,
    );
  });

  it('rejects a corrupt image before Remotion starts rendering', async () => {
    await assert.rejects(
      () => prepareRenderAssetsForJob({
        jobId: 'job-corrupt-image',
        outputDir: createOutputDir('corrupt-image'),
        resolvedProps: {
          slides: [{ kind: 'image', url: 'https://cdn.example.test/slide.png', index: 0 }],
        },
        fetchImpl: (async () => new Response(new TextEncoder().encode('<html>not an image</html>'), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })) as typeof fetch,
      }),
      /RENDER_ASSET_INVALID_SIGNATURE: slides\.1/,
    );
  });
});
