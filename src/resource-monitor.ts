import { execFile } from 'node:child_process';
import * as os from 'node:os';
import type { ResourceActiveJob, ResourceMetricsSnapshot, ResourceProcessMetric } from './shared/resource-metrics.js';
import type { WorkerRuntimeState } from './shared/worker-events.js';

const SAMPLE_INTERVAL_MS = 2500;

type CpuTimesSample = {
  idleMs: number;
  totalMs: number;
};

export type RawProcessRow = {
  pid: number;
  parentPid?: number;
  name: string;
  workingSetBytes?: number;
  cpuTimeMs?: number;
};

export type RawGpuEngineRow = {
  pid?: number;
  instanceName: string;
  utilizationPercent: number;
};

type ElectronProcessMetricLike = {
  pid: number;
  type: string;
  name?: string;
  serviceName?: string;
  cpu?: {
    percentCPUUsage?: number;
  };
  memory?: {
    workingSetSize?: number;
  };
};

export type ResourceMonitorContext = {
  workerState: WorkerRuntimeState;
  activeJob?: ResourceActiveJob;
};

type ResourceMonitorDependencies = {
  platform?: NodeJS.Platform;
  rootPid?: number;
  cpuCount?: number;
  now?: () => number;
  getCpuTimes?: () => CpuTimesSample;
  getMemoryInfo?: () => { totalBytes: number; freeBytes: number };
  getElectronAppMetrics?: () => ElectronProcessMetricLike[];
  getProcessRows?: (rootPid: number) => Promise<RawProcessRow[]>;
  getGpuEngineRows?: () => Promise<RawGpuEngineRow[]>;
};

type ProcessCpuSample = {
  cpuTimeMs: number;
  sampledAt: number;
};

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export function calculateCpuPercent(
  previous: ProcessCpuSample | undefined,
  current: ProcessCpuSample,
  cpuCount: number,
): number {
  if (!previous) return 0;
  const elapsedMs = current.sampledAt - previous.sampledAt;
  const cpuDeltaMs = current.cpuTimeMs - previous.cpuTimeMs;
  if (elapsedMs <= 0 || cpuDeltaMs < 0 || cpuCount <= 0) return 0;
  return clampPercent((cpuDeltaMs / elapsedMs / cpuCount) * 100);
}

export function buildProcessTree(rows: RawProcessRow[], rootPid: number): RawProcessRow[] {
  const byPid = new Map<number, RawProcessRow>();
  const childrenByParent = new Map<number, RawProcessRow[]>();
  for (const row of rows) {
    byPid.set(row.pid, row);
    if (row.parentPid === undefined) continue;
    const children = childrenByParent.get(row.parentPid) || [];
    children.push(row);
    childrenByParent.set(row.parentPid, children);
  }

  const tree: RawProcessRow[] = [];
  const seen = new Set<number>();
  const queue = byPid.has(rootPid) ? [byPid.get(rootPid)!] : childrenByParent.get(rootPid) || [];
  while (queue.length > 0) {
    const row = queue.shift()!;
    if (seen.has(row.pid)) continue;
    seen.add(row.pid);
    tree.push(row);
    queue.push(...(childrenByParent.get(row.pid) || []));
  }
  return tree;
}

function getCpuTimes(): CpuTimesSample {
  return os.cpus().reduce<CpuTimesSample>((total, cpu) => {
    const cpuTotalMs = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    return {
      idleMs: total.idleMs + cpu.times.idle,
      totalMs: total.totalMs + cpuTotalMs,
    };
  }, { idleMs: 0, totalMs: 0 });
}

function getMemoryInfo() {
  return {
    totalBytes: os.totalmem(),
    freeBytes: os.freemem(),
  };
}

function parseNumeric(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeWindowsProcessRow(value: unknown): RawProcessRow | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const pid = parseNumeric(row.ProcessId ?? row.processId ?? row.pid);
  if (pid === undefined) return null;
  const kernelTime100Ns = parseNumeric(row.KernelModeTime ?? row.kernelModeTime);
  const userTime100Ns = parseNumeric(row.UserModeTime ?? row.userModeTime);
  return {
    pid,
    parentPid: parseNumeric(row.ParentProcessId ?? row.parentProcessId ?? row.parentPid),
    name: String(row.Name ?? row.name ?? `PID ${pid}`),
    workingSetBytes: parseNumeric(row.WorkingSetSize ?? row.workingSetSize),
    cpuTimeMs: kernelTime100Ns !== undefined || userTime100Ns !== undefined
      ? ((kernelTime100Ns || 0) + (userTime100Ns || 0)) / 10000
      : undefined,
  };
}

