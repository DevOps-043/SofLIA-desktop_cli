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
import { prepareRenderAssetsForJob } from './render-asset-preparer.js';
import { RenderProgressReporter } from './render-progress-reporter.js';
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

function describeAssetSource(source: string): string {
  try {
    const url = new URL(source);
    const filename = path.basename(url.pathname);
    return `${url.hostname}/${filename || 'asset'}`;
  } catch {
    return 'asset';
  }
}

export async function renderClaimedJob(
  client: SofliaWorkerApiClient,
  job: ClaimedRenderJob,
  options: RenderClaimedJobOptions = {},
): Promise<void> {
  const jobStartedAtMs = Date.now();
  const progressReporter = new RenderProgressReporter(client, job, options.onProgress);
  const isExternalServeUrl = job.bundleType === 'serve_url';
  const binariesDirectory = getRemotionBinariesDirectory();
  await progressReporter.report(
    10,
    isExternalServeUrl ? 'Usando sitio Remotion aprobado' : 'Descargando bundle Remotion',
    isExternalServeUrl ? 'external_serve_url' : 'bundle_download',
  );
  const bundleStartedAtMs = Date.now();
  const serveUrl = isExternalServeUrl
    ? job.bundleUrl
    : await downloadAndExtractBundle(job.bundleUrl, job.bundleHash, { requireSha256: true });
  await progressReporter.report(18, 'Bundle Remotion listo', 'bundle_ready', {
    elapsedMs: roundMs(elapsedMsSince(bundleStartedAtMs)),
    bundleType: job.bundleType || 'zip',
    bundleHash: job.bundleHash,
    serveUrl: isExternalServeUrl ? 'external' : 'local-cache',
  });
  const outputDir = path.join(getWorkspaceDir(), 'renders', job.jobId);
  const outputPath = path.join(outputDir, 'output.mp4');

  await fsp.mkdir(outputDir, { recursive: true });
  options.localJobStore?.updateStage(job.jobId, 'running', 'render_workspace_ready');
  const assetPrepareStartedAtMs = Date.now();
  await progressReporter.report(19, 'Preparando assets locales', 'asset_prepare');
  const preparedAssets = await prepareRenderAssetsForJob({
    jobId: job.jobId,
    outputDir,
    resolvedProps: job.resolvedProps,
    onProgress: (event) => {
      const isValidated = event.phase === 'validation_completed';
      const message = isValidated
        ? `Asset validado (${event.assetIndex}/${event.assetCount}): ${event.assetKey}`
        : `Descargando asset (${event.assetIndex}/${event.assetCount}): ${event.assetKey} (${formatBytes(event.downloadedBytes)})`;
      progressReporter.schedule(isValidated ? 20 : 19, message, 'asset_prepare', {
        assetKey: event.assetKey,
        assetIndex: event.assetIndex,
        assetCount: event.assetCount,
        phase: event.phase,
        attempt: event.attempt,
        downloadedBytes: event.downloadedBytes,
        expectedBytes: event.expectedBytes,
      });
    },
  });
  await progressReporter.report(21, 'Assets locales listos', 'asset_prepare', {
    elapsedMs: roundMs(elapsedMsSince(assetPrepareStartedAtMs)),
    assetCount: preparedAssets.assetCount,
    assetBytes: preparedAssets.assetBytes,
  });

  try {
  const browserStartedAtMs = Date.now();
  await progressReporter.report(22, 'Preparando Chromium', 'browser_ensure', {
    binariesDirectory,
  });
  await ensureBrowser();
  await progressReporter.report(24, 'Chromium listo', 'browser_ready', {
    elapsedMs: roundMs(elapsedMsSince(browserStartedAtMs)),
  });

  const compositionStartedAtMs = Date.now();
  await progressReporter.report(25, 'Resolviendo composicion', 'composition_select');
  const chromiumOptions = options.chromiumGl ? { gl: options.chromiumGl } : undefined;
  const composition = await selectComposition({
    serveUrl,
    id: job.compositionId,
    inputProps: preparedAssets.resolvedProps,
    timeoutInMilliseconds: job.timeoutInMilliseconds,
    binariesDirectory,
    chromiumOptions,
  });
  await progressReporter.report(29, 'Composicion resuelta', 'composition_ready', {
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
      progressReporter.schedule(
        Math.max(lastPercent, 31),
        percentDone === null
          ? `Descargando asset de Remotion (${formatBytes(downloaded)})`
          : `Descargando asset de Remotion (${percentDone}%)`,
        'asset_download',
        {
          assetSource: describeAssetSource(src),
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
    progressReporter.schedule(
      lastPercent,
      stage === 'render_muxing'
        ? 'Combinando audio y video'
        : stage === 'render_encoding'
          ? `Codificando video (${Math.round(progress * 100)}%)`
          : `Renderizando fotogramas (${Math.round(progress * 100)}%)`,
      stage,
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
    inputProps: preparedAssets.resolvedProps,
    timeoutInMilliseconds: job.timeoutInMilliseconds,
    binariesDirectory,
    chromiumOptions,
    concurrency: options.renderConcurrency,
    hardwareAcceleration: options.hardwareAcceleration,
    videoBitrate: options.videoBitrate,
    onStart: ({ frameCount, parallelEncoding, resolvedConcurrency }) => {
      progressReporter.schedule(30, 'Remotion inicio el render', 'render_start', {
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
  await progressReporter.report(86, 'Render y encoding terminados', 'render_complete', {
    elapsedMs: roundMs(elapsedMsSince(renderStartedAtMs)),
    totalElapsedMs: roundMs(elapsedMsSince(jobStartedAtMs)),
  });

  const checksumStartedAtMs = Date.now();
  await progressReporter.report(87, 'Calculando checksum del video', 'checksum');
  const checksum = await sha256File(outputPath);
  const stat = await fsp.stat(outputPath);
  await progressReporter.report(89, 'Checksum listo', 'checksum_ready', {
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
  await progressReporter.report(90, 'Subiendo video final', 'upload', {
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
    await progressReporter.report(95, 'Video final subido', 'upload_complete', {
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
  } finally {
    await preparedAssets.close();
  }
}
