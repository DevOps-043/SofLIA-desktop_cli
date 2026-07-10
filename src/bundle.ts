import crypto from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import JSZip from 'jszip';
import { getWorkspaceDir } from './paths.js';

export async function downloadAndExtractBundle(bundleUrl: string, bundleHash: string): Promise<string> {
  const workspaceDir = getWorkspaceDir();
  const bundleRoot = path.join(workspaceDir, 'bundles', bundleHash);
  const marker = path.join(bundleRoot, '.ready');

  try {
    await fsp.access(marker);
    return bundleRoot;
  } catch {
    // Extract below.
  }

  const response = await fetch(bundleUrl);
  if (!response.ok) {
    throw new Error(`No se pudo descargar el bundle Remotion: HTTP ${response.status}`);
  }

  const zipBuffer = Buffer.from(await response.arrayBuffer());
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

  await fsp.writeFile(marker, new Date().toISOString());
  return bundleRoot;
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  hash.update(await fsp.readFile(filePath));
  return hash.digest('hex');
}
