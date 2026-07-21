import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

const APP_DIR_NAME = 'SofLIA Engine Render Worker';

export function getAppDataDir(platform = process.platform, env = process.env): string {
  if (platform === 'win32') {
    return path.win32.join(
      env.APPDATA || path.win32.join(os.homedir(), 'AppData', 'Roaming'),
      APP_DIR_NAME,
    );
  }

  if (platform === 'darwin') {
    return path.posix.join(os.homedir(), 'Library', 'Application Support', APP_DIR_NAME);
  }

  return path.posix.join(
    env.XDG_CONFIG_HOME || path.posix.join(os.homedir(), '.config'),
    'soflia-engine-render-worker',
  );
}

export function getConfigPath(): string {
  return path.join(getAppDataDir(), 'config.json');
}

export function getWorkspaceDir(): string {
  return path.join(getAppDataDir(), 'workspace');
}

export function getRemotionCacheDir(): string {
  return path.join(getWorkspaceDir(), 'remotion-cache');
}

export function configureWritableWorkingDirectory(): string {
  const workspaceDir = getWorkspaceDir();
  try {
    // Remotion derives its browser download cache from process.cwd().
    // Installed Windows apps run from Program Files, which is not writable.
    fs.mkdirSync(workspaceDir, { recursive: true });
    process.chdir(workspaceDir);
  } catch {
    // Let the later render/config operation surface the concrete filesystem error.
  }
  return workspaceDir;
}
