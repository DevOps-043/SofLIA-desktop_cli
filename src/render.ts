import { createReadStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { ensureBrowser, renderMedia, selectComposition } from '@remotion/renderer';
import type { RenderMediaOnDownload, RenderMediaOnProgress } from '@remotion/renderer';
import type { ClaimedRenderJob, SofliaWorkerApiClient } from './api-client.js';
import { downloadAndExtractBundle, sha256File } from './bundle.js';
import type { LocalCleanupPolicy } from './local-job-state.js';
import type { LocalJobStore } from './local-job-store.js';
import { getWorkspaceDir } from './paths.js';
import { RecoverableJobError } from './recoverable-job-error.js';
import { getRemotionBinariesDirectory } from './remotion-binaries.js';
import type { RenderProgressEvent } from './shared/worker-events.js';
import type { WorkerChromiumGl, WorkerHardwareAcceleration } from './shared/worker-capacity.js';

type RenderClaimedJobOptions = {
  onProgress?: (event: RenderProgressEvent) => void;
  renderConcurrency?: number;
  hardwareAcceleration?: WorkerHardwareAcceleration;
  chromiumGl?: WorkerChromiumGl;
  videoBitrate?: string;
  localJobStore?: LocalJobStore;
  localRetentionPolicy?: LocalCleanupPolicy;
};

type StreamingRequestInit = RequestInit & {
  duplex: 'half';
};

async function reportProgress(
  client: SofliaWorkerApiClient,
  job: ClaimedRenderJob,
  percent: number,
  message: string,
  stage: string,
  onProgress?: (event: RenderProgressEvent) => void,
  detail?: Record<string, unknown>,
) {
  onProgress?.({
    jobId: job.jobId,
    compositionId: job.compositionId,
    percent,
    message,
    stage,
    detail,
  });
  await client.progress(job.jobId, percent, message, stage);
}

function elapsedMsSince(startedAtMs: number): number {
  return Math.max(0, Date.now() - startedAtMs);
}

function roundMs(ms: number): number {
  return Math.round(ms);
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'tamano desconocido';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
}

export async function renderClaimedJob(
  client: SofliaWorkerApiClient,
  job: ClaimedRenderJob,
  options: RenderClaimedJobOptions = {},
): Promise<void> {
  const jobStartedAtMs = Date.now();
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
  const bundleStartedAtMs = Date.now();
  const serveUrl = isExternalServeUrl
    ? job.bundleUrl
    : await downloadAndExtractBundle(job.bundleUrl, job.bundleHash, { requireSha256: true });
  await reportProgress(client, job, 18, 'Bundle Remotion listo', 'bundle_ready', options.onProgress, {
    elapsedMs: roundMs(elapsedMsSince(bundleStartedAtMs)),
    bundleType: job.bundleType || 'zip',
    bundleHash: job.bundleHash,
    serveUrl: isExternalServeUrl ? 'external' : 'local-cache',
  });
  const outputDir = path.join(getWorkspaceDir(), 'renders', job.jobId);
  const outputPath = path.join(outputDir, 'output.mp4');

  await fsp.mkdir(outputDir, { recursive: true });
  options.localJobStore?.updateStage(job.jobId, 'running', 'render_workspace_ready');
  const browserStartedAtMs = Date.now();
  await reportProgress(client, job, 22, 'Preparando Chromium', 'browser_ensure', options.onProgress, {
    binariesDirectory,
  });
  await ensureBrowser();
  await reportProgress(client, job, 24, 'Chromium listo', 'browser_ready', options.onProgress, {
    elapsedMs: roundMs(elapsedMsSince(browserStartedAtMs)),
  });

  const compositionStartedAtMs = Date.now();
  await reportProgress(client, job, 25, 'Resolviendo composicion', 'composition_select', options.onProgress);
  const chromiumOptions = options.chromiumGl ? { gl: options.chromiumGl } : undefined;
  const composition = await selectComposition({
    serveUrl,
    id: job.compositionId,
    inputProps: job.resolvedProps,
    timeoutInMilliseconds: job.timeoutInMilliseconds,
    binariesDirectory,
    chromiumOptions,
  });
  await reportProgress(client, job, 29, 'Composicion resuelta', 'composition_ready', options.onProgress, {
    elapsedMs: roundMs(elapsedMsSince(compositionStartedAtMs)),
    durationInFrames: composition.durationInFrames,
    fps: composition.fps,
    width: composition.width,
    height: composition.height,
    durationSeconds: Math.round(composition.durationInFrames / composition.fps),
  });

  let lastPercent = 30;
  let lastRenderStage = '';
  let lastRenderProgressAtMs = 0;
  const renderStartedAtMs = Date.now();
  const onDownload: RenderMediaOnDownload = (src) => {
    let lastAssetPercent = -1;
    let lastAssetProgressAtMs = 0;
    return ({ percent, downloaded, totalSize }) => {
      const percentDone = percent === null ? null : Math.round(percent * 100);
      const now = Date.now();
      const shouldReport = percentDone === null
        ? now - lastAssetProgressAtMs >= 5000
        : percentDone >= lastAssetPercent + 10 || percentDone === 100 || now - lastAssetProgressAtMs >= 5000;
      if (!shouldReport) return;
      lastAssetPercent = percentDone ?? lastAssetPercent;
      lastAssetProgressAtMs = now;
      void reportProgress(
        client,
        job,
        Math.max(lastPercent, 31),
        percentDone === null
          ? `Descargando asset de Remotion (${formatBytes(downloaded)})`
          : `Descargando asset de Remotion (${percentDone}%)`,
        'asset_download',
        options.onProgress,
        {
          src,
          percent: percentDone,
          downloadedBytes: downloaded,
          totalBytes: totalSize,
        },
      );
    };
  };
  const onRenderProgress: RenderMediaOnProgress = ({
    progress,
    renderedFrames,
    encodedFrames,
    renderedDoneIn,
    encodedDoneIn,
    renderEstimatedTime,
    stitchStage,
  }) => {
    const percent = Math.round(30 + progress * 55);
    const stage = stitchStage === 'muxing'
      ? 'render_muxing'
      : renderedDoneIn === null
        ? 'render_frames'
        : 'render_encoding';
    const now = Date.now();
    const shouldReport = percent > lastPercent
      || stage !== lastRenderStage
      || now - lastRenderProgressAtMs >= 15000;
    if (!shouldReport) return;
    lastPercent = Math.max(lastPercent, percent);
    lastRenderStage = stage;
    lastRenderProgressAtMs = now;
    void reportProgress(
      client,
      job,
      lastPercent,
      stage === 'render_muxing'
        ? 'Combinando audio y video'
        : stage === 'render_encoding'
          ? `Codificando video (${Math.round(progress * 100)}%)`
          : `Renderizando fotogramas (${Math.round(progress * 100)}%)`,
      stage,
      options.onProgress,
      {
        progress,
        renderedFrames,
        encodedFrames,
        renderedDoneIn,
        encodedDoneIn,
        renderEstimatedTime,
        stitchStage,
        elapsedMs: roundMs(elapsedMsSince(renderStartedAtMs)),
      },
    );
  };
  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    outputLocation: outputPath,
    inputProps: job.resolvedProps,
    timeoutInMilliseconds: job.timeoutInMilliseconds,
    binariesDirectory,
    chromiumOptions,
    concurrency: options.renderConcurrency,
    hardwareAcceleration: options.hardwareAcceleration,
    videoBitrate: options.videoBitrate,
    onStart: ({ frameCount, parallelEncoding, resolvedConcurrency }) => {
      void reportProgress(client, job, 30, 'Remotion inicio el render', 'render_start', options.onProgress, {
        frameCount,
        parallelEncoding,
        resolvedConcurrency,
        requestedConcurrency: options.renderConcurrency,
        hardwareAcceleration: options.hardwareAcceleration,
        chromiumGl: options.chromiumGl,
        videoBitrate: options.videoBitrate,
      });
    },
    onDownload,
    onProgress: onRenderProgress,
  });
  await reportProgress(client, job, 86, 'Render y encoding terminados', 'render_complete', options.onProgress, {
    elapsedMs: roundMs(elapsedMsSince(renderStartedAtMs)),
    totalElapsedMs: roundMs(elapsedMsSince(jobStartedAtMs)),
  });

  const checksumStartedAtMs = Date.now();
  await reportProgress(client, job, 87, 'Calculando checksum del video', 'checksum', options.onProgress);
  const checksum = await sha256File(outputPath);
  const stat = await fsp.stat(outputPath);
  await reportProgress(client, job, 89, 'Checksum listo', 'checksum_ready', options.onProgress, {
    elapsedMs: roundMs(elapsedMsSince(checksumStartedAtMs)),
    artifactSizeBytes: stat.size,
  });
  options.localJobStore?.markArtifactReady({
    jobId: job.jobId,
    artifactPath: outputPath,
    artifactChecksum: checksum,
    artifactSizeBytes: stat.size,
    durationSeconds: Math.round(composition.durationInFrames / composition.fps),
    outputStoragePath: job.outputStoragePath,
  });

  const uploadStartedAtMs = Date.now();
  await reportProgress(client, job, 90, 'Subiendo video final', 'upload', options.onProgress, {
    artifactSizeBytes: stat.size,
    uploadMode: 'stream',
  });
  try {
    options.localJobStore?.updateStage(job.jobId, 'uploading', 'upload');
    const uploadRequest: StreamingRequestInit = {
      method: 'PUT',
      headers: {
        'content-type': 'video/mp4',
        'content-length': String(stat.size),
      },
      body: createReadStream(outputPath) as unknown as BodyInit,
      duplex: 'half',
    };
    const uploadResponse = await fetch(job.outputUploadUrl, uploadRequest);
    if (!uploadResponse.ok) {
      throw new Error(`No se pudo subir el video final: HTTP ${uploadResponse.status}`);
    }
    options.localJobStore?.markUploadedPendingComplete(job.jobId);
    await reportProgress(client, job, 95, 'Video final subido', 'upload_complete', options.onProgress, {
      elapsedMs: roundMs(elapsedMsSince(uploadStartedAtMs)),
      artifactSizeBytes: stat.size,
    });
  } catch (error) {
    options.localJobStore?.markUploadFailed(job.jobId, error);
    throw new RecoverableJobError('Video final listo localmente, pero la subida quedo pendiente.', 'upload', error);
  }

  try {
    await client.complete(job.jobId, {
      outputStoragePath: job.outputStoragePath,
      checksum,
      durationSeconds: Math.round(composition.durationInFrames / composition.fps),
    });
    options.localJobStore?.markRemoteConfirmed(job.jobId);
  } catch (error) {
    options.localJobStore?.markConfirmFailed(job.jobId, error);
    throw new RecoverableJobError('Video final subido, pero la confirmacion remota quedo pendiente.', 'complete', error);
  }
}
