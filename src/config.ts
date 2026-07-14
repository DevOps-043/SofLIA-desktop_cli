import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { getConfigPath } from './paths.js';

export interface WorkerConfig {
  apiUrl: string;
  token: string;
  closeToTray?: boolean;
}

export async function loadOptionalConfig(): Promise<Partial<WorkerConfig>> {
  try {
    const raw = await fsp.readFile(getConfigPath(), 'utf8');
    return JSON.parse(raw) as Partial<WorkerConfig>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export async function saveConfig(config: WorkerConfig): Promise<void> {
  const configPath = getConfigPath();
  const current = await loadOptionalConfig();
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  await fsp.writeFile(configPath, `${JSON.stringify({ ...current, ...config }, null, 2)}\n`, { mode: 0o600 });
}

export async function saveConfigSettings(settings: Pick<WorkerConfig, 'closeToTray'>): Promise<void> {
  const configPath = getConfigPath();
  const current = await loadOptionalConfig();
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  await fsp.writeFile(configPath, `${JSON.stringify({ ...current, ...settings }, null, 2)}\n`, { mode: 0o600 });
}

export async function loadConfig(): Promise<WorkerConfig> {
  const parsed = await loadOptionalConfig();
  if (!parsed.apiUrl || !parsed.token) {
    throw new Error('Config incompleta. Vincula este equipo desde la app o ejecuta link con un codigo temporal.');
  }

  return {
    apiUrl: parsed.apiUrl.replace(/\/+$/, ''),
    token: parsed.token,
    closeToTray: parsed.closeToTray !== false,
  };
}
