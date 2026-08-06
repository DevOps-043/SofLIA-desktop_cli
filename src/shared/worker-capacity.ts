export type WorkerPowerProfile = 'light' | 'balanced' | 'high' | 'max';
export type WorkerHardwareAcceleration = 'disable' | 'if-possible' | 'required';
export type WorkerChromiumGl = null | 'swangle' | 'angle' | 'egl' | 'swiftshader' | 'vulkan' | 'angle-egl';

export type WorkerPowerProfileDefinition = {
  id: WorkerPowerProfile;
  label: string;
  maxConcurrentJobs: number;
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

const PROFILE_CONCURRENCY_LIMITS: Record<WorkerPowerProfile, {
  cpuFraction: number;
  minimum: number;
  ceiling: number;
}> = {
  light: { cpuFraction: 0.15, minimum: 1, ceiling: 1 },
  balanced: { cpuFraction: 0.4, minimum: 2, ceiling: 6 },
  high: { cpuFraction: 0.7, minimum: 4, ceiling: 16 },
  max: { cpuFraction: 0.9, minimum: 8, ceiling: 32 },
};

export const DEFAULT_WORKER_POWER_PROFILE: WorkerPowerProfile = 'balanced';

export const WORKER_POWER_PROFILES: WorkerPowerProfileDefinition[] = [
  {
    id: 'light',
    label: 'Ligero',
    maxConcurrentJobs: 1,
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
    renderConcurrency: 4,
    hardwareAcceleration: 'if-possible',
    chromiumGl: 'angle',
    videoBitrate: '8M',
    headline: 'Mayor velocidad con mas uso del equipo',
    bestFor: 'PCs dedicadas, CPU de 8+ nucleos y 32 GB RAM.',
    characteristics: [
      '4 jobs de capacidad reportada',
      'Concurrencia de render ajustada a CPU y RAM',
      'Activa GPU para Chromium y encoding cuando este disponible',
      'Puede elevar temperatura, ventiladores y consumo',
    ],
  },
  {
    id: 'max',
    label: 'Maximo',
    maxConcurrentJobs: 8,
    renderConcurrency: 8,
    hardwareAcceleration: 'if-possible',
    chromiumGl: 'angle',
    videoBitrate: '8M',
    headline: 'Solo para estaciones dedicadas',
    bestFor: 'Workstations o servidores locales que no se usan para operar la app.',
    characteristics: [
      '8 jobs de capacidad reportada',
      'Concurrencia de render ajustada a CPU y RAM',
      'Usa aceleracion GPU automatica para ensamblados finales',
      'Puede dejar el equipo menos responsivo durante renders',
    ],
  },
];

export function getWorkerPowerProfile(profile?: string): WorkerPowerProfileDefinition {
  return WORKER_POWER_PROFILES.find((item) => item.id === profile) || WORKER_POWER_PROFILES[1];
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
