const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');

function copyFile(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.copyFileSync(source, target);
      return;
    } catch (error) {
      if (!['EBUSY', 'EPERM'].includes(error.code) || attempt === 4) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

function copyDir(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyDir(sourcePath, targetPath);
    } else if (entry.isFile()) {
      copyFile(sourcePath, targetPath);
    }
  }
}

copyFile(path.join(root, 'src', 'electron-preload.cjs'), path.join(dist, 'electron-preload.cjs'));
copyDir(path.join(root, 'assets'), path.join(dist, 'assets'));