function normalizeWindowsGpuEngineRow(value: unknown): RawGpuEngineRow | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const instanceName = String(row.InstanceName ?? row.instanceName ?? '');
  if (!instanceName) return null;
  const utilizationPercent = parseNumeric(row.CookedValue ?? row.cookedValue) || 0;
  const pidMatch = instanceName.match(/pid_(\d+)/i);
  return {
    pid: pidMatch ? Number(pidMatch[1]) : undefined,
    instanceName,
    utilizationPercent: clampPercent(utilizationPercent),
  };
}

export async function getWindowsProcessRows(): Promise<RawProcessRow[]> {
  const script = [
    "$ErrorActionPreference='Stop'",
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,KernelModeTime,UserModeTime | ConvertTo-Json -Compress',
  ].join('; ');
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 1500, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
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
  return rows.map(normalizeWindowsProcessRow).filter((row): row is RawProcessRow => Boolean(row));
}

export async function getWindowsGpuEngineRows(): Promise<RawGpuEngineRow[]> {
  const script = [
    "$ErrorActionPreference='Stop'",
    "Get-Counter '\\GPU Engine(*)\\Utilization Percentage' | Select-Object -ExpandProperty CounterSamples | Select-Object InstanceName,CookedValue | ConvertTo-Json -Compress",
  ].join('; ');
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 1500, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
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
  return rows.map(normalizeWindowsGpuEngineRow).filter((row): row is RawGpuEngineRow => Boolean(row));
}

function getSystemCpuPercent(previous: CpuTimesSample | undefined, current: CpuTimesSample): number {
  if (!previous) return 0;
  const totalDelta = current.totalMs - previous.totalMs;
  const idleDelta = current.idleMs - previous.idleMs;
  if (totalDelta <= 0 || idleDelta < 0) return 0;
  return clampPercent(((totalDelta - idleDelta) / totalDelta) * 100);
}

function getElectronProcessMetrics(metrics: ElectronProcessMetricLike[]): ResourceProcessMetric[] {
  return metrics.map((metric) => ({
    pid: metric.pid,
    name: metric.name || metric.serviceName || metric.type || `PID ${metric.pid}`,
    type: metric.type || 'Electron',
    cpuPercent: clampPercent(metric.cpu?.percentCPUUsage || 0),
    memoryBytes: Math.max(0, (metric.memory?.workingSetSize || 0) * 1024),
  }));
}

function summarizeGpuRows(rows: RawGpuEngineRow[], appProcessPids: Set<number>) {
  const systemGpuPercent = clampPercent(rows.reduce((sum, row) => sum + row.utilizationPercent, 0));
  const appGpuPercent = clampPercent(rows.reduce((sum, row) => {
    return row.pid !== undefined && appProcessPids.has(row.pid) ? sum + row.utilizationPercent : sum;
  }, 0));
  return { systemGpuPercent, appGpuPercent };
}

export class ResourceMonitor {
  private readonly platform: NodeJS.Platform;
  private readonly rootPid: number;
  private readonly cpuCount: number;
  private readonly now: () => number;
  private readonly readCpuTimes: () => CpuTimesSample;
  private readonly readMemoryInfo: () => { totalBytes: number; freeBytes: number };
  private readonly getElectronAppMetrics?: () => ElectronProcessMetricLike[];
  private readonly getProcessRows?: (rootPid: number) => Promise<RawProcessRow[]>;
  private readonly getGpuEngineRows?: () => Promise<RawGpuEngineRow[]>;
  private previousCpuTimes?: CpuTimesSample;
  private previousProcessCpu = new Map<number, ProcessCpuSample>();
  private interval: NodeJS.Timeout | null = null;
  private latest: ResourceMetricsSnapshot | null = null;

  constructor(dependencies: ResourceMonitorDependencies = {}) {
    this.platform = dependencies.platform || process.platform;
    this.rootPid = dependencies.rootPid || process.pid;
    this.cpuCount = Math.max(1, dependencies.cpuCount || os.cpus().length || 1);
    this.now = dependencies.now || Date.now;
    this.readCpuTimes = dependencies.getCpuTimes || getCpuTimes;
    this.readMemoryInfo = dependencies.getMemoryInfo || getMemoryInfo;
    this.getElectronAppMetrics = dependencies.getElectronAppMetrics;
    this.getProcessRows = dependencies.getProcessRows
      || (this.platform === 'win32' ? () => getWindowsProcessRows() : undefined);
    this.getGpuEngineRows = dependencies.getGpuEngineRows
      || (this.platform === 'win32' ? () => getWindowsGpuEngineRows() : undefined);
  }

  getLatest(): ResourceMetricsSnapshot | null {
    return this.latest;
  }

