import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { ensureBrowser, renderMedia, selectComposition } from '@remotion/renderer';
import type { ClaimedRenderJob, SofliaWorkerApiClient } from './api-client.js';
import { downloadAndExtractBundle, sha256File } from './bundle.js';
import { getWorkspaceDir } from './paths.js';
import { getRemotionBinariesDirectory } from './remotion-binaries.js';
import type { RenderProgressEvent } from './shared/worker-events.js';

type RenderClaimedJobOptions = {
  onProgress?: (event: RenderProgressEvent) => void;
  renderConcurrency?: number;
};

async function reportProgress(
  client: SofliaWorkerApiClient,
  job: ClaimedRenderJob,
  percent: number,
  message: string,
  stage: string,
  onProgress?: (event: RenderProgressEvent) => void,
) {
  onProgress?.({
    jobId: job.jobId,
    compositionId: job.compositionId,
    percent,
    message,
    stage,
  });
  await client.progress(job.jobId, percent, message, stage);
}

export async function renderClaimedJob(
  client: SofliaWorkerApiClient,
  job: ClaimedRenderJob,
  options: RenderClaimedJobOptions = {},
): Promise<void> {
  const isExternalServeUrl = job.bundleType === 'serve_url';
  const binariesDirectory = getRemotionBinariesDirectory();
  await reportProgress(
    client,
    job,
    10,
    isExternalServeUrl ? 'Usando sitio Remotion aprobado' : 'Descargando bundle Remotion',
    isExternalServeUrl ? 'external_serve_url' : 'bundle_download',
    options.onProgress,
  );
  const serveUrl = isExternalServeUrl
    ? job.bundleUrl
    : await downloadAndExtractBundle(job.bundleUrl, job.bundleHash, { requireSha256: true });
  const outputDir = path.join(getWorkspaceDir(), 'renders', job.jobId);
  const outputPath = path.join(outputDir, 'output.mp4');

  await fsp.mkdir(outputDir, { recursive: true });
  await ensureBrowser();

  await reportProgress(client, job, 25, 'Resolviendo composicion', 'composition_select', options.onProgress);
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
    concurrency: options.renderConcurrency,
    onProgress: ({ progress }) => {
      const percent = Math.round(30 + progress * 55);
      if (percent > lastPercent) {
        lastPercent = percent;
        void reportProgress(
          client,
          job,
          percent,
          `Renderizando fotogramas (${Math.round(progress * 100)}%)`,
          'render',
          options.onProgress,
        );
      }
    },
  });

  await reportProgress(client, job, 90, 'Subiendo video final', 'upload', options.onProgress);
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
