import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { getConfigPath } from './paths.js';

export interface WorkerConfig {
  apiUrl: string;
  token: string;
}

export async function saveConfig(config: WorkerConfig): Promise<void> {
  const configPath = getConfigPath();
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export async function loadConfig(): Promise<WorkerConfig> {
  const raw = await fsp.readFile(getConfigPath(), 'utf8');
  const parsed = JSON.parse(raw) as Partial<WorkerConfig>;
  if (!parsed.apiUrl || !parsed.token) {
    throw new Error('Config incompleta. Ejecuta configure con api-url y token.');
  }

  return {
    apiUrl: parsed.apiUrl.replace(/\/+$/, ''),
    token: parsed.token,
  };
}
