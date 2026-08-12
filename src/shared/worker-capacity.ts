export type WorkerPowerProfile = 'light' | 'balanced' | 'high' | 'max';
export type WorkerHardwareAcceleration = 'disable' | 'if-possible' | 'required';
export type WorkerChromiumGl = null | 'swangle' | 'angle' | 'egl' | 'swiftshader' | 'vulkan' | 'angle-egl';

export type WorkerPowerProfileDefinition = {
  id: WorkerPowerProfile;
  label: string;
  maxConcurrentJobs: number;
  maxParallelPreviews: number;
  renderConcurrency: number;
  hardwareAcceleration: WorkerHardwareAcceleration;
  chromiumGl: WorkerChromiumGl;
  videoBitrate?: string;
  headline: string;
  bestFor: string;
  characteristics: string[];
};

export type WorkerCapacityHardware = {
  cpuLogicalThreads: number;
  memoryTotalBytes: number;
};

const GIB = 1024 * 1024 * 1024;
const RENDER_MEMORY_RESERVE_BYTES = 4 * GIB;
const ESTIMATED_MEMORY_PER_RENDERER_BYTES = 1.25 * GIB;
const MIB = 1024 * 1024;

const PROFILE_CONCURRENCY_LIMITS: Record<WorkerPowerProfile, {
  cpuFraction: number;
  minimum: number;
  ceiling: number;
}> = {
  light: { cpuFraction: 0.15, minimum: 1, ceiling: 1 },
  balanced: { cpuFraction: 0.34, minimum: 2, ceiling: 4 },
  high: { cpuFraction: 0.5, minimum: 3, ceiling: 8 },
  max: { cpuFraction: 0.67, minimum: 4, ceiling: 12 },
};

export const DEFAULT_WORKER_POWER_PROFILE: WorkerPowerProfile = 'balanced';

export const WORKER_POWER_PROFILES: WorkerPowerProfileDefinition[] = [
  {
    id: 'light',
    label: 'Ligero',
    maxConcurrentJobs: 1,
    maxParallelPreviews: 1,
    renderConcurrency: 1,
    hardwareAcceleration: 'disable',
    chromiumGl: null,
    headline: 'Uso bajo y estable',
    bestFor: 'Laptops, equipos de trabajo diario o sesiones mientras haces otras tareas.',
    characteristics: [
      '1 job reportado al backend',
      '1 hilo de render para reducir calor y ruido',
      'Encoding por software para maxima compatibilidad',
      'Prioriza estabilidad sobre velocidad',
    ],
  },
  {
    id: 'balanced',
    label: 'Balanceado',
    maxConcurrentJobs: 2,
    maxParallelPreviews: 2,
    renderConcurrency: 2,
    hardwareAcceleration: 'if-possible',
    chromiumGl: null,
    videoBitrate: '8M',
    headline: 'Recomendado para la mayoria de PCs',
    bestFor: 'Equipos con 4 a 8 nucleos CPU y 16 GB RAM.',
    characteristics: [
      '2 jobs de capacidad reportada',
      'Concurrencia de render ajustada a CPU y RAM',
      'Intenta encoding por GPU si el sistema lo soporta',
      'Buen punto medio para previews y renders normales',
    ],
  },
  {
    id: 'high',
    label: 'Alto',
    maxConcurrentJobs: 4,
    maxParallelPreviews: 2,
    renderConcurrency: 4,
    hardwareAcceleration: 'if-possible',
    chromiumGl: 'angle',
    videoBitrate: '8M',
    headline: 'Mayor velocidad con mas uso del equipo',
    bestFor: 'PCs dedicadas, CPU de 8+ nucleos y 32 GB RAM.',
    characteristics: [
      'Hasta 2 previews simultaneos con presupuesto compartido',
      'Concurrencia de render ajustada a CPU y RAM',
      'Activa GPU para Chromium y encoding cuando este disponible',
      'Puede elevar temperatura, ventiladores y consumo',
    ],
  },
  {
    id: 'max',
    label: 'Maximo',
    maxConcurrentJobs: 3,
    maxParallelPreviews: 3,
    renderConcurrency: 8,
    hardwareAcceleration: 'if-possible',
    chromiumGl: 'angle',
    videoBitrate: '8M',
    headline: 'Solo para estaciones dedicadas',
    bestFor: 'Workstations o servidores locales que no se usan para operar la app.',
    characteristics: [
      'Hasta 3 previews simultaneos con presupuesto compartido',
      'Concurrencia de render ajustada a CPU y RAM',
      'Usa aceleracion GPU automatica para ensamblados finales',
      'Puede dejar el equipo menos responsivo durante renders',
    ],
  },
];

