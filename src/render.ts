import { createReadStream } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Transform } from 'node:stream';
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
import { assertArtifactMatchesComposition, inspectMediaArtifact } from './media-artifact-inspector.js';
import { withRemotionBrowser } from './remotion-browser.js';

type RenderClaimedJobOptions = {
  onProgress?: (event: RenderProgressEvent) => void;
  renderConcurrency?: number;
  hardwareAcceleration?: WorkerHardwareAcceleration;
  chromiumGl?: WorkerChromiumGl;
  videoBitrate?: string;
  mediaCacheSizeInBytes?: number;
  offthreadVideoCacheSizeInBytes?: number;
  offthreadVideoThreads?: number;
  localJobStore?: LocalJobStore;
  localRetentionPolicy?: LocalCleanupPolicy;
};

type StreamingRequestInit = RequestInit & {
  duplex: 'half';
};

const UPLOAD_STREAM_BUFFER_BYTES = 1024 * 1024;
const UPLOAD_PROGRESS_INTERVAL_MS = 5_000;
const UPLOAD_PROGRESS_BYTE_INTERVAL = 8 * 1024 * 1024;

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

function formatTransferProgress(downloadedBytes: number, expectedBytes: number | null): string {
  if (expectedBytes === null || expectedBytes <= 0) return formatBytes(downloadedBytes);
  const percent = Math.min(100, Math.round((downloadedBytes / expectedBytes) * 100));
  return `${formatBytes(downloadedBytes)} / ${formatBytes(expectedBytes)}, ${percent}%`;
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
        : `Descargando asset (${event.assetIndex}/${event.assetCount}): ${event.assetKey} (${formatTransferProgress(event.downloadedBytes, event.expectedBytes)})`;
      progressReporter.schedule(19, message, 'asset_prepare', {
        assetKey: event.assetKey,
        assetIndex: event.assetIndex,
        assetCount: event.assetCount,
        phase: event.phase,
        attempt: event.attempt,
        downloadedBytes: event.downloadedBytes,
        expectedBytes: event.expectedBytes,
        elapsedMs: event.elapsedMs,
        bytesPerSecond: event.bytesPerSecond,
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
  const renderStartedAtMs = Date.now();
  await progressReporter.report(25, 'Resolviendo composicion', 'composition_select');
  const chromiumOptions = options.chromiumGl ? { gl: options.chromiumGl } : undefined;
  const composition = await withRemotionBrowser(options.chromiumGl, async (puppeteerInstance) => {
  const selectedComposition = await selectComposition({
    serveUrl,
    id: job.compositionId,
    inputProps: preparedAssets.resolvedProps,
    timeoutInMilliseconds: job.timeoutInMilliseconds,
    binariesDirectory,
    chromiumOptions,
    puppeteerInstance,
  });
  await progressReporter.report(29, 'Composicion resuelta', 'composition_ready', {
    elapsedMs: roundMs(elapsedMsSince(compositionStartedAtMs)),
    durationInFrames: selectedComposition.durationInFrames,
    fps: selectedComposition.fps,
    width: selectedComposition.width,
    height: selectedComposition.height,
    durationSeconds: Math.round(selectedComposition.durationInFrames / selectedComposition.fps),
  });

  let lastPercent = 30;
  let lastRenderStage = '';
  let lastRenderProgressAtMs = 0;
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
    // Reporting every rendered percentage can generate dozens of database writes
    // during a short render. The lease is 180 seconds and the reporter also has a
    // keep-alive, so a three point cadence keeps the job alive without overwhelming
    // the Engine control plane.
    const shouldReport = percent >= lastPercent + 3
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
  const stopRenderKeepAlive = progressReporter.startKeepAlive();
  try {
    await renderMedia({
      composition: selectedComposition,
      serveUrl,
      codec: 'h264',
      outputLocation: outputPath,
      inputProps: preparedAssets.resolvedProps,
      timeoutInMilliseconds: job.timeoutInMilliseconds,
      binariesDirectory,
      chromiumOptions,
      puppeteerInstance,
      concurrency: options.renderConcurrency,
      hardwareAcceleration: options.hardwareAcceleration,
      videoBitrate: options.videoBitrate,
      mediaCacheSizeInBytes: options.mediaCacheSizeInBytes,
      offthreadVideoCacheSizeInBytes: options.offthreadVideoCacheSizeInBytes,
      offthreadVideoThreads: options.offthreadVideoThreads,
      onStart: ({ frameCount, parallelEncoding, resolvedConcurrency }) => {
        progressReporter.schedule(30, 'Remotion inicio el render', 'render_start', {
          frameCount,
          parallelEncoding,
          resolvedConcurrency,
          requestedConcurrency: options.renderConcurrency,
          hardwareAcceleration: options.hardwareAcceleration,
          chromiumGl: options.chromiumGl,
          videoBitrate: options.videoBitrate,
          mediaCacheSizeInBytes: options.mediaCacheSizeInBytes,
          offthreadVideoCacheSizeInBytes: options.offthreadVideoCacheSizeInBytes,
          offthreadVideoThreads: options.offthreadVideoThreads,
        });
      },
      onDownload,
      onProgress: onRenderProgress,
    });
  } finally {
    stopRenderKeepAlive();
  }
  return selectedComposition;
  });
  await progressReporter.report(86, 'Render y encoding terminados', 'render_complete', {
    elapsedMs: roundMs(elapsedMsSince(renderStartedAtMs)),
    totalElapsedMs: roundMs(elapsedMsSince(jobStartedAtMs)),
  });

  const artifactInspection = await inspectMediaArtifact(outputPath);
  assertArtifactMatchesComposition({
    artifact: artifactInspection,
    expectedDurationSeconds: composition.durationInFrames / composition.fps,
    expectedWidth: composition.width,
    expectedHeight: composition.height,
  });
  await progressReporter.report(87, 'Artefacto MP4 validado', 'output_validation', {
    ...artifactInspection,
    requestedHardwareAcceleration: options.hardwareAcceleration,
  });

  const checksumStartedAtMs = Date.now();
  await progressReporter.report(88, 'Calculando checksum del video', 'checksum');
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
    let uploadedBytes = 0;
    let lastReportedBytes = 0;
    let lastReportedAtMs = Date.now();
    const uploadProgressStream = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        uploadedBytes += chunk.length;
        const now = Date.now();
        if (
          uploadedBytes - lastReportedBytes >= UPLOAD_PROGRESS_BYTE_INTERVAL
          || now - lastReportedAtMs >= UPLOAD_PROGRESS_INTERVAL_MS
        ) {
          lastReportedBytes = uploadedBytes;
          lastReportedAtMs = now;
          progressReporter.schedule(
            90,
            `Subiendo video final (${formatTransferProgress(uploadedBytes, stat.size)})`,
            'upload',
            {
              uploadedBytes,
              totalBytes: stat.size,
              elapsedMs: elapsedMsSince(uploadStartedAtMs),
            },
          );
        }
        callback(null, chunk);
      },
    });
    const uploadBody = createReadStream(outputPath, {
      highWaterMark: UPLOAD_STREAM_BUFFER_BYTES,
    }).pipe(uploadProgressStream);
    const uploadRequest: StreamingRequestInit = {
      method: 'PUT',
      headers: {
        'content-type': 'video/mp4',
        'content-length': String(stat.size),
      },
      body: uploadBody as unknown as BodyInit,
      duplex: 'half',
    };
    const stopUploadKeepAlive = progressReporter.startKeepAlive();
    try {
      const uploadResponse = await fetch(job.outputUploadUrl, uploadRequest);
      if (!uploadResponse.ok) {
        throw new Error(`No se pudo subir el video final: HTTP ${uploadResponse.status}`);
      }
    } finally {
      stopUploadKeepAlive();
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
