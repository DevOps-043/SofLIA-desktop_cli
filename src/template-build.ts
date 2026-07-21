import crypto from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { ensureBrowser, selectComposition } from '@remotion/renderer';
import JSZip from 'jszip';
import type { ClaimedTemplateBuildJob, SofliaWorkerApiClient } from './api-client.js';
import { downloadAndExtractBundle } from './bundle.js';
import { getWorkspaceDir } from './paths.js';
import { getRemotionBinariesDirectory } from './remotion-binaries.js';
import type { RenderProgressEvent } from './shared/worker-events.js';

type TemplateManifest = {
  entryPoint?: string;
  compositionId?: string;
  exportMode?: 'component' | 'root';
  defaultDurationFrames?: number;
  fps?: number;
  width?: number;
  height?: number;
  defaultProps?: Record<string, unknown>;
};

type BuildTemplateJobOptions = {
  onProgress?: (event: RenderProgressEvent) => void;
};

const WORKER_NODE_MODULES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules');

async function reportProgress(
  client: SofliaWorkerApiClient,
  job: ClaimedTemplateBuildJob,
  percent: number,
  message: string,
  stage: string,
  onProgress?: (event: RenderProgressEvent) => void,
  detail?: Record<string, unknown>,
) {
  onProgress?.({
    jobType: 'template_build',
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

async function readManifest(bundleRoot: string): Promise<TemplateManifest> {
  const manifestPath = path.join(bundleRoot, 'courseforge-remotion-template.json');
  const raw = await fsp.readFile(manifestPath, 'utf8');
  return JSON.parse(raw) as TemplateManifest;
}

function assertInsideDirectory(parentDir: string, targetPath: string): void {
  const relativePath = path.relative(parentDir, targetPath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`Entry point inseguro fuera del bundle: ${relativePath}`);
  }
}

function normalizeRelativeImport(filePath: string): string {
  const withoutExtension = filePath.replace(/\.(tsx?|jsx?)$/i, '');
  return `./${withoutExtension.replace(/\\/g, '/')}`;
}

export async function prepareTemplateEntryPoint(
  bundleRoot: string,
  manifest: TemplateManifest,
  claimedCompositionId: string,
): Promise<string> {
  const manifestEntryPoint = manifest.entryPoint || 'src/index.tsx';
  const entryPoint = path.resolve(bundleRoot, manifestEntryPoint);
  assertInsideDirectory(bundleRoot, entryPoint);

  if ((manifest.exportMode || 'component') === 'root') return entryPoint;

  const relativeEntryPoint = path.relative(bundleRoot, entryPoint);
  const wrapperPath = path.join(bundleRoot, '.soflia-worker-entry.tsx');
  const compositionId = manifest.compositionId || claimedCompositionId;
  const durationInFrames = Number.isInteger(manifest.defaultDurationFrames) && Number(manifest.defaultDurationFrames) > 0
    ? Number(manifest.defaultDurationFrames)
    : 150;
  const fps = Number.isInteger(manifest.fps) && Number(manifest.fps) > 0 ? Number(manifest.fps) : 30;
  const width = Number.isInteger(manifest.width) && Number(manifest.width) > 0 ? Number(manifest.width) : 1920;
  const height = Number.isInteger(manifest.height) && Number(manifest.height) > 0 ? Number(manifest.height) : 1080;
  const defaultProps = JSON.stringify(manifest.defaultProps || {}, null, 2);

  await fsp.writeFile(wrapperPath, `import React from 'react';
import { Composition, registerRoot } from 'remotion';
import * as TemplateModule from ${JSON.stringify(normalizeRelativeImport(relativeEntryPoint))};

const TemplateComponent =
  (TemplateModule as any).default ||
  (TemplateModule as any).Template ||
  (TemplateModule as any).MyComposition ||
  (TemplateModule as any).Composition;
const calculateMetadata = typeof (TemplateModule as any).calculateMetadata === 'function'
  ? (TemplateModule as any).calculateMetadata
  : undefined;
const defaultProps = ${defaultProps};

function SofliaTemplateRoot() {
  if (!TemplateComponent) {
    throw new Error('El bundle component debe exportar default, Template, MyComposition o Composition.');
  }

  return (
    <Composition
      id=${JSON.stringify(compositionId)}
      component={TemplateComponent as React.ComponentType<any>}
      calculateMetadata={calculateMetadata}
      durationInFrames={${durationInFrames}}
      fps={${fps}}
      width={${width}}
      height={${height}}
      defaultProps={defaultProps}
    />
  );
}

registerRoot(SofliaTemplateRoot);
`);

  return wrapperPath;
}

async function zipDirectory(sourceDir: string): Promise<Buffer> {
  const zip = new JSZip();

  async function addDirectory(currentDir: string, prefix = '') {
    const entries = await fsp.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await addDirectory(absolutePath, relativePath);
      } else if (entry.isFile()) {
        zip.file(relativePath, await fsp.readFile(absolutePath));
      }
    }
  }

  await addDirectory(sourceDir);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function sha256Buffer(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export async function buildTemplateJob(
  client: SofliaWorkerApiClient,
  job: ClaimedTemplateBuildJob,
  options: BuildTemplateJobOptions = {},
): Promise<void> {
  const binariesDirectory = getRemotionBinariesDirectory();
  await reportProgress(client, job, 10, 'Descargando ZIP fuente de plantilla', 'template_source_download', options.onProgress, {
    buildId: job.buildId,
    templateVersionId: job.templateVersionId,
    bundleHash: job.bundleHash,
    source: 'ZIP firmado desde SofLIA',
  });
  const bundleRoot = await downloadAndExtractBundle(job.bundleUrl, job.bundleHash, { requireSha256: true });
  const manifest = await readManifest(bundleRoot);
  const entryPoint = await prepareTemplateEntryPoint(bundleRoot, manifest, job.compositionId);
  const outDir = path.join(getWorkspaceDir(), 'template-builds', job.buildId);

  await fsp.rm(outDir, { recursive: true, force: true });
  await fsp.mkdir(outDir, { recursive: true });

  await reportProgress(client, job, 35, 'Compilando plantilla Remotion', 'template_bundle', options.onProgress, {
    manifest: 'courseforge-remotion-template.json',
    entryPoint,
    bundleRoot,
    outputDirectory: outDir,
    exportMode: job.exportMode,
  });
  const serveUrl = await bundle({
    entryPoint,
    outDir,
    webpackOverride: (config) => {
      const currentModules = Array.isArray(config.resolve?.modules) ? config.resolve.modules : [];
      return {
        ...config,
        resolve: {
          ...config.resolve,
          modules: [WORKER_NODE_MODULES_DIR, ...currentModules],
        },
      };
    },
  });

  await reportProgress(client, job, 70, 'Validando composicion compilada', 'template_validate', options.onProgress, {
    compositionId: job.compositionId,
    serveUrl,
    defaultProps: Object.keys(manifest.defaultProps || {}),
  });
  await ensureBrowser();
  await selectComposition({
    serveUrl,
    id: job.compositionId,
    inputProps: manifest.defaultProps || {},
    timeoutInMilliseconds: job.timeoutInMilliseconds,
    binariesDirectory,
  });

  await reportProgress(client, job, 85, 'Empaquetando build compilado', 'template_zip', options.onProgress, {
    outputDirectory: outDir,
    artifact: 'compiled-remotion-zip',
  });
  const compiledZip = await zipDirectory(outDir);
  const buildHash = sha256Buffer(compiledZip);

  await reportProgress(client, job, 92, 'Subiendo build compilado', 'template_upload', options.onProgress, {
    outputStoragePath: job.outputStoragePath,
    buildHash,
    sizeBytes: compiledZip.byteLength,
  });
  const uploadResponse = await fetch(job.outputUploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'application/zip' },
    body: new Blob([new Uint8Array(compiledZip)]),
  });
  if (!uploadResponse.ok) {
    throw new Error(`No se pudo subir el build compilado: HTTP ${uploadResponse.status}`);
  }

  await client.complete(job.jobId, {
    outputStoragePath: job.outputStoragePath,
    checksum: buildHash,
    buildHash,
    buildLog: `Template build completed locally. compositionId=${job.compositionId}`,
  });
}
