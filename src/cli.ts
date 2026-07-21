#!/usr/bin/env node
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import { SofliaWorkerApiClient } from './api-client.js';
import { loadConfig, saveConfig } from './config.js';
import { log, logError, sanitizeLog } from './logging.js';
import { configureWritableWorkingDirectory, getConfigPath, getWorkspaceDir } from './paths.js';
import { renderClaimedJob } from './render.js';
import { startWorkerLoop } from './worker-loop.js';

function parseArgs(argv: string[]): { command: string; flags: Record<string, string> } {
  const [command = 'help', ...rest] = argv;
  const flags: Record<string, string> = {};

  for (let index = 0; index < rest.length; index += 1) {
    const current = rest[index];
    if (!current.startsWith('--')) continue;
    const key = current.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = 'true';
    } else {
      flags[key] = next;
      index += 1;
    }
  }

  return { command, flags };
}

function printHelp(): void {
  console.log(`SofLIA - Engine Render Worker

Commands:
  link --api-url <url> --code <SLIA-000000>
  configure --api-url <url> --token <worker_token>
  doctor
  render --job-id <production_job_id>
  start [--poll-interval-ms <ms>]
`);
}

function normalizeApiUrl(apiUrl: string): string {
  return apiUrl.replace(/\/+$/, '');
}

function getAppVersion(): string {
  return process.env.npm_package_version || 'dev';
}

configureWritableWorkingDirectory();

async function runConfigure(flags: Record<string, string>) {
  if (!flags['api-url'] || !flags.token) {
    throw new Error('configure requiere --api-url y --token');
  }

  await saveConfig({
    apiUrl: normalizeApiUrl(flags['api-url']),
    token: flags.token,
  });
  log(`Configuracion guardada en ${getConfigPath()}`);
}

async function runLink(flags: Record<string, string>) {
  if (!flags['api-url'] || !flags.code) {
    throw new Error('link requiere --api-url y --code');
  }

  const apiUrl = normalizeApiUrl(flags['api-url']);
  const client = new SofliaWorkerApiClient(apiUrl);
  const result = await client.linkWorker({
    code: flags.code,
    deviceName: flags['device-name'] || os.hostname() || 'SofLIA Render Worker',
    platform: process.platform,
    arch: process.arch,
    appVersion: getAppVersion(),
  });

  await saveConfig({
    apiUrl,
    token: result.workerToken,
  });

  const authenticatedClient = new SofliaWorkerApiClient(apiUrl, result.workerToken);
  const linkedConfig = await loadConfig();
  await authenticatedClient.heartbeat('ONLINE', { maxConcurrentJobs: linkedConfig.maxConcurrentJobs });

  log(`Worker vinculado y configuracion guardada en ${getConfigPath()}`, {
    workerId: result.worker.id,
    deviceName: result.worker.device_name,
    status: 'ONLINE',
    tokenLast4: result.worker.token_last4,
  });
  console.log('Listo. Puedes ejecutar: node dist/cli.js doctor');
}

async function runDoctor() {
  const config = await loadConfig();
  const workspace = getWorkspaceDir();
  await fsp.mkdir(workspace, { recursive: true });
  await fsp.access(workspace);

  const client = new SofliaWorkerApiClient(config.apiUrl, config.token);
  await client.heartbeat('ONLINE', { maxConcurrentJobs: config.maxConcurrentJobs });

  console.log('SofLIA - Engine Render Worker Doctor');
  console.log(`OK OS: ${process.platform} ${process.arch}`);
  console.log(`OK Node: ${process.version}`);
  console.log(`OK API: ${config.apiUrl}`);
  console.log(`OK Workspace: ${workspace}`);
  console.log('OK Token: valido');
  console.log('Listo para renderizar.');
}

async function runRender(flags: Record<string, string>) {
  const jobId = flags['job-id'];
  if (!jobId) {
    throw new Error('render requiere --job-id <production_job_id>');
  }

  const config = await loadConfig();
  const client = new SofliaWorkerApiClient(config.apiUrl, config.token);

  try {
    await client.heartbeat('BUSY', { maxConcurrentJobs: config.maxConcurrentJobs });
    const job = await client.claim(jobId);
    if (job.jobType === 'template_build' || job.jobType === 'template_preview') {
      throw new Error('El comando render solo acepta jobs de render. Usa start para procesar builds y previews de plantilla.');
    }
    log('Job reclamado', {
      jobId: job.jobId,
      compositionId: job.compositionId,
      bundleHash: job.bundleHash,
      propsHash: job.propsHash,
    });
    await renderClaimedJob(client, job, { renderConcurrency: config.renderConcurrency });
    log('Render completado', { jobId });
  } catch (error) {
    const message = sanitizeLog(error instanceof Error ? error.message : String(error));
    try {
      await client.fail(jobId, {
        errorCode: 'DESKTOP_WORKER_RENDER_FAILED',
        message,
        stage: 'cli_render',
      });
    } catch (failError) {
      logError('No se pudo reportar el fallo al API:', failError);
    }
    throw error;
  }
}

async function runStart(flags: Record<string, string>) {
  const pollIntervalMs = flags['poll-interval-ms'] ? Number(flags['poll-interval-ms']) : undefined;
  await startWorkerLoop({
    pollIntervalMs: Number.isFinite(pollIntervalMs) && pollIntervalMs ? pollIntervalMs : undefined,
  });
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (command === 'configure') {
    await runConfigure(flags);
    return;
  }
  if (command === 'link') {
    await runLink(flags);
    return;
  }
  if (command === 'doctor') {
    await runDoctor();
    return;
  }
  if (command === 'render') {
    await runRender(flags);
    return;
  }
  if (command === 'start') {
    await runStart(flags);
    return;
  }

  printHelp();
}

main().catch((error) => {
  logError('Error:', error);
  process.exit(1);
});
