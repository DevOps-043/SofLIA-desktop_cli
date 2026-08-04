import crypto from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import * as path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ReadableStream as NodeReadableStream } from 'node:stream/web';

const MAX_RENDER_ASSET_BYTES = 750 * 1024 * 1024;
const MAX_TOTAL_RENDER_ASSET_BYTES = 2 * 1024 * 1024 * 1024;
const ASSET_DOWNLOAD_TIMEOUT_MS = 60_000;
const ASSET_DOWNLOAD_ATTEMPTS = 2;

const ALLOWED_EXTENSIONS = new Set([
  '.aac',
  '.gif',
  '.jpeg',
  '.jpg',
  '.m4a',
  '.mov',
  '.mp3',
  '.mp4',
  '.ogg',
  '.otf',
  '.png',
  '.svg',
  '.ttf',
  '.wav',
  '.webm',
  '.webp',
  '.woff',
  '.woff2',
]);

const CONTENT_TYPE_EXTENSIONS: Array<[RegExp, string]> = [
  [/^audio\/aac\b/i, '.aac'],
  [/^audio\/mpeg\b/i, '.mp3'],
  [/^audio\/mp4\b/i, '.m4a'],
  [/^audio\/ogg\b/i, '.ogg'],
  [/^audio\/wav\b/i, '.wav'],
  [/^font\/otf\b/i, '.otf'],
  [/^font\/ttf\b/i, '.ttf'],
  [/^font\/woff2\b/i, '.woff2'],
  [/^font\/woff\b/i, '.woff'],
  [/^image\/gif\b/i, '.gif'],
  [/^image\/jpeg\b/i, '.jpg'],
  [/^image\/png\b/i, '.png'],
  [/^image\/svg\+xml\b/i, '.svg'],
  [/^image\/webp\b/i, '.webp'],
  [/^text\/css\b/i, '.css'],
  [/^video\/mp4\b/i, '.mp4'],
  [/^video\/quicktime\b/i, '.mov'],
  [/^video\/webm\b/i, '.webm'],
];

type FetchLike = typeof fetch;

interface AssetReference {
  url: string;
  assign(localUrl: string): void;
}

interface LocalAsset {
  id: string;
  localPath: string;
  contentType: string;
}

export interface PreparedRenderAssets {
  resolvedProps: Record<string, unknown>;
  assetCount: number;
  assetBytes: number;
  close(): Promise<void>;
}

export async function prepareRenderAssetsForJob(params: {
  jobId: string;
  outputDir: string;
  resolvedProps: Record<string, unknown>;
  fetchImpl?: FetchLike;
}): Promise<PreparedRenderAssets> {
  const props = structuredClone(params.resolvedProps);
  const references = collectRenderAssetReferences(props);
  const remoteReferences = references.filter((reference) => isRemoteHttpUrl(reference.url));

  validateUnsupportedSchemes(references);

  if (remoteReferences.length === 0) {
    return {
      resolvedProps: props,
      assetCount: 0,
      assetBytes: 0,
      close: async () => undefined,
    };
  }

  const assetsDir = path.join(params.outputDir, 'assets');
  await fsp.mkdir(assetsDir, { recursive: true });

  const fetchImpl = params.fetchImpl ?? fetch;
  const downloadedByUrl = new Map<string, LocalAsset>();
  let assetBytes = 0;

  for (const reference of remoteReferences) {
    const cached = downloadedByUrl.get(reference.url);
    if (cached) continue;

    const asset = await downloadRenderAsset({
      url: reference.url,
      assetsDir,
      fetchImpl,
      currentTotalBytes: assetBytes,
    });
    assetBytes += (await fsp.stat(asset.localPath)).size;
    downloadedByUrl.set(reference.url, asset);
  }

  const server = await startLocalAssetServer({
    assets: [...downloadedByUrl.values()],
    token: crypto.randomBytes(24).toString('hex'),
  });

  for (const reference of remoteReferences) {
    const asset = downloadedByUrl.get(reference.url);
    if (!asset) continue;
    reference.assign(server.urlFor(asset.id));
  }

  return {
    resolvedProps: props,
    assetCount: downloadedByUrl.size,
    assetBytes,
    close: server.close,
  };
}

function collectRenderAssetReferences(props: Record<string, unknown>): AssetReference[] {
  const references: AssetReference[] = [];
  const mutableProps = props as Record<string, unknown>;

  collectStringProperty(mutableProps, 'voiceAudioUrl', references);
  collectStringProperty(mutableProps, 'bgMusicUrl', references);
  collectStringProperty(mutableProps, 'avatarVideoUrl', references);

  for (const clip of readObjectArray(mutableProps.avatarClips)) {
    collectStringProperty(clip, 'url', references);
  }

  for (const clip of readObjectArray(mutableProps.brollClips)) {
    collectStringProperty(clip, 'url', references);
  }

  for (const slide of readObjectArray(mutableProps.slides)) {
    collectStringProperty(slide, 'url', references);
  }

  for (const font of readObjectArray(mutableProps.deckFonts)) {
    collectStringProperty(font, 'href', references);
  }

  return references;
}

