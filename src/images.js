const sharp = require('sharp');

const MAX_PIXELS = 7680 * 4320;
const MAX_SIDE = 7680;
const PREVIEW_SIDE = 1200;
const MAX_EXPAND_RADIUS = 24;
const options = { limitInputPixels: MAX_PIXELS };

function rgb(input) {
  return sharp(input, options).toColourspace('srgb').flatten({ background: '#ffffff' });
}

async function prepareImage(input, output, preview) {
  const meta = await sharp(input, options).metadata();
  if (!['jpeg', 'png'].includes(meta.format) || (meta.pages ?? 1) !== 1) {
    throw new Error('请选择单帧 JPEG 或 PNG 图片');
  }
  if (Math.max(meta.width, meta.height) > MAX_SIDE) {
    throw new Error('图片最长边不能超过 7680 像素');
  }
  const { width, height } = await rgb(input).autoOrient().png({ compressionLevel: 3 }).toFile(output);
  await sharp(output, options).resize({
    width: PREVIEW_SIDE, height: PREVIEW_SIDE, fit: 'inside', withoutEnlargement: true,
  }).png().toFile(preview);
  return { width, height, large: Math.max(width, height) > 4096 };
}

function maskStats(data, width, height) {
  let areaPixels = 0;
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixel = data[y * width + x];
      if (pixel === 0) continue;
      if (pixel !== 255) throw new Error('Mask 像素必须是纯黑或纯白');
      areaPixels++;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (!areaPixels) throw new Error('Mask 为空');
  return {
    areaPixels, areaRatio: areaPixels / (width * height),
    bbox: { left, top, width: right - left + 1, height: bottom - top + 1 },
  };
}

function gray(data, width, height) {
  return sharp(data, { raw: { width, height, channels: 1 } }).toColourspace('b-w');
}

async function readMask(input, width, height) {
  const stream = sharp(input, options);
  const meta = await stream.metadata();
  if (meta.format !== 'png' || meta.channels !== 1 || (meta.pages ?? 1) !== 1 || !['uchar', undefined].includes(meta.depth)) {
    throw new Error('Mask 必须是单通道 8 位灰度 PNG，黑色保留、白色擦除');
  }
  if (meta.width !== width || meta.height !== height) {
    throw new Error('Mask 尺寸必须与方向校正后的原图一致');
  }
  return stream.toColourspace('b-w').raw().toBuffer();
}

async function writeMask(data, width, height, output, overlay) {
  const stats = maskStats(data, width, height);
  await gray(data, width, height).png().toFile(output);
  const { data: small, info } = await gray(data, width, height).resize({
    width: PREVIEW_SIDE, height: PREVIEW_SIDE, fit: 'inside',
    withoutEnlargement: true, kernel: 'nearest',
  }).raw().toBuffer({ resolveWithObject: true });
  const rgba = Buffer.alloc(small.length * 4);
  for (let i = 0; i < small.length; i++) {
    if (!small[i]) continue;
    rgba[i * 4] = 70;
    rgba[i * 4 + 1] = 230;
    rgba[i * 4 + 2] = 153;
    rgba[i * 4 + 3] = 132;
  }
  await sharp(rgba, {
    raw: { width: info.width, height: info.height, channels: 4 },
  }).png().toFile(overlay);
  return stats;
}

function paintStrokes(mask, width, height, strokes) {
  for (const { mode, radius, points } of strokes) {
    const value = mode === 'paint' ? 255 : 0;
    const stamp = (cx, cy) => {
      const top = Math.max(0, Math.ceil(cy - radius));
      const bottom = Math.min(height - 1, Math.floor(cy + radius));
      for (let y = top; y <= bottom; y++) {
        const half = Math.sqrt(radius ** 2 - (y - cy) ** 2);
        const left = Math.max(0, Math.ceil(cx - half));
        const right = Math.min(width - 1, Math.floor(cx + half));
        if (left <= right) mask.fill(value, y * width + left, y * width + right + 1);
      }
    };
    stamp(...points[0]);
    for (let i = 1; i < points.length; i++) {
      const [x, y] = points[i - 1];
      const dx = points[i][0] - x, dy = points[i][1] - y;
      const steps = Math.ceil(Math.hypot(dx, dy) / Math.max(1, radius / 4));
      for (let step = 1; step <= steps; step++) {
        stamp(x + dx * step / steps, y + dy * step / steps);
      }
    }
  }
}

// A square neighbourhood, computed in linear time even on an 8K image.
function expandMask(mask, width, height, radius) {
  const outside = radius + 1;
  const rows = Buffer.alloc(mask.length);
  for (let y = 0; y < height; y++) {
    let distance = outside;
    const offset = y * width;
    for (let x = 0; x < width; x++) {
      distance = mask[offset + x] ? 0 : distance + 1;
      rows[offset + x] = distance <= radius ? 255 : 0;
    }
    distance = outside;
    for (let x = width - 1; x >= 0; x--) {
      distance = mask[offset + x] ? 0 : distance + 1;
      if (distance <= radius) rows[offset + x] = 255;
    }
  }

  const distances = new Int32Array(width).fill(outside);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * width + x;
      distances[x] = rows[offset] ? 0 : distances[x] + 1;
      mask[offset] = distances[x] <= radius ? 255 : 0;
    }
  }
  distances.fill(outside);
  for (let y = height - 1; y >= 0; y--) {
    for (let x = 0; x < width; x++) {
      const offset = y * width + x;
      distances[x] = rows[offset] ? 0 : distances[x] + 1;
      if (distances[x] <= radius) mask[offset] = 255;
    }
  }
  return mask;
}

module.exports = {
  MAX_PIXELS, MAX_SIDE, MAX_EXPAND_RADIUS, rgb, gray, prepareImage, readMask, writeMask, paintStrokes, expandMask,
};
