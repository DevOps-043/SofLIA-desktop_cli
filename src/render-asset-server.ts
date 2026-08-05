import { createReadStream } from 'node:fs';
import { createServer, type Server } from 'node:http';

export interface ServedRenderAsset {
  id: string;
  localPath: string;
  contentType: string;
  bytes: number;
}

export async function startLocalAssetServer(params: {
  assets: ServedRenderAsset[];
  token: string;
}): Promise<{ close(): Promise<void>; urlFor(id: string): string }> {
  const assetById = new Map(params.assets.map((asset) => [asset.id, asset] as const));
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
    const parts = requestUrl.pathname.split('/').filter(Boolean);
    const [, token, assetId] = parts;

    if (parts[0] !== 'assets' || token !== params.token || !assetId) {
      response.writeHead(404).end();
      return;
    }

    const asset = assetById.get(assetId);
    if (!asset) {
      response.writeHead(404).end();
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }

    const range = resolveRequestedByteRange(request.headers.range, asset.bytes);
    if (range.kind === 'unsatisfiable') {
      response.writeHead(416, {
        'accept-ranges': 'bytes',
        'content-range': `bytes */${asset.bytes}`,
      }).end();
      return;
    }

    const isPartial = range.kind === 'partial';
    const start = isPartial ? range.start : 0;
    const end = isPartial ? range.end : asset.bytes - 1;
    const contentLength = Math.max(0, end - start + 1);
    response.writeHead(isPartial ? 206 : 200, {
      'content-type': asset.contentType,
      'content-length': String(contentLength),
      'accept-ranges': 'bytes',
      'access-control-allow-origin': '*',
      ...(isPartial ? { 'content-range': `bytes ${start}-${end}/${asset.bytes}` } : {}),
      'cache-control': 'no-store',
    });

    if (request.method === 'HEAD') {
      response.end();
      return;
    }

    const stream = createReadStream(asset.localPath, { start, end });
    stream.on('error', (error) => response.destroy(error));
    stream.pipe(response);
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

type RequestedByteRange =
  | { kind: 'full' }
  | { kind: 'partial'; start: number; end: number }
  | { kind: 'unsatisfiable' };

function resolveRequestedByteRange(rangeHeader: string | undefined, size: number): RequestedByteRange {
  if (!rangeHeader) return { kind: 'full' };
  if (size <= 0 || rangeHeader.includes(',')) return { kind: 'unsatisfiable' };

  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match || (!match[1] && !match[2])) return { kind: 'unsatisfiable' };

  const startText = match[1];
  const endText = match[2];
  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { kind: 'unsatisfiable' };
    return {
      kind: 'partial',
      start: Math.max(0, size - suffixLength),
      end: size - 1,
    };
  }

  const start = Number(startText);
  const requestedEnd = endText ? Number(endText) : size - 1;
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(requestedEnd)
    || start < 0
    || requestedEnd < start
    || start >= size
  ) {
    return { kind: 'unsatisfiable' };
  }

  return {
    kind: 'partial',
    start,
    end: Math.min(requestedEnd, size - 1),
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
