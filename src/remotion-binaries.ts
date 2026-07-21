import { createRequire } from 'node:module';
import * as path from 'node:path';

const require = createRequire(import.meta.url);

export function getRemotionBinariesDirectory(): string | null {
  const packageName = (() => {
    if (process.platform === 'win32' && process.arch === 'x64') return '@remotion/compositor-win32-x64-msvc';
    if (process.platform === 'darwin' && process.arch === 'x64') return '@remotion/compositor-darwin-x64';
    if (process.platform === 'darwin' && process.arch === 'arm64') return '@remotion/compositor-darwin-arm64';
    if (process.platform === 'linux' && process.arch === 'x64') return '@remotion/compositor-linux-x64-gnu';
    if (process.platform === 'linux' && process.arch === 'arm64') return '@remotion/compositor-linux-arm64-gnu';
    return null;
  })();

  if (!packageName) return null;
  const compositorPackageDir = path.dirname(require.resolve(`${packageName}/package.json`));
  return compositorPackageDir.includes('app.asar')
    ? compositorPackageDir.replace('app.asar', 'app.asar.unpacked')
    : null;
}
