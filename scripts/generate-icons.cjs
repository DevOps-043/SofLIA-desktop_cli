const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sourcePng = path.join(root, 'logo.png');
const assetsDir = path.join(root, 'assets');
const buildDir = path.join(root, 'build');

function readPngSize(buffer) {
  const pngSignature = '89504e470d0a1a0a';
  if (buffer.subarray(0, 8).toString('hex') !== pngSignature) {
    throw new Error('logo.png must be a PNG file.');
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function writeIcoFromPng(pngBuffer, targetPath) {
  const { width, height } = readPngSize(pngBuffer);
  const headerSize = 6;
  const entrySize = 16;
  const imageOffset = headerSize + entrySize;
  const ico = Buffer.alloc(imageOffset + pngBuffer.length);

  ico.writeUInt16LE(0, 0);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(1, 4);
  ico.writeUInt8(width >= 256 ? 0 : width, 6);
  ico.writeUInt8(height >= 256 ? 0 : height, 7);
  ico.writeUInt8(0, 8);
  ico.writeUInt8(0, 9);
  ico.writeUInt16LE(1, 10);
  ico.writeUInt16LE(32, 12);
  ico.writeUInt32LE(pngBuffer.length, 14);
  ico.writeUInt32LE(imageOffset, 18);
  pngBuffer.copy(ico, imageOffset);

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, ico);
}

const png = fs.readFileSync(sourcePng);
fs.mkdirSync(assetsDir, { recursive: true });
fs.mkdirSync(buildDir, { recursive: true });

fs.copyFileSync(sourcePng, path.join(assetsDir, 'app-icon.png'));
fs.copyFileSync(sourcePng, path.join(assetsDir, 'tray-icon.png'));
writeIcoFromPng(png, path.join(buildDir, 'icon.ico'));
