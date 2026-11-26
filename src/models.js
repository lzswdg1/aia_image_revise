const { join } = require('node:path');
const { performance } = require('node:perf_hooks');
const ort = require('onnxruntime-node');
const sharp = require('sharp');
const { rgb, gray } = require('./images');

const SAM_SIZE = 1024;
const LAMA_SIZE = 512;
const CACHE_LIMIT = 8;
const roundedMs = (since) => Math.round(performance.now() - since);
const tensor = (values, dims) => new ort.Tensor('float32', Float32Array.from(values), dims);
const byte = (value) => Math.max(0, Math.min(255, Math.round(value)));

function fit(width, height, size) {
  const scale = size / Math.max(width, height);
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

function cropBox(bbox, width, height) {
  const context = Math.max(32, Math.ceil(Math.max(bbox.width, bbox.height) * 0.25));
  const left = Math.max(0, bbox.left - context);
  const top = Math.max(0, bbox.top - context);
  return {
    left, top,
    width: Math.min(width, bbox.left + bbox.width + context) - left,
    height: Math.min(height, bbox.top + bbox.height + context) - top,
  };
}

function expandedMask(pixels, width, height, size) {
  // Hide the immediate outline from LaMa so it cannot reconstruct the object
  // from residual edge pixels. The final composite still uses the exact mask.
  const radius = 10;
  const expanded = new Float32Array(size * size);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!pixels[y * width + x]) continue;
      const start = Math.max(0, x - radius);
      const end = Math.min(width, x + radius + 1);
      for (let row = Math.max(0, y - radius); row < Math.min(height, y + radius + 1); row++) {
        expanded.fill(1, row * size + start, row * size + end);
      }
    }
  }
  return expanded;
}

class Models {
  cache = new Map();

  async load() {
    const root = join(__dirname, '..', 'models');
    const options = { executionProviders: ['cpu'], intraOpNumThreads: 2, interOpNumThreads: 1 };
    this.encoder = await ort.InferenceSession.create(join(root, 'mobilesam/mobile_sam_image_encoder.onnx'), options);
    this.decoder = await ort.InferenceSession.create(join(root, 'mobilesam/sam_mask_decoder_multi.onnx'), options);
    this.lama = await ort.InferenceSession.create(join(root, 'lama/lama_fp32.onnx'), options);
  }

  async segment(image, points, stage) {
    const [w, h] = fit(image.width, image.height, SAM_SIZE);
    const start = performance.now();
    let embedding = this.cache.get(image.id);
    const cacheHit = Boolean(embedding);
    if (embedding) {
      this.cache.delete(image.id);
    } else {
      stage('编码原图');
      const pixels = await rgb(image.file).resize(w, h, { fit: 'fill' }).raw().toBuffer();
      const result = await this.encoder.run({ input_image: tensor(pixels, [h, w, 3]) });
      embedding = result.image_embeddings;
    }
    this.cache.set(image.id, embedding);
    if (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value);
    const encodeMs = cacheHit ? 0 : roundedMs(start);

    stage('根据点击生成 mask');
    const decodeStart = performance.now();
    const coordinates = points.flatMap(({ x, y }) => [x * w / image.width, y * h / image.height]);
    const labels = points.map(({ label }) => label);
    const result = await this.decoder.run({
      image_embeddings: embedding,
      point_coords: tensor([...coordinates, 0, 0], [1, labels.length + 1, 2]),
      point_labels: tensor([...labels, -1], [1, labels.length + 1]),
      mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
      has_mask_input: tensor([0], [1]),
      // Decode at preview scale to avoid allocating four full-resolution float masks.
      orig_im_size: tensor([h, w], [2]),
    }, ['masks', 'iou_predictions']);
    const decodeMs = roundedMs(decodeStart);
    const logits = result.masks.data;
    const scores = result.iou_predictions.data;
    const area = w * h;
    const pointOffsets = points.map(({ x, y }) => (
      Math.min(h - 1, Math.floor(y * h / image.height)) * w + Math.min(w - 1, Math.floor(x * w / image.width))
    ));
    const allowed = scores.length > 1 && points.length === 1 ? [1, 2, 3] : Array.from(scores.keys());
    const rank = (index) => scores[index] + pointOffsets.reduce((matched, offset, i) => (
      matched + Number((logits[index * area + offset] > 0) === Boolean(labels[i]))
    ), 0) * 2;
    let best = allowed[0];
    for (const index of allowed) if (rank(index) > rank(best)) best = index;

    const binary = Buffer.alloc(area);
    for (let i = 0; i < area; i++) binary[i] = logits[best * area + i] > 0 ? 255 : 0;
    const mask = await gray(binary, w, h).resize(image.width, image.height, {
      fit: 'fill', kernel: 'nearest',
    }).raw().toBuffer();
    return { mask, score: scores[best], cacheHit, encodeMs, decodeMs };
  }

