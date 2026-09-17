const sharp = require('sharp');
const path = require('path');

const SRC = path.join(__dirname, '..', 'assets', 'source.png');
const OUT_DIR = path.join(__dirname, '..', 'assets');

function floodKey(data, width, height) {
  const alpha = new Uint8Array(width * height);
  alpha.fill(255);
  const visited = new Uint8Array(width * height);
  const stack = [];

  const isBg = (i) => {
    const o = i * 4;
    return data[o] < 18 && data[o + 1] < 18 && data[o + 2] < 18;
  };

  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = y * width + x;
    if (visited[i] || !isBg(i)) return;
    visited[i] = 1;
    stack.push(i);
  };

  for (let x = 0; x < width; x++) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    push(0, y);
    push(width - 1, y);
  }

  while (stack.length) {
    const i = stack.pop();
    alpha[i] = 0;
    const x = i % width;
    const y = (i / width) | 0;
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (alpha[i] === 0) continue;
      const o = i * 4;
      const lum = (data[o] + data[o + 1] + data[o + 2]) / 3;
      if (lum > 40) continue;
      let near = false;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        if (alpha[(y + dy) * width + (x + dx)] === 0) {
          near = true;
          break;
        }
      }
      if (near && lum < 28) alpha[i] = Math.max(0, Math.round((lum / 28) * 180));
    }
  }

  for (let i = 0; i < width * height; i++) {
    data[i * 4 + 3] = Math.min(data[i * 4 + 3], alpha[i]);
  }
}

function contentBox(data, width, height) {
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] < 16) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX) return { left: 0, top: 0, width, height };
  const pad = 4;
  const left = Math.max(0, minX - pad);
  const top = Math.max(0, minY - pad);
  const right = Math.min(width - 1, maxX + pad);
  const bottom = Math.min(height - 1, maxY + pad);
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

async function extractHalf(fullW, fullH, half, name) {
  const halfW = Math.floor(fullW / 2);
  const left = half === 0 ? 0 : halfW;
  const cropH = half === 1 ? Math.floor(fullH * 0.92) : fullH;

  const { data, info } = await sharp(SRC)
    .extract({ left, top: 0, width: halfW, height: cropH })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = Buffer.from(data);
  floodKey(pixels, info.width, info.height);
  const box = contentBox(pixels, info.width, info.height);

  await sharp(pixels, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .extract(box)
    .png()
    .toFile(path.join(OUT_DIR, `${name}.png`));

  console.log(`wrote assets/${name}.png`, box.width, 'x', box.height);
}

async function main() {
  const meta = await sharp(SRC).metadata();
  console.log('source', meta.width, 'x', meta.height);
  await extractHalf(meta.width, meta.height, 0, 'front');
  await extractHalf(meta.width, meta.height, 1, 'side');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
