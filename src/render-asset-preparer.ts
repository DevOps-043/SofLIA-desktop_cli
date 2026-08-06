import crypto from 'node:crypto';
import { createWriteStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { startLocalAssetServer } from './render-asset-server.js';

const MAX_RENDER_ASSET_BYTES = 750 * 1024 * 1024;
const MAX_TOTAL_RENDER_ASSET_BYTES = 2 * 1024 * 1024 * 1024;
// The limit is intentionally based on inactivity, not total wall-clock time.
// Large videos can legitimately take several minutes on slower links as long as
// bytes keep arriving.
const ASSET_DOWNLOAD_IDLE_TIMEOUT_MS = 90_000;
const ASSET_DOWNLOAD_ATTEMPTS = 2;
const ASSET_DOWNLOAD_CONCURRENCY = 3;
const ASSET_PROGRESS_INTERVAL_MS = 5_000;
const ASSET_PROGRESS_BYTE_INTERVAL = 8 * 1024 * 1024;
const LOCAL_MEDIA_PREFLIGHT_TIMEOUT_MS = 30_000;

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

const EXTENSION_CONTENT_TYPES = new Map<string, string>([
  ['.aac', 'audio/aac'],
  ['.css', 'text/css'],
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.m4a', 'audio/mp4'],
  ['.mov', 'video/quicktime'],
  ['.mp3', 'audio/mpeg'],
  ['.mp4', 'video/mp4'],
  ['.ogg', 'audio/ogg'],
  ['.otf', 'font/otf'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.ttf', 'font/ttf'],
  ['.wav', 'audio/wav'],
  ['.webm', 'video/webm'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

type FetchLike = typeof fetch;

interface AssetReference {
  key: string;
  url: string;
  assign(localUrl: string): void;
}

interface LocalAsset {
  key: string;
  id: string;
  localPath: string;
  contentType: string;
  bytes: number;
  expectedBytes: number | null;
  attempt: number;
}

export interface LocalMediaProbeResult {
  durationSeconds: number;
}

export type LocalMediaProbe = (asset: {
  key: string;
  localPath: string;
  contentType: string;
}) => Promise<LocalMediaProbeResult>;

export interface RenderAssetPreparationProgress {
  phase: 'download_started' | 'download_progress' | 'download_completed' | 'validation_completed';
  assetKey: string;
  assetIndex: number;
  assetCount: number;
  attempt: number;
  downloadedBytes: number;
  expectedBytes: number | null;
  elapsedMs: number;
  bytesPerSecond: number | null;
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
  mediaProbe?: LocalMediaProbe;
  assetDownloadIdleTimeoutMs?: number;
  onProgress?: (event: RenderAssetPreparationProgress) => void;
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
  const mediaProbe = params.mediaProbe ?? probeLocalMediaAsset;
  const downloadedByUrl = new Map<string, LocalAsset>();
  const seenRemoteUrls = new Set<string>();
  const uniqueRemoteReferences = remoteReferences.filter((reference) => {
    if (seenRemoteUrls.has(reference.url)) return false;
    seenRemoteUrls.add(reference.url);
    return true;
  });
  const aggregateBudget = new AggregateDownloadBudget(MAX_TOTAL_RENDER_ASSET_BYTES);

  await runWithConcurrency(uniqueRemoteReferences, ASSET_DOWNLOAD_CONCURRENCY, async (reference, index) => {
    const assetIndex = index + 1;
    const asset = await downloadRenderAsset({
      url: reference.url,
      assetsDir,
      fetchImpl,
      aggregateBudget,
      key: reference.key,
      idleTimeoutMs: normalizeIdleTimeoutMs(params.assetDownloadIdleTimeoutMs),
      onProgress: (event) => params.onProgress?.({
        ...event,
        assetIndex,
        assetCount: uniqueRemoteReferences.length,
      }),
    });
    await validateDownloadedRenderAsset(asset, mediaProbe);
    params.onProgress?.({
      phase: 'validation_completed',
      assetKey: reference.key,
      assetIndex,
      assetCount: uniqueRemoteReferences.length,
      attempt: asset.attempt,
      downloadedBytes: asset.bytes,
      expectedBytes: asset.expectedBytes,
      elapsedMs: 0,
      bytesPerSecond: null,
    });
    downloadedByUrl.set(reference.url, asset);
  });

  const assetBytes = aggregateBudget.bytes;

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

  readObjectArray(mutableProps.avatarClips).forEach((clip, index) => {
    collectStringProperty(clip, 'url', references, `avatarClips.${index + 1}`);
  });

  readObjectArray(mutableProps.brollClips).forEach((clip, index) => {
    collectStringProperty(clip, 'url', references, `brollClips.${index + 1}`);
  });

  readObjectArray(mutableProps.slides).forEach((slide, index) => {
    collectStringProperty(slide, 'url', references, `slides.${index + 1}`);
  });

  readObjectArray(mutableProps.deckFonts).forEach((font, index) => {
    collectStringProperty(font, 'href', references, `deckFonts.${index + 1}`);
  });
  return references;
}

function collectStringProperty(
  target: Record<string, unknown>,
  key: string,
  references: AssetReference[],
  assetKey = key,
) {
  const value = target[key];
  if (typeof value !== 'string' || value.trim().length === 0) return;

  references.push({
    key: assetKey,
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
  aggregateBudget: AggregateDownloadBudget;
  key: string;
  idleTimeoutMs: number;
  onProgress?: (event: Omit<RenderAssetPreparationProgress, 'assetIndex' | 'assetCount'>) => void;
}): Promise<LocalAsset> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= ASSET_DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      return await downloadRenderAssetOnce({ ...params, attempt });
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
  aggregateBudget: AggregateDownloadBudget;
  key: string;
  attempt: number;
  idleTimeoutMs: number;
  onProgress?: (event: Omit<RenderAssetPreparationProgress, 'assetIndex' | 'assetCount'>) => void;
}): Promise<LocalAsset> {
  const activityTimeout = createActivityTimeout(params.idleTimeoutMs);
  let localPath: string | null = null;
  let downloadedBytes = 0;

  try {
    const response = await params.fetchImpl(params.url, {
      signal: activityTimeout.signal,
    });
    activityTimeout.refresh();

    if (!response.ok || !response.body) {
      throw new Error(`RENDER_ASSET_DOWNLOAD_FAILED: HTTP ${response.status}`);
    }

    const contentLength = parseContentLength(response.headers.get('content-length'));
    if (contentLength !== null && contentLength > MAX_RENDER_ASSET_BYTES) {
      throw new Error('RENDER_ASSET_TOO_LARGE');
    }

    const responseContentType = response.headers.get('content-type')?.split(';')[0]?.trim() || 'application/octet-stream';
    const extension = resolveAssetExtension(params.url, responseContentType);
    if (!ALLOWED_EXTENSIONS.has(extension) && extension !== '.css') {
      throw new Error(`RENDER_ASSET_UNSUPPORTED_TYPE: ${responseContentType || extension}`);
    }
    const contentType = resolveEffectiveContentType(responseContentType, extension);
    validateAssetContentType(params.key, extension, contentType);

    const id = `${crypto.createHash('sha256').update(params.url).digest('hex').slice(0, 24)}${extension}`;
    localPath = path.join(params.assetsDir, id);
    const resolvedAssetsDir = path.resolve(params.assetsDir);
    const resolvedLocalPath = path.resolve(localPath);
    if (!resolvedLocalPath.startsWith(resolvedAssetsDir + path.sep)) {
      throw new Error('RENDER_ASSET_PATH_TRAVERSAL');
    }

    let lastReportedBytes = 0;
    let lastReportedAtMs = Date.now();
    const downloadStartedAtMs = Date.now();
    params.onProgress?.({
      phase: 'download_started',
      assetKey: params.key,
      attempt: params.attempt,
      downloadedBytes: 0,
      expectedBytes: contentLength,
      elapsedMs: 0,
      bytesPerSecond: null,
    });
    const byteLimit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        activityTimeout.refresh();
        if (downloadedBytes + chunk.length > MAX_RENDER_ASSET_BYTES) {
          callback(new Error('RENDER_ASSET_TOO_LARGE'));
          return;
        }
        try {
          params.aggregateBudget.reserve(chunk.length);
        } catch (error) {
          callback(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        downloadedBytes += chunk.length;
        const now = Date.now();
        if (
          downloadedBytes - lastReportedBytes >= ASSET_PROGRESS_BYTE_INTERVAL
          || now - lastReportedAtMs >= ASSET_PROGRESS_INTERVAL_MS
        ) {
          lastReportedBytes = downloadedBytes;
          lastReportedAtMs = now;
          params.onProgress?.({
            phase: 'download_progress',
            assetKey: params.key,
            attempt: params.attempt,
            downloadedBytes,
            expectedBytes: contentLength,
            elapsedMs: now - downloadStartedAtMs,
            bytesPerSecond: calculateBytesPerSecond(downloadedBytes, now - downloadStartedAtMs),
          });
        }
        callback(null, chunk);
      },
    });

    await pipeline(
      Readable.fromWeb(response.body as NodeReadableStream),
      byteLimit,
      createWriteStream(localPath),
      { signal: activityTimeout.signal },
    );
    const stat = await fsp.stat(localPath);
    const downloadElapsedMs = Date.now() - downloadStartedAtMs;
    params.onProgress?.({
      phase: 'download_completed',
      assetKey: params.key,
      attempt: params.attempt,
      downloadedBytes: stat.size,
      expectedBytes: contentLength,
      elapsedMs: downloadElapsedMs,
      bytesPerSecond: calculateBytesPerSecond(stat.size, downloadElapsedMs),
    });

    return {
      key: params.key,
      id,
      localPath,
      contentType,
      bytes: stat.size,
      expectedBytes: contentLength,
      attempt: params.attempt,
    };
  } catch (error) {
    params.aggregateBudget.release(downloadedBytes);
    if (localPath) {
      await fsp.rm(localPath, { force: true }).catch(() => undefined);
    }
    if (activityTimeout.didExpire()) {
      throw new Error(
        `RENDER_ASSET_DOWNLOAD_STALLED: ${params.key} sin datos durante ${params.idleTimeoutMs} ms`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    activityTimeout.clear();
  }
}

function calculateBytesPerSecond(bytes: number, elapsedMs: number): number | null {
  if (bytes <= 0 || elapsedMs <= 0) return null;
  return Math.round(bytes / (elapsedMs / 1000));
}

class AggregateDownloadBudget {
  private downloadedBytes = 0;

  constructor(private readonly maximumBytes: number) {}

  get bytes(): number {
    return this.downloadedBytes;
  }

  reserve(bytes: number): void {
    if (this.downloadedBytes + bytes > this.maximumBytes) {
      throw new Error('RENDER_ASSET_TOTAL_TOO_LARGE');
    }
    this.downloadedBytes += bytes;
  }

  release(bytes: number): void {
    this.downloadedBytes = Math.max(0, this.downloadedBytes - Math.max(0, bytes));
  }
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  operation: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(items.length, Math.max(1, Math.floor(concurrency)));
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await operation(items[index], index);
    }
  });
  const results = await Promise.allSettled(workers);
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure) throw failure.reason;
}

function normalizeIdleTimeoutMs(value: number | undefined): number {
  if (value === undefined) return ASSET_DOWNLOAD_IDLE_TIMEOUT_MS;
  if (!Number.isFinite(value)) return ASSET_DOWNLOAD_IDLE_TIMEOUT_MS;
  return Math.max(1, Math.round(value));
}

function createActivityTimeout(timeoutMs: number): {
  signal: AbortSignal;
  refresh(): void;
  clear(): void;
  didExpire(): boolean;
} {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  let expired = false;
  const clear = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  };
  const refresh = () => {
    clear();
    timer = setTimeout(() => {
      expired = true;
      controller.abort();
    }, timeoutMs);
  };
  refresh();
  return {
    signal: controller.signal,
    refresh,
    clear,
    didExpire: () => expired,
  };
}

