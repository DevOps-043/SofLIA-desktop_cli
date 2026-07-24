import type { WorkerRuntimeEvent, WorkerRuntimeState } from './worker-events.js';

export type ResourceActiveJob = Partial<Pick<
  WorkerRuntimeEvent,
  'jobId' | 'jobType' | 'buildId' | 'compositionId' | 'percent' | 'stage' | 'message'
>>;

export type ResourceProcessMetric = {
  pid: number;
  parentPid?: number;
  name: string;
  type: string;
  cpuPercent: number;
  memoryBytes: number;
};

export type ResourceMetricsSnapshot = {
  sampledAt: string;
  platform: NodeJS.Platform;
  workerState: WorkerRuntimeState;
  unavailableReason?: string;
  system: {
    cpuPercent: number;
    gpuPercent: number;
    gpuUnavailableReason?: string;
    memoryUsedBytes: number;
    memoryTotalBytes: number;
    cpuCount: number;
  };
  app: {
    cpuPercent: number;
    gpuPercent: number;
    gpuUnavailableReason?: string;
    memoryBytes: number;
    processCount: number;
    unavailableReason?: string;
  };
  processes: ResourceProcessMetric[];
  activeJob?: ResourceActiveJob;
};
