export type WorkerRuntimeState =
  | 'starting'
  | 'online'
  | 'idle'
  | 'claiming'
  | 'rendering'
  | 'completed'
  | 'error'
  | 'stopped';

export type WorkerRuntimeEvent = {
  state: WorkerRuntimeState;
  message: string;
  jobId?: string;
  compositionId?: string;
  percent?: number;
  stage?: string;
  jobTitle?: string;
  queuePosition?: number;
  queueTotal?: number;
  detail?: Record<string, unknown>;
};

export type RenderProgressEvent = Pick<
  WorkerRuntimeEvent,
  'jobId' | 'compositionId' | 'percent' | 'stage' | 'message'
>;
