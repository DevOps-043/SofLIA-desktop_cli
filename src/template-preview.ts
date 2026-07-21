import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { ensureBrowser, renderStill, selectComposition } from '@remotion/renderer';
import type { ClaimedTemplatePreviewJob, SofliaWorkerApiClient } from './api-client.js';
import { downloadAndExtractBundle, sha256File } from './bundle.js';
import { sanitizeLog } from './logging.js';
import { getWorkspaceDir } from './paths.js';
import { getRemotionBinariesDirectory } from './remotion-binaries.js';
import type { RenderProgressEvent } from './shared/worker-events.js';

type RenderTemplatePreviewJobOptions = {
  onProgress?: (event: RenderProgressEvent) => void;
};

async function reportProgress(
  client: SofliaWorkerApiClient,
  job: ClaimedTemplatePreviewJob,
  percent: number,
  message: string,
  stage: string,
  onProgress?: (event: RenderProgressEvent) => void,
  detail?: Record<string, unknown>,
) {
  onProgress?.({
    jobType: 'template_preview',
    jobId: job.jobId,
    buildId: job.buildId,
    templateVersionId: job.templateVersionId,
    compositionId: job.compositionId,
    percent,
    message,
    stage,
    detail,
  });
  await client.progress(job.jobId, percent, message, stage);
}

async function readSafeUploadFailureDetail(response: Response): Promise<string> {
  const rawBody = await response.text().catch(() => '');
  return sanitizeLog(rawBody).replace(/\s+/g, ' ').trim().slice(0, 500);
}

export async function renderTemplatePreviewJob(
  client: SofliaWorkerApiClient,
  job: ClaimedTemplatePreviewJob,
  options: RenderTemplatePreviewJobOptions = {},
): Promise<void> {
  const binariesDirectory = getRemotionBinariesDirectory();

  await reportProgress(client, job, 10, 'Descargando build compilado de plantilla', 'template_preview_bundle_download', options.onProgress, {
    buildId: job.buildId,
    previewId: job.previewId,
    bundleHash: job.bundleHash,
  });
  const serveUrl = await downloadAndExtractBundle(job.bundleUrl, job.bundleHash, { requireSha256: true });
  const outputDir = path.join(getWorkspaceDir(), 'template-previews', job.previewId);
  const outputPath = path.join(outputDir, 'poster.png');

  await fsp.rm(outputDir, { recursive: true, force: true });
  await fsp.mkdir(outputDir, { recursive: true });
  await ensureBrowser();

  await reportProgress(client, job, 35, 'Resolviendo composicion para preview', 'template_preview_composition_select', options.onProgress, {
    compositionId: job.compositionId,
    propsHash: job.propsHash,
  });
  const composition = await selectComposition({
    serveUrl,
    id: job.compositionId,
    inputProps: job.resolvedProps,
    timeoutInMilliseconds: job.timeoutInMilliseconds,
    binariesDirectory,
  });

  const previewFrame = Math.max(
    0,
    Math.min(composition.durationInFrames - 1, Math.round(job.previewFrame || 0)),
  );

  await reportProgress(client, job, 60, 'Renderizando poster de preview', 'template_preview_render_still', options.onProgress, {
    previewFrame,
    durationInFrames: composition.durationInFrames,
  });
  await renderStill({
    serveUrl,
    composition,
    inputProps: job.resolvedProps,
    frame: previewFrame,
    imageFormat: 'png',
    output: outputPath,
    timeoutInMilliseconds: job.timeoutInMilliseconds,
    binariesDirectory,
  });

  await reportProgress(client, job, 88, 'Subiendo poster de preview', 'template_preview_upload', options.onProgress, {
    posterStoragePath: job.posterStoragePath,
  });
  const poster = await fsp.readFile(outputPath);
  const uploadResponse = await fetch(job.posterUploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'image/png' },
    body: new Blob([new Uint8Array(poster)], { type: 'image/png' }),
  });
  if (!uploadResponse.ok) {
    const detail = await readSafeUploadFailureDetail(uploadResponse);
    throw new Error(
      `No se pudo subir el poster de preview: HTTP ${uploadResponse.status}${detail ? ` - ${detail}` : ''}`,
    );
  }

  await client.complete(job.jobId, {
    outputStoragePath: job.posterStoragePath,
    checksum: await sha256File(outputPath),
  });
}
