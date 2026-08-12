import { createRequire } from 'node:module';
import * as path from 'node:path';

const require = createRequire(import.meta.url);

function unpackAsarPath(resolvedPath: string): string | null {
  return resolvedPath.includes('app.asar')
    ? resolvedPath.replace('app.asar', 'app.asar.unpacked')
    : null;
}

function resolveNativePackageDirectory(packageDirectory: string): string {
  return unpackAsarPath(packageDirectory) || packageDirectory;
}

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
  return resolveNativePackageDirectory(compositorPackageDir);
}

export function getRemotionFfmpegPath(): string | null {
  const binariesDirectory = getRemotionBinariesDirectory();
  if (!binariesDirectory) return null;
  return path.join(binariesDirectory, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
}

export function getRemotionFfprobePath(): string | null {
  const binariesDirectory = getRemotionBinariesDirectory();
  if (!binariesDirectory) return null;
  return path.join(binariesDirectory, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
}

export function getEsbuildBinaryPath(): string | null {
  const packageName = (() => {
    if (process.platform === 'win32' && process.arch === 'x64') return '@esbuild/win32-x64';
    if (process.platform === 'win32' && process.arch === 'ia32') return '@esbuild/win32-ia32';
    if (process.platform === 'win32' && process.arch === 'arm64') return '@esbuild/win32-arm64';
    if (process.platform === 'darwin' && process.arch === 'x64') return '@esbuild/darwin-x64';
    if (process.platform === 'darwin' && process.arch === 'arm64') return '@esbuild/darwin-arm64';
    if (process.platform === 'linux' && process.arch === 'x64') return '@esbuild/linux-x64';
    if (process.platform === 'linux' && process.arch === 'arm64') return '@esbuild/linux-arm64';
    if (process.platform === 'linux' && process.arch === 'ia32') return '@esbuild/linux-ia32';
    if (process.platform === 'linux' && process.arch === 'arm') return '@esbuild/linux-arm';
    return null;
  })();

  if (!packageName) return null;
  const packageDir = path.dirname(require.resolve(`${packageName}/package.json`));
  const nativePackageDir = resolveNativePackageDirectory(packageDir);
  return path.join(nativePackageDir, process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild');
}

export function configureNativeBinaryPaths(): void {
  const esbuildBinaryPath = getEsbuildBinaryPath();
  if (esbuildBinaryPath) {
    process.env.ESBUILD_BINARY_PATH = esbuildBinaryPath;
  }
}