  async sample(context: ResourceMonitorContext): Promise<ResourceMetricsSnapshot> {
    const sampledAtMs = this.now();
    const cpuTimes = this.readCpuTimes();
    const memoryInfo = this.readMemoryInfo();
    const systemCpuPercent = getSystemCpuPercent(this.previousCpuTimes, cpuTimes);
    this.previousCpuTimes = cpuTimes;

    const electronMetrics = this.getElectronAppMetrics?.() || [];
    const electronByPid = new Map(electronMetrics.map((metric) => [metric.pid, metric]));
    let processes: ResourceProcessMetric[] = [];
    let unavailableReason: string | undefined;

    try {
      const processRows = this.getProcessRows ? buildProcessTree(await this.getProcessRows(this.rootPid), this.rootPid) : [];
      if (processRows.length > 0) {
        processes = processRows.map((row) => {
          const currentCpu = { cpuTimeMs: row.cpuTimeMs || 0, sampledAt: sampledAtMs };
          const cpuPercent = row.cpuTimeMs === undefined
            ? 0
            : calculateCpuPercent(this.previousProcessCpu.get(row.pid), currentCpu, this.cpuCount);
          this.previousProcessCpu.set(row.pid, currentCpu);
          const electronMetric = electronByPid.get(row.pid);
          return {
            pid: row.pid,
            parentPid: row.parentPid,
            name: row.name || electronMetric?.name || electronMetric?.serviceName || `PID ${row.pid}`,
            type: electronMetric?.type || 'Child',
            cpuPercent,
            memoryBytes: Math.max(0, row.workingSetBytes || 0),
          };
        });
      } else {
        unavailableReason = this.platform === 'win32'
          ? 'No se encontraron procesos descendientes del worker.'
          : 'El arbol de procesos externo solo esta disponible en Windows para esta version.';
      }
    } catch {
      unavailableReason = 'No se pudo leer el arbol de procesos del sistema.';
    }

    if (processes.length === 0 && electronMetrics.length > 0) {
      processes = getElectronProcessMetrics(electronMetrics);
    }

    const processPids = new Set(processes.map((metric) => metric.pid));
    let systemGpuPercent = 0;
    let appGpuPercent = 0;
    let gpuUnavailableReason: string | undefined;
    try {
      const gpuRows = this.getGpuEngineRows ? await this.getGpuEngineRows() : [];
      if (gpuRows.length > 0) {
        const gpuSummary = summarizeGpuRows(gpuRows, processPids);
        systemGpuPercent = gpuSummary.systemGpuPercent;
        appGpuPercent = gpuSummary.appGpuPercent;
      } else {
        gpuUnavailableReason = this.platform === 'win32'
          ? 'No se encontraron contadores de GPU Engine.'
          : 'La lectura de GPU solo esta disponible en Windows para esta version.';
      }
    } catch {
      gpuUnavailableReason = 'No se pudo leer el uso de GPU del sistema.';
    }

    processes.sort((left, right) => {
      const cpuDelta = right.cpuPercent - left.cpuPercent;
      return Math.abs(cpuDelta) > 0.01 ? cpuDelta : right.memoryBytes - left.memoryBytes;
    });

    const appCpuPercent = clampPercent(processes.reduce((sum, metric) => sum + metric.cpuPercent, 0));
    const appMemoryBytes = processes.reduce((sum, metric) => sum + metric.memoryBytes, 0);
    const snapshot: ResourceMetricsSnapshot = {
      sampledAt: new Date(sampledAtMs).toISOString(),
      platform: this.platform,
      workerState: context.workerState,
      unavailableReason,
      system: {
        cpuPercent: systemCpuPercent,
        gpuPercent: systemGpuPercent,
        gpuUnavailableReason,
        memoryUsedBytes: Math.max(0, memoryInfo.totalBytes - memoryInfo.freeBytes),
        memoryTotalBytes: Math.max(0, memoryInfo.totalBytes),
        cpuCount: this.cpuCount,
      },
      app: {
        cpuPercent: appCpuPercent,
        gpuPercent: appGpuPercent,
        gpuUnavailableReason,
        memoryBytes: appMemoryBytes,
        processCount: processes.length,
        unavailableReason: unavailableReason && electronMetrics.length === 0 ? unavailableReason : undefined,
      },
      processes,
      activeJob: context.activeJob,
    };
    this.latest = snapshot;
    return snapshot;
  }

  start(
    getContext: () => ResourceMonitorContext,
    onSnapshot: (snapshot: ResourceMetricsSnapshot) => void,
    intervalMs = SAMPLE_INTERVAL_MS,
  ): void {
    if (this.interval) return;
    const publish = () => {
      void this.sample(getContext()).then(onSnapshot).catch(() => {
        // Metrics are diagnostic only; failures must not affect rendering.
      });
    };
    publish();
    this.interval = setInterval(publish, intervalMs);
  }

  stop(): void {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
  }
}
