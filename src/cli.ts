#!/usr/bin/env node
import * as fsp from 'node:fs/promises';
import { SofliaWorkerApiClient } from './api-client.js';
import { loadConfig, saveConfig } from './config.js';
import { log, logError, sanitizeLog } from './logging.js';
import { getConfigPath, getWorkspaceDir } from './paths.js';
import { renderClaimedJob } from './render.js';

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
  configure --api-url <url> --token <worker_token>
  doctor
  render --job-id <production_job_id>
  start
`);
}

async function runConfigure(flags: Record<string, string>) {
  if (!flags['api-url'] || !flags.token) {
    throw new Error('configure requiere --api-url y --token');
  }

  await saveConfig({
    apiUrl: flags['api-url'],
    token: flags.token,
  });
  log(`Configuracion guardada en ${getConfigPath()}`);
}

async function runDoctor() {
  const config = await loadConfig();
  const workspace = getWorkspaceDir();
  await fsp.mkdir(workspace, { recursive: true });
  await fsp.access(workspace);

  const client = new SofliaWorkerApiClient(config.apiUrl, config.token);
  await client.heartbeat('ONLINE');

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
    await client.heartbeat('BUSY');
    const job = await client.claim(jobId);
    log('Job reclamado', {
      jobId: job.jobId,
      compositionId: job.compositionId,
      bundleHash: job.bundleHash,
      propsHash: job.propsHash,
    });
    await renderClaimedJob(client, job);
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

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (command === 'configure') {
    await runConfigure(flags);
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
    throw new Error('start queda reservado para MVP 2. Usa render --job-id en MVP 1.');
  }

  printHelp();
}

main().catch((error) => {
  logError('Error:', error);
  process.exit(1);
});