  async erase(image, mask, bbox, output, stage) {
    stage('裁剪选区和上下文');
    const prepStart = performance.now();
    const crop = cropBox(bbox, image.width, image.height);
    const [w, h] = fit(crop.width, crop.height, LAMA_SIZE);
    const [pixels, maskPixels] = await Promise.all([
      rgb(image.file).extract(crop).resize(w, h, { fit: 'fill' }).raw().toBuffer(),
      gray(mask, image.width, image.height).extract(crop)
        .resize(w, h, { fit: 'fill', kernel: 'nearest' }).raw().toBuffer(),
    ]);
    if (!maskPixels.includes(255)) throw new Error('选区缩小后过细，请扩大 mask');
    const size = LAMA_SIZE;
    const plane = size * size;
    const feed = new Float32Array(plane * 3);
    const modelMask = expandedMask(maskPixels, w, h, size);
    // Replicate image edges in the padding, keeping padding outside the repair region.
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const index = y * size + x;
        const source = Math.min(y, h - 1) * w + Math.min(x, w - 1);
        for (let c = 0; c < 3; c++) feed[c * plane + index] = pixels[source * 3 + c] / 255;
      }
    }
    const prepMs = roundedMs(prepStart);

    stage('LaMa 修复');
    const predictStart = performance.now();
    const result = await this.lama.run({
      image: new ort.Tensor('float32', feed, [1, 3, size, size]),
      mask: new ort.Tensor('float32', modelMask, [1, 1, size, size]),
    });
    const inferenceMs = roundedMs(predictStart);
    const prediction = result.output.data;
    const patch = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < 3; c++) {
          patch[(y * w + x) * 3 + c] = byte(prediction[c * plane + y * size + x]);
        }
      }
    }

    stage('合成并保存原尺寸 PNG');
    const compositeStart = performance.now();
    const restored = await sharp(patch, { raw: { width: w, height: h, channels: 3 } })
      .resize(crop.width, crop.height, { fit: 'fill' }).raw().toBuffer();
    const rgba = Buffer.alloc(crop.width * crop.height * 4);
    for (let y = 0; y < crop.height; y++) {
      for (let x = 0; x < crop.width; x++) {
        const i = y * crop.width + x;
        if (!mask[(crop.top + y) * image.width + crop.left + x]) continue;
        rgba[i * 4] = restored[i * 3];
        rgba[i * 4 + 1] = restored[i * 3 + 1];
        rgba[i * 4 + 2] = restored[i * 3 + 2];
        rgba[i * 4 + 3] = 255;
      }
    }
    await rgb(image.file).composite([{
      input: rgba, raw: { width: crop.width, height: crop.height, channels: 4 },
      left: crop.left, top: crop.top,
    }]).png({ compressionLevel: 3 }).toFile(output);
    return { crop, modelInput: [size, size], prepMs, inferenceMs, compositeMs: roundedMs(compositeStart) };
  }
}

module.exports = { Models };