function collectStringProperty(
  target: Record<string, unknown>,
  key: string,
  references: AssetReference[],
) {
  const value = target[key];
  if (typeof value !== 'string' || value.trim().length === 0) return;

  references.push({
    url: value.trim(),
    assign(localUrl) {
      target[key] = localUrl;
    },
  });
}

function readObjectArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
}

function validateUnsupportedSchemes(references: AssetReference[]) {
  for (const reference of references) {
    let parsed: URL;
    try {
      parsed = new URL(reference.url);
    } catch {
      continue;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`RENDER_ASSET_UNSUPPORTED_URL_SCHEME: ${parsed.protocol}`);
    }
  }
}

function isRemoteHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

async function downloadRenderAsset(params: {
  url: string;
  assetsDir: string;
  fetchImpl: FetchLike;
  currentTotalBytes: number;
}): Promise<LocalAsset> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= ASSET_DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      return await downloadRenderAssetOnce(params);
    } catch (error) {
      lastError = error;
      if (attempt >= ASSET_DOWNLOAD_ATTEMPTS) break;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function downloadRenderAssetOnce(params: {
  url: string;
  assetsDir: string;
  fetchImpl: FetchLike;
  currentTotalBytes: number;
}): Promise<LocalAsset> {
  const response = await params.fetchImpl(params.url, {
    signal: AbortSignal.timeout(ASSET_DOWNLOAD_TIMEOUT_MS),
  });

  if (!response.ok || !response.body) {
    throw new Error(`RENDER_ASSET_DOWNLOAD_FAILED: HTTP ${response.status}`);
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RENDER_ASSET_BYTES) {
    throw new Error('RENDER_ASSET_TOO_LARGE');
  }
  if (Number.isFinite(contentLength) && params.currentTotalBytes + contentLength > MAX_TOTAL_RENDER_ASSET_BYTES) {
    throw new Error('RENDER_ASSET_TOTAL_TOO_LARGE');
  }

  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream';
  const extension = resolveAssetExtension(params.url, contentType);
  if (!ALLOWED_EXTENSIONS.has(extension) && extension !== '.css') {
    throw new Error(`RENDER_ASSET_UNSUPPORTED_TYPE: ${contentType || extension}`);
  }

  const id = `${crypto.createHash('sha256').update(params.url).digest('hex').slice(0, 24)}${extension}`;
  const localPath = path.join(params.assetsDir, id);
  const resolvedAssetsDir = path.resolve(params.assetsDir);
  const resolvedLocalPath = path.resolve(localPath);
  if (!resolvedLocalPath.startsWith(resolvedAssetsDir + path.sep)) {
    throw new Error('RENDER_ASSET_PATH_TRAVERSAL');
  }

  let downloadedBytes = 0;
  const byteLimit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      downloadedBytes += chunk.length;
      if (downloadedBytes > MAX_RENDER_ASSET_BYTES) {
        callback(new Error('RENDER_ASSET_TOO_LARGE'));
        return;
      }
      if (params.currentTotalBytes + downloadedBytes > MAX_TOTAL_RENDER_ASSET_BYTES) {
        callback(new Error('RENDER_ASSET_TOTAL_TOO_LARGE'));
        return;
      }
      callback(null, chunk);
    },
  });

  await pipeline(
    Readable.fromWeb(response.body as NodeReadableStream),
    byteLimit,
    createWriteStream(localPath),
  );

  return {
    id,
    localPath,
    contentType,
  };
}

function resolveAssetExtension(url: string, contentType: string): string {
  const pathname = safeUrlPathname(url);
  const extension = path.extname(pathname).toLowerCase();
  if (ALLOWED_EXTENSIONS.has(extension) || extension === '.css') return extension;

  const contentTypeExtension = CONTENT_TYPE_EXTENSIONS.find(([pattern]) => pattern.test(contentType))?.[1];
  return contentTypeExtension ?? extension;
}

function safeUrlPathname(value: string): string {
  try {
    return new URL(value).pathname;
  } catch {
    return '';
  }
}

async function startLocalAssetServer(params: {
  assets: LocalAsset[];
  token: string;
}): Promise<{ close(): Promise<void>; urlFor(id: string): string }> {
  const assetById = new Map(params.assets.map((asset) => [asset.id, asset] as const));
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
    const parts = requestUrl.pathname.split('/').filter(Boolean);
    const [, token, assetId] = parts;

    if (request.method !== 'GET' || parts[0] !== 'assets' || token !== params.token || !assetId) {
      response.writeHead(404).end();
      return;
    }

    const asset = assetById.get(assetId);
    if (!asset) {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(200, {
      'content-type': asset.contentType,
      'cache-control': 'no-store',
    });
    createReadStream(asset.localPath).pipe(response);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('RENDER_ASSET_SERVER_BIND_FAILED');
  }

  return {
    urlFor(id: string) {
      return `http://127.0.0.1:${address.port}/assets/${params.token}/${encodeURIComponent(id)}`;
    },
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
