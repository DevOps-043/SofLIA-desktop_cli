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
      '2 hilos de render para acelerar sin saturar',
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
      '4 hilos de render para trabajos pesados',
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
      '8 hilos de render para explotar hardware disponible',
      'Usa aceleracion GPU automatica para ensamblados finales',
      'Puede dejar el equipo menos responsivo durante renders',
    ],
  },
];

export function getWorkerPowerProfile(profile?: string): WorkerPowerProfileDefinition {
  return WORKER_POWER_PROFILES.find((item) => item.id === profile) || WORKER_POWER_PROFILES[1];
}
