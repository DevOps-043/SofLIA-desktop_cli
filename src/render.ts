import * as fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { ensureBrowser, renderMedia, selectComposition } from '@remotion/renderer';
import type { ClaimedJob, SofliaWorkerApiClient } from './api-client.js';
import { downloadAndExtractBundle, sha256File } from './bundle.js';
import { getWorkspaceDir } from './paths.js';

const require = createRequire(import.meta.url);

function getRemotionBinariesDirectory(): string | null {
  const packageName = (() => {
    if (process.platform === 'win32' && process.arch === 'x64') return '@remotion/compositor-win32-x64-msvc';
    if (process.platform === 'darwin' && process.arch === 'x64') return '@remotion/compositor-darwin-x64';
    if (process.platform === 'darwin' && process.arch === 'arm64') return '@remotion/compositor-darwin-arm64';
    if (process.platform === 'linux' && process.arch === 'x64') return '@remotion/compositor-linux-x64-gnu';
    if (process.platform === 'linux' && process.arch === 'arm64') return '@remotion/compositor-linux-arm64-gnu';
    return null;
  })();

  if (!packageName) return null;
  const compositorPackageDir = path.dirname(require.resolve(`${packageName}/package.json`));
  return compositorPackageDir.includes('app.asar')
    ? compositorPackageDir.replace('app.asar', 'app.asar.unpacked')
    : null;
}

export async function renderClaimedJob(client: SofliaWorkerApiClient, job: ClaimedJob): Promise<void> {
  const isExternalServeUrl = job.bundleType === 'serve_url';
  const binariesDirectory = getRemotionBinariesDirectory();
  await client.progress(
    job.jobId,
    10,
    isExternalServeUrl ? 'Usando sitio Remotion aprobado' : 'Descargando bundle Remotion',
    isExternalServeUrl ? 'external_serve_url' : 'bundle_download',
  );
  const serveUrl = isExternalServeUrl
    ? job.bundleUrl
    : await downloadAndExtractBundle(job.bundleUrl, job.bundleHash);
  const outputDir = path.join(getWorkspaceDir(), 'renders', job.jobId);
  const outputPath = path.join(outputDir, 'output.mp4');

  await fsp.mkdir(outputDir, { recursive: true });
  await ensureBrowser();

  await client.progress(job.jobId, 25, 'Resolviendo composicion', 'composition_select');
  const composition = await selectComposition({
    serveUrl,
    id: job.compositionId,
    inputProps: job.resolvedProps,
    timeoutInMilliseconds: job.timeoutInMilliseconds,
    binariesDirectory,
  });

  let lastPercent = 30;
  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    outputLocation: outputPath,
    inputProps: job.resolvedProps,
    timeoutInMilliseconds: job.timeoutInMilliseconds,
    binariesDirectory,
    onProgress: ({ progress }) => {
      const percent = Math.round(30 + progress * 55);
      if (percent > lastPercent) {
        lastPercent = percent;
        void client.progress(job.jobId, percent, `Renderizando fotogramas (${Math.round(progress * 100)}%)`, 'render');
      }
    },
  });

  await client.progress(job.jobId, 90, 'Subiendo video final', 'upload');
  const video = await fsp.readFile(outputPath);
  const uploadResponse = await fetch(job.outputUploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'video/mp4' },
    body: video,
  });
  if (!uploadResponse.ok) {
    throw new Error(`No se pudo subir el video final: HTTP ${uploadResponse.status}`);
  }

  await client.complete(job.jobId, {
    outputStoragePath: job.outputStoragePath,
    checksum: await sha256File(outputPath),
    durationSeconds: Math.round(composition.durationInFrames / composition.fps),
  });
}
