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
  jobType?: 'render' | 'template_build' | 'template_preview';
  jobId?: string;
  buildId?: string;
  templateVersionId?: string;
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
  'jobId' | 'jobType' | 'buildId' | 'templateVersionId' | 'compositionId' | 'percent' | 'stage' | 'message' | 'detail'
>;
