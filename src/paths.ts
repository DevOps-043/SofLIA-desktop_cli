import * as os from 'node:os';
import * as path from 'node:path';

const APP_DIR_NAME = 'SofLIA Engine Render Worker';

export function getAppDataDir(platform = process.platform, env = process.env): string {
  if (platform === 'win32') {
    return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), APP_DIR_NAME);
  }

  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_DIR_NAME);
  }

  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'soflia-engine-render-worker');
}

export function getConfigPath(): string {
  return path.join(getAppDataDir(), 'config.json');
}

export function getWorkspaceDir(): string {
  return path.join(getAppDataDir(), 'workspace');
}
