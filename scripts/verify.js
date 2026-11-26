const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const sharp = require('sharp');

const base = process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const terminal = ['succeeded', 'failed', 'cancelled'];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(path, { json, form, status = 200 } = {}) {
  const response = await fetch(base + path, json ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json),
  } : form ? { method: 'POST', body: form } : undefined);
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body;
}

function upload(path, png) {
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'sample.png');
  return api(path, { form, status: 202 });
}

async function done(task, status = 'succeeded') {
  const deadline = Date.now() + 120_000;
  while (!terminal.includes(task.status) && Date.now() < deadline) {
    await wait(75);
    task = await api('/api/tasks/' + task.id);
  }
  assert.equal(task.status, status, JSON.stringify(task));
  return task;
}

async function asset(path) {
  const response = await fetch(base + path);
  assert.equal(response.status, 200, path);
  return Buffer.from(await response.arrayBuffer());
}

async function fixture(width, height, radius) {
  const cx = Math.round(width * 0.58), cy = Math.round(height * 0.57);
  const truth = Buffer.alloc(width * height);
  const rgb = Buffer.alloc(width * height * 3);
  const radiusSquared = radius * radius;
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const d2 = (x - cx) ** 2 + (y - cy) ** 2;
      const tone = Math.floor(110 + 40 * y / height + 32 * x / width);
      const inside = d2 <= radiusSquared;
      if (inside) {
        truth[index] = 255;
        count++;
      }
      const shade = Math.floor(Math.max(0, 48 - (Math.abs(x - cx + radius / 3) + Math.abs(y - cy + radius / 3)) * 36 / radius));
      rgb[index * 3] = inside ? 192 + shade : tone;
      rgb[index * 3 + 1] = inside ? 37 + shade : tone + 12;
      rgb[index * 3 + 2] = inside ? 30 + shade : tone + 20;
    }
  }
  const encodeMask = (data) => sharp(data, { raw: { width, height, channels: 1 } })
    .toColourspace('b-w').png().toBuffer();
  const png = await sharp(rgb, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 3 }).toBuffer();
  return { png, truth, count, encodeMask, cx, cy, rgb };
}

async function checkCase(width, height, radius, testQueue = false) {
  const sample = await fixture(width, height, radius);
  const uploadTask = await done(await upload('/api/images', sample.png));
  const image = uploadTask.result;
  assert.deepEqual([image.width, image.height], [width, height]);
  assert.equal(image.large, width > 4096);
  const points = [{ x: sample.cx, y: sample.cy, label: 1 }];
  const segment = async (prompts) => api('/api/segmentations', {
    json: { imageId: image.id, points: prompts }, status: 202,
  });
  const segmentation = await done(await segment(points));
  const selected = segmentation.result;
  assert.equal(selected.cacheHit, false);
  assert.ok(selected.areaPixels > 0);
  const predicted = await sharp(await asset(selected.maskUrl)).toColourspace('b-w').raw().toBuffer();
  assert.equal(predicted.length, sample.truth.length);
  let intersection = 0, union = 0;
  for (let i = 0; i < predicted.length; i++) {
    if (predicted[i] && sample.truth[i]) intersection++;
    if (predicted[i] || sample.truth[i]) union++;
  }
  const iou = intersection / union;
  assert.ok(iou > 0.7, 'mask IoU ' + iou);
  const refined = await done(await segment([...points, { x: 2, y: 2, label: 0 }]));
  assert.equal(refined.result.cacheHit, true);

  const imported = await done(await upload('/api/images/' + image.id + '/masks', await sample.encodeMask(sample.truth)));
  assert.equal(imported.result.areaPixels, sample.count);
  assert.equal(imported.result.areaRatio, sample.count / (width * height));
  if (testQueue) {
    const empty = await done(await upload('/api/images/' + image.id + '/masks',
      await sample.encodeMask(Buffer.alloc(width * height))), 'failed');
    assert.match(empty.error, /为空/);
    const wrong = await done(await upload('/api/images/' + image.id + '/masks',
      await sharp({ create: { width: 8, height: 8, channels: 3, background: 'white' } })
        .toColourspace('b-w').png().toBuffer()), 'failed');
    assert.match(wrong.error, /尺寸/);
  }

  const erase = await api('/api/erasures', {
    json: { imageId: image.id, maskId: selected.id }, status: 202,
  });
  if (testQueue) {
    const cancelled = await api('/api/erasures', {
      json: { imageId: image.id, maskId: imported.result.id }, status: 202,
    });
    assert.equal(cancelled.status, 'queued');
    await api('/api/tasks/' + cancelled.id + '/cancel', { json: {} });
    await done(cancelled, 'cancelled');
    assert.equal((await api('/api/health')).ready, true);
    const waitingErase = await api('/api/erasures', {
      json: { imageId: image.id, maskId: imported.result.id }, status: 202,
    });
    const priorityClick = await segment(points);
    const [clickDone, eraseDone] = await Promise.all([done(priorityClick), done(waitingErase)]);
    assert.ok(clickDone.finishedAt <= eraseDone.startedAt, 'queued click should run before waiting erase');
  }
  const erased = await done(erase);
  const png = await asset(erased.result.imageUrl);
  const { data: result, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([info.width, info.height, info.channels], [width, height, 3]);
  let changed = 0;
  for (let i = 0; i < predicted.length; i++) {
    const p = i * 3;
    if (result[p] !== sample.rgb[p] || result[p + 1] !== sample.rgb[p + 1] || result[p + 2] !== sample.rgb[p + 2]) {
      assert.ok(predicted[i], 'unexpected pixel change outside mask at ' + i);
      changed++;
    }
  }
  assert.ok(changed > selected.areaPixels / 2, 'model must replace most of the selected area');
  const center = (sample.cy * width + sample.cx) * 3;
  assert.ok(Math.abs(result[center] - result[center + 1]) < 40, 'center should no longer be red');

  const output = join(__dirname, '..', '.poc-data', 'verification');
  if (testQueue) {
    await mkdir(output, { recursive: true });
    await Promise.all([
      writeFile(join(output, 'sample.png'), sample.png),
      writeFile(join(output, 'mask.png'), await asset(selected.maskUrl)),
      writeFile(join(output, 'erased.png'), png),
    ]);
  }
  console.log(JSON.stringify({
    dimensions: [width, height],
    iou: Number(iou.toFixed(3)),
    areaPixels: selected.areaPixels,
    encodeMs: selected.encodeMs,
    cachedClickMs: refined.runMs,
    eraseTaskMs: erased.runMs,
    inferenceMs: erased.result.inferenceMs,
    erasePeakRssMiB: Math.round(erased.peakRssBytes / 2 ** 20),
    differencesOutsideMask: 0,
  }));
}

(async () => {
  assert.equal((await api('/api/health')).device, 'CPU');
  assert.match(await (await fetch(base)).text(), /图片局部擦除/);
  await checkCase(960, 640, 82, true);
  await checkCase(7680, 4320, 250);
  console.log('通过：本地推理、面积校验、缓存、排队取消、优先级、原尺寸及选区外像素检查。');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
