const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ASSETS = path.join(__dirname, '..', 'assets');
const BACKUP = path.join(__dirname, '..', 'assets_backup');
const REF = path.join(ASSETS, 'rinko2_idle_01.png');
const ALPHA = 16;

function contentBox(data, width, height) {
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let found = false;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] <= ALPHA) continue;
      found = true;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!found) return { left: 0, top: 0, width, height };
  return {
    left: minX,
    top: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

async function analyze(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    width: info.width,
    height: info.height,
    box: contentBox(data, info.width, info.height),
  };
}

async function normalizeOne(file, canvasW, canvasH, targetContentH, bottomPad) {
  const img = sharp(file).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const box = contentBox(data, info.width, info.height);

  const trimmed = await sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .extract(box)
    .png()
    .toBuffer();

  const usableH = canvasH - bottomPad;
  const usableW = canvasW;
  let scale = targetContentH / box.height;
  let outW = Math.max(1, Math.round(box.width * scale));
  let outH = Math.max(1, Math.round(box.height * scale));

  if (outW > usableW) {
    scale = usableW / box.width;
    outW = Math.max(1, Math.round(box.width * scale));
    outH = Math.max(1, Math.round(box.height * scale));
  }
  if (outH > usableH) {
    scale = usableH / box.height;
    outW = Math.max(1, Math.round(box.width * scale));
    outH = Math.max(1, Math.round(box.height * scale));
  }

  const resized = await sharp(trimmed)
    .resize(outW, outH, { kernel: sharp.kernel.nearest })
    .ensureAlpha()
    .png()
    .toBuffer();

  const left = Math.round((canvasW - outW) / 2);
  const top = canvasH - bottomPad - outH;

  await sharp({
    create: {
      width: canvasW,
      height: canvasH,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: resized, left: Math.max(0, left), top: Math.max(0, top) }])
    .png()
    .toFile(file);
}

async function main() {
  const ref = await analyze(REF);
  const canvasW = ref.width;
  const canvasH = ref.height;
  const targetContentH = ref.box.height;
  const bottomPad = canvasH - (ref.box.top + ref.box.height);

  console.log('reference', path.basename(REF));
  console.log('canvas', `${canvasW}x${canvasH}`);
  console.log('contentH', targetContentH, 'bottomPad', bottomPad);

  if (!fs.existsSync(BACKUP)) fs.mkdirSync(BACKUP, { recursive: true });

  const files = fs
    .readdirSync(ASSETS)
    .filter((f) => /^[a-z0-9]+_(idle|run|dead)_0[1-4]\.png$/i.test(f))
    .sort();

  for (const name of files) {
    const src = path.join(ASSETS, name);
    const bak = path.join(BACKUP, name);
    if (!fs.existsSync(bak)) fs.copyFileSync(src, bak);

    // 参考图本身也跑一遍，保证完全一致
    await normalizeOne(src, canvasW, canvasH, targetContentH, bottomPad);
    const after = await analyze(src);
    console.log(
      'ok',
      name.padEnd(22),
      `${after.width}x${after.height}`,
      `content ${after.box.width}x${after.box.height}`,
      `bottom ${after.height - (after.box.top + after.box.height)}`
    );
  }

  console.log(`\nbackup -> ${BACKUP}`);
  console.log(`normalized ${files.length} files`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