export function getWorkerPowerProfile(profile?: string): WorkerPowerProfileDefinition {
  return WORKER_POWER_PROFILES.find((item) => item.id === profile) || WORKER_POWER_PROFILES[1];
}

export type PreviewExecutionPlan = {
  parallelJobs: number;
  renderConcurrencyPerJob: number;
  totalRenderSlots: number;
};

/**
 * Splits one global renderer budget across concurrent preview jobs. Without
 * this guard every Remotion call may auto-detect the whole CPU independently,
 * which creates nested concurrency and makes all jobs slower under load.
 */
export function resolvePreviewExecutionPlan(input: {
  jobCount: number;
  renderConcurrency?: number;
  maxParallelPreviews?: number;
}): PreviewExecutionPlan {
  const jobCount = normalizePositiveInteger(input.jobCount, 1);
  const totalRenderSlots = normalizePositiveInteger(input.renderConcurrency ?? 1, 1);
  const maxParallelPreviews = normalizePositiveInteger(input.maxParallelPreviews ?? 1, 1);
  const parallelJobs = Math.max(1, Math.min(jobCount, totalRenderSlots, maxParallelPreviews));

  return {
    parallelJobs,
    renderConcurrencyPerJob: Math.max(1, Math.floor(totalRenderSlots / parallelJobs)),
    totalRenderSlots,
  };
}

export type RemotionCacheBudget = {
  mediaCacheSizeInBytes: number;
  offthreadVideoCacheSizeInBytes: number;
  offthreadVideoThreads: number;
};

/** Keeps frequently-seeked media in memory while reserving RAM for Chromium. */
export function resolveRemotionCacheBudget(input: {
  memoryTotalBytes: number;
  renderConcurrency: number;
}): RemotionCacheBudget {
  const totalMemory = Number.isFinite(input.memoryTotalBytes) ? Math.max(0, input.memoryTotalBytes) : 0;
  const cachePool = Math.min(2 * GIB, Math.max(256 * MIB, Math.floor(totalMemory * 0.06)));
  return {
    mediaCacheSizeInBytes: Math.max(128 * MIB, Math.floor(cachePool * 0.6)),
    offthreadVideoCacheSizeInBytes: Math.max(128 * MIB, Math.floor(cachePool * 0.4)),
    offthreadVideoThreads: Math.max(1, Math.min(4, Math.ceil(normalizePositiveInteger(input.renderConcurrency, 1) / 2))),
  };
}

export function divideRemotionCacheBudget(
  budget: RemotionCacheBudget,
  divisor: number,
): RemotionCacheBudget {
  const normalizedDivisor = normalizePositiveInteger(divisor, 1);
  return {
    mediaCacheSizeInBytes: Math.max(64 * MIB, Math.floor(budget.mediaCacheSizeInBytes / normalizedDivisor)),
    offthreadVideoCacheSizeInBytes: Math.max(64 * MIB, Math.floor(budget.offthreadVideoCacheSizeInBytes / normalizedDivisor)),
    offthreadVideoThreads: Math.max(1, Math.floor(budget.offthreadVideoThreads / normalizedDivisor)),
  };
}

/**
 * Resolves a profile into a safe per-machine render concurrency.
 * Remotion opens one browser page per concurrent renderer, so CPU alone is not
 * enough: the memory budget must also be respected to avoid swapping and slower
 * renders on lower-end PCs.
 */
export function resolveWorkerPowerProfile(
  profile: string | undefined,
  hardware: WorkerCapacityHardware,
): WorkerPowerProfileDefinition {
  const definition = getWorkerPowerProfile(profile);
  const limits = PROFILE_CONCURRENCY_LIMITS[definition.id];
  const cpuLogicalThreads = normalizePositiveInteger(hardware.cpuLogicalThreads, 1);
  const memoryTotalBytes = Number.isFinite(hardware.memoryTotalBytes)
    ? Math.max(0, hardware.memoryTotalBytes)
    : 0;
  const cpuTarget = Math.max(limits.minimum, Math.floor(cpuLogicalThreads * limits.cpuFraction));
  const memoryBudget = Math.max(
    ESTIMATED_MEMORY_PER_RENDERER_BYTES,
    memoryTotalBytes - RENDER_MEMORY_RESERVE_BYTES,
  );
  const memoryLimit = memoryTotalBytes > 0
    ? Math.max(1, Math.floor(memoryBudget / ESTIMATED_MEMORY_PER_RENDERER_BYTES))
    : cpuLogicalThreads;
  const renderConcurrency = Math.max(
    1,
    Math.min(cpuLogicalThreads, cpuTarget, memoryLimit, limits.ceiling),
  );

  return {
    ...definition,
    renderConcurrency,
  };
}

function normalizePositiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : fallback;
}
