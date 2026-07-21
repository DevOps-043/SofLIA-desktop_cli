import crypto from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import JSZip from 'jszip';
import { getWorkspaceDir } from './paths.js';

type DownloadAndExtractBundleOptions = {
  requireSha256?: boolean;
};

function isSha256Hash(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value);
}

function cacheKeyForBundleHash(bundleHash: string): string {
  const normalizedHash = bundleHash.trim().toLowerCase();
  if (isSha256Hash(normalizedHash)) return normalizedHash;
  return crypto.createHash('sha256').update(bundleHash).digest('hex');
}

export async function downloadAndExtractBundle(
  bundleUrl: string,
  bundleHash: string,
  options: DownloadAndExtractBundleOptions = {},
): Promise<string> {
  const normalizedHash = bundleHash.trim().toLowerCase();
  if (options.requireSha256 && !isSha256Hash(normalizedHash)) {
    throw new Error('Bundle hash invalido: se requiere SHA-256 para compilar plantillas.');
  }

  const workspaceDir = getWorkspaceDir();
  const bundleRoot = path.join(workspaceDir, 'bundles', cacheKeyForBundleHash(bundleHash));
  const marker = path.join(bundleRoot, '.ready');
  const indexPath = path.join(bundleRoot, 'index.html');

  try {
    await fsp.access(marker);
    await fsp.access(indexPath);
    return bundleRoot;
  } catch {
    await fsp.rm(bundleRoot, { recursive: true, force: true });
  }

  const response = await fetch(bundleUrl);
  if (!response.ok) {
    throw new Error(`No se pudo descargar el bundle Remotion: HTTP ${response.status}`);
  }

  const zipBuffer = Buffer.from(await response.arrayBuffer());
  const actualHash = crypto.createHash('sha256').update(zipBuffer).digest('hex');
  if (options.requireSha256 && actualHash !== normalizedHash) {
    throw new Error('Bundle hash mismatch: el ZIP fuente no coincide con el SHA-256 esperado.');
  }

  await fsp.rm(bundleRoot, { recursive: true, force: true });
  await fsp.mkdir(bundleRoot, { recursive: true });

  const zip = await JSZip.loadAsync(zipBuffer);
  for (const [fileName, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    const normalized = path.normalize(fileName);
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
      throw new Error(`Bundle inseguro: ruta invalida ${fileName}`);
    }

    const destination = path.join(bundleRoot, normalized);
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.writeFile(destination, await file.async('nodebuffer'));
  }

  try {
    await fsp.access(indexPath);
  } catch {
    await fsp.rm(bundleRoot, { recursive: true, force: true });
    throw new Error('REMOTION_BUNDLE_INVALID: el ZIP extraido no contiene index.html en la raiz. Se requiere un bundle compilado de Remotion, no el ZIP fuente.');
  }

  await fsp.writeFile(marker, new Date().toISOString());
  return bundleRoot;
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  hash.update(await fsp.readFile(filePath));
  return hash.digest('hex');
}
