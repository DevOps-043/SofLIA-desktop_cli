import { execFile } from 'node:child_process';
import * as os from 'node:os';
import type { WorkerGpuAdapterSnapshot, WorkerHardwareSnapshot } from './shared/worker-telemetry.js';

function parseNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sanitizeText(value: unknown, maxLength = 160): string | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function normalizeGpuAdapter(value: unknown): WorkerGpuAdapterSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const name = sanitizeText(row.Name ?? row.name);
  if (!name) return null;
  const memoryBytes = parseNumber(row.AdapterRAM ?? row.adapterRam);
  return {
    name,
    vendor: sanitizeText(row.AdapterCompatibility ?? row.adapterCompatibility, 120),
    memoryBytes: memoryBytes !== undefined && memoryBytes > 0 ? memoryBytes : undefined,
    driverVersion: sanitizeText(row.DriverVersion ?? row.driverVersion, 80),
    videoProcessor: sanitizeText(row.VideoProcessor ?? row.videoProcessor, 160),
  };
}

async function readWindowsGpuAdapters(): Promise<WorkerGpuAdapterSnapshot[]> {
  const script = [
    "$ErrorActionPreference='Stop'",
    'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterCompatibility,AdapterRAM,DriverVersion,VideoProcessor | ConvertTo-Json -Compress',
  ].join('; ');
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 2500, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, output) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(output);
      },
    );
  });

  const parsed = JSON.parse(stdout || '[]') as unknown;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map(normalizeGpuAdapter).filter((row): row is WorkerGpuAdapterSnapshot => Boolean(row));
}

export async function readWorkerHardwareSnapshot(): Promise<WorkerHardwareSnapshot> {
  let gpuAdapters: WorkerGpuAdapterSnapshot[] = [];
  if (process.platform === 'win32') {
    try {
      gpuAdapters = await readWindowsGpuAdapters();
    } catch {
      gpuAdapters = [];
    }
  }

  const cpus = os.cpus();
  const availableParallelism = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : cpus.length;
  return {
    platform: process.platform,
    arch: process.arch,
    cpuModel: sanitizeText(cpus[0]?.model, 160),
    cpuLogicalThreads: Math.max(1, availableParallelism || 1),
    memoryTotalBytes: Math.max(0, os.totalmem()),
    gpuAdapters,
  };
}