async function validateDownloadedRenderAsset(asset: LocalAsset, mediaProbe: LocalMediaProbe): Promise<void> {
  if (asset.bytes <= 0) {
    throw new Error(`RENDER_ASSET_EMPTY: ${asset.key}`);
  }
  if (asset.expectedBytes !== null && asset.bytes !== asset.expectedBytes) {
    throw new Error(`RENDER_ASSET_INCOMPLETE: ${asset.key} expected ${asset.expectedBytes} bytes, got ${asset.bytes}`);
  }
  await validateImageSignature(asset);
  if (!isProbeableMediaAsset(asset)) return;

  try {
    const result = await withTimeout(
      mediaProbe({
        key: asset.key,
        localPath: asset.localPath,
        contentType: asset.contentType,
      }),
      LOCAL_MEDIA_PREFLIGHT_TIMEOUT_MS,
      'LOCAL_MEDIA_PREFLIGHT_TIMEOUT',
    );
    if (!Number.isFinite(result.durationSeconds) || result.durationSeconds <= 0) {
      throw new Error('LOCAL_MEDIA_PREFLIGHT_INVALID_DURATION');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`RENDER_ASSET_PREFLIGHT_FAILED: ${asset.key}: ${message}`);
  }
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isProbeableMediaAsset(asset: LocalAsset): boolean {
  return /^audio\//i.test(asset.contentType) || /^video\//i.test(asset.contentType);
}

function parseContentLength(rawValue: string | null): number | null {
  if (rawValue === null || rawValue.trim().length === 0) return null;
  const parsed = Number(rawValue);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function resolveEffectiveContentType(responseContentType: string, extension: string): string {
  const normalizedContentType = responseContentType.toLowerCase();
  if (normalizedContentType !== 'application/octet-stream' && normalizedContentType !== 'application/mp4') {
    return responseContentType;
  }
  return EXTENSION_CONTENT_TYPES.get(extension) ?? responseContentType;
}

function validateAssetContentType(assetKey: string, extension: string, contentType: string): void {
  const normalizedContentType = contentType.toLowerCase();
  const isFont = ['.otf', '.ttf', '.woff', '.woff2'].includes(extension);
  const matches = extension === '.css'
    ? normalizedContentType === 'text/css'
    : ['.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp'].includes(extension)
      ? normalizedContentType.startsWith('image/')
      : extension === '.m4a'
        ? normalizedContentType.startsWith('audio/')
          || normalizedContentType === 'video/mp4'
          || normalizedContentType === 'application/mp4'
        : ['.aac', '.mp3', '.ogg', '.wav'].includes(extension)
          ? normalizedContentType.startsWith('audio/')
          : ['.mov', '.mp4', '.webm'].includes(extension)
            ? normalizedContentType.startsWith('video/') || normalizedContentType === 'application/mp4'
            : isFont
              ? normalizedContentType.startsWith('font/')
                || normalizedContentType.startsWith('application/font-')
                || normalizedContentType === 'application/x-font-ttf'
                || normalizedContentType === 'application/x-font-opentype'
              : true;
  if (!matches) {
    throw new Error(`RENDER_ASSET_CONTENT_TYPE_MISMATCH: ${assetKey} does not match ${contentType}`);
  }
}

async function validateImageSignature(asset: LocalAsset): Promise<void> {
  if (!asset.contentType.toLowerCase().startsWith('image/')) return;

  const handle = await fsp.open(asset.localPath, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(asset.bytes, 512));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const header = buffer.subarray(0, bytesRead);
    const extension = path.extname(asset.localPath).toLowerCase();
    const isValid = extension === '.png'
      ? header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : extension === '.jpg' || extension === '.jpeg'
        ? header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff
        : extension === '.gif'
          ? header.subarray(0, 6).toString('ascii') === 'GIF87a' || header.subarray(0, 6).toString('ascii') === 'GIF89a'
          : extension === '.webp'
            ? header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP'
            : extension === '.svg'
              ? /<svg\b/i.test(header.toString('utf8'))
              : true;
    if (!isValid) {
      throw new Error(`RENDER_ASSET_INVALID_SIGNATURE: ${asset.key}`);
    }
  } finally {
    await handle.close();
  }
}

async function probeLocalMediaAsset(asset: {
  localPath: string;
}): Promise<LocalMediaProbeResult> {
  const { ALL_FORMATS, FilePathSource, Input } = await import('mediabunny');
  const input = new Input({
    source: new FilePathSource(asset.localPath),
    formats: ALL_FORMATS,
  });

  try {
    const durationSeconds = await input.computeDuration();
    return { durationSeconds };
  } finally {
    input.dispose();
  }
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
