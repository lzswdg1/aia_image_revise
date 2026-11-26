const { parentPort } = require('node:worker_threads');
const { join } = require('node:path');
const { Models } = require('./models');
const { prepareImage, readMask, writeMask, paintStrokes, expandMask } = require('./images');

const models = new Models();

async function run(job, stage) {
  const { type, id, directory, image, input } = job;
  const asset = (name) => join(directory, id + '-' + name + '.png');

  if (type === 'upload') {
    stage('校验并解码图片');
    const dimensions = await prepareImage(input, asset('original'), asset('preview'));
    return { image: { id, ...dimensions, file: asset('original') } };
  }

  if (type === 'erase') {
    stage('读取选区');
    const mask = await readMask(job.mask.file, image.width, image.height);
    const metrics = await models.erase(image, mask, job.mask.bbox, asset('result'), stage);
    return { result: { width: image.width, height: image.height, ...metrics } };
  }

  let data, metrics;
  if (type === 'segment') {
    const { mask, ...timings } = await models.segment(image, job.points, stage);
    data = mask;
    metrics = timings;
  } else if (type === 'draw') {
    stage('生成手绘选区');
    data = job.mask ? await readMask(job.mask.file, image.width, image.height)
      : Buffer.alloc(image.width * image.height);
    paintStrokes(data, image.width, image.height, job.strokes);
    if (!data.includes(255)) return { result: { empty: true } };
  } else if (type === 'expand') {
    stage('计算扩选范围');
    data = await readMask(job.mask.file, image.width, image.height);
    expandMask(data, image.width, image.height, job.radius);
  } else {
    stage('校验导入的 mask');
    data = await readMask(input, image.width, image.height);
  }
  stage('计算面积并保存 mask');
  const stats = await writeMask(data, image.width, image.height, asset('mask'), asset('overlay'));
  return { mask: { id, imageId: image.id, file: asset('mask'), ...stats, ...metrics } };
}

models.load().then(() => {
  parentPort.on('message', async (job) => {
    const send = (data) => parentPort.postMessage({ id: job.id, ...data });
    try {
      const result = await run(job, (stage) => send({ stage }));
      send({ result });
    } catch (error) {
      send({ error: error.message });
    }
  });
  parentPort.postMessage({ ready: true });
}).catch((error) => {
  parentPort.postMessage({ startupError: error.message });
  parentPort.close();
});
