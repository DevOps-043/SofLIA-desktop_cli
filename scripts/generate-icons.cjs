const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = path.resolve(__dirname, '..');
const sourcePng = path.join(root, 'logo.png');
const assetsDir = path.join(root, 'assets');
const buildDir = path.join(root, 'build');
const rendererPublicDir = path.join(root, 'src', 'renderer', 'public');
const iconSize = 512;
const iconPaddingRatio = 0.12;
const icoSizes = [16, 24, 32, 48, 64, 128, 256];

const pngSignature = '89504e470d0a1a0a';
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createPngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

function parsePng(buffer) {
  if (buffer.subarray(0, 8).toString('hex') !== pngSignature) {
    throw new Error('logo.png must be a PNG file.');
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let palette = null;
  let transparency = null;
  const idatChunks = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
      const compression = data.readUInt8(10);
      const filter = data.readUInt8(11);
      const interlace = data.readUInt8(12);
      if (compression !== 0 || filter !== 0 || interlace !== 0) {
        throw new Error('logo.png must be a non-interlaced PNG.');
      }
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      transparency = data;
    } else if (type === 'IEND') {
      break;
    }
  }

  if (bitDepth !== 8 || ![2, 3, 6].includes(colorType)) {
    throw new Error('logo.png must be an 8-bit RGB, RGBA, or indexed PNG.');
  }
  if (colorType === 3 && !palette) {
    throw new Error('Indexed PNG logo must include a PLTE chunk.');
  }

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const stride = width * channels;
  const inflated = zlib.inflateSync(Buffer.concat(idatChunks));
  const pixels = Buffer.alloc(width * height * 4);
  let inputOffset = 0;
  let previous = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inputOffset];
    inputOffset += 1;
    const row = Buffer.from(inflated.subarray(inputOffset, inputOffset + stride));
    inputOffset += stride;
    const unfiltered = unfilterRow(row, previous, channels, filter);
    previous = unfiltered;

    for (let x = 0; x < width; x += 1) {
      const source = x * channels;
      const target = (y * width + x) * 4;
      if (colorType === 3) {
        const paletteIndex = unfiltered[source];
        const paletteOffset = paletteIndex * 3;
        pixels[target] = palette[paletteOffset] || 0;
        pixels[target + 1] = palette[paletteOffset + 1] || 0;
        pixels[target + 2] = palette[paletteOffset + 2] || 0;
        pixels[target + 3] = transparency?.[paletteIndex] ?? 255;
      } else {
        pixels[target] = unfiltered[source];
        pixels[target + 1] = unfiltered[source + 1];
        pixels[target + 2] = unfiltered[source + 2];
        pixels[target + 3] = channels === 4 ? unfiltered[source + 3] : 255;
      }
    }
  }

  return { width, height, pixels };
}

function paethPredictor(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  if (aboveDistance <= upperLeftDistance) return above;
  return upperLeft;
}

function unfilterRow(row, previous, bytesPerPixel, filter) {
  const output = Buffer.alloc(row.length);
  for (let index = 0; index < row.length; index += 1) {
    const raw = row[index];
    const left = index >= bytesPerPixel ? output[index - bytesPerPixel] : 0;
    const above = previous[index] || 0;
    const upperLeft = index >= bytesPerPixel ? previous[index - bytesPerPixel] || 0 : 0;
    if (filter === 0) output[index] = raw;
    else if (filter === 1) output[index] = (raw + left) & 0xff;
    else if (filter === 2) output[index] = (raw + above) & 0xff;
    else if (filter === 3) output[index] = (raw + Math.floor((left + above) / 2)) & 0xff;
    else if (filter === 4) output[index] = (raw + paethPredictor(left, above, upperLeft)) & 0xff;
    else throw new Error(`Unsupported PNG filter: ${filter}`);
  }
  return output;
}

function renderContainedSquare(image, size) {
  const output = Buffer.alloc(size * size * 4);
  const padding = Math.round(size * iconPaddingRatio);
  const availableSize = size - padding * 2;
  const scale = Math.min(availableSize / image.width, availableSize / image.height);
  const targetWidth = Math.max(1, Math.round(image.width * scale));
  const targetHeight = Math.max(1, Math.round(image.height * scale));
  const left = Math.floor((size - targetWidth) / 2);
  const top = Math.floor((size - targetHeight) / 2);

  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.min(image.height - 1, Math.floor(y / scale));
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(image.width - 1, Math.floor(x / scale));
      const source = (sourceY * image.width + sourceX) * 4;
      const target = ((top + y) * size + left + x) * 4;
      image.pixels.copy(output, target, source, source + 4);
    }
  }

  return { width: size, height: size, pixels: output };
}

function encodePng(image) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(6, 9);
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);

  const stride = image.width * 4;
  const scanlines = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    const rowOffset = y * (stride + 1);
    scanlines[rowOffset] = 0;
    image.pixels.copy(scanlines, rowOffset + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from(pngSignature, 'hex'),
    createPngChunk('IHDR', ihdr),
    createPngChunk('IDAT', zlib.deflateSync(scanlines)),
    createPngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function writeIcoFromPngs(pngBuffers, targetPath) {
  const headerSize = 6;
  const entrySize = 16;
  const imageOffset = headerSize + entrySize * pngBuffers.length;
  const totalSize = imageOffset + pngBuffers.reduce((sum, item) => sum + item.buffer.length, 0);
  const ico = Buffer.alloc(totalSize);

  ico.writeUInt16LE(0, 0);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(pngBuffers.length, 4);

  let currentImageOffset = imageOffset;
  pngBuffers.forEach((item, index) => {
    const entryOffset = headerSize + entrySize * index;
    ico.writeUInt8(item.size >= 256 ? 0 : item.size, entryOffset);
    ico.writeUInt8(item.size >= 256 ? 0 : item.size, entryOffset + 1);
    ico.writeUInt8(0, entryOffset + 2);
    ico.writeUInt8(0, entryOffset + 3);
    ico.writeUInt16LE(1, entryOffset + 4);
    ico.writeUInt16LE(32, entryOffset + 6);
    ico.writeUInt32LE(item.buffer.length, entryOffset + 8);
    ico.writeUInt32LE(currentImageOffset, entryOffset + 12);
    item.buffer.copy(ico, currentImageOffset);
    currentImageOffset += item.buffer.length;
  });

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, ico);
}

const source = parsePng(fs.readFileSync(sourcePng));
const squareIcon = renderContainedSquare(source, iconSize);
const squareIconPng = encodePng(squareIcon);
const icoPngs = icoSizes.map((size) => ({
  size,
  buffer: encodePng(renderContainedSquare(source, size)),
}));

fs.mkdirSync(assetsDir, { recursive: true });
fs.mkdirSync(buildDir, { recursive: true });
fs.mkdirSync(rendererPublicDir, { recursive: true });

fs.writeFileSync(path.join(assetsDir, 'app-icon.png'), squareIconPng);
fs.writeFileSync(path.join(assetsDir, 'tray-icon.png'), squareIconPng);
fs.copyFileSync(sourcePng, path.join(rendererPublicDir, 'soflia-logo.png'));
writeIcoFromPngs(icoPngs, path.join(buildDir, 'icon.ico'));
