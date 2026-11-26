require('reflect-metadata');
const { randomUUID } = require('node:crypto');
const { join } = require('node:path');
const { mkdir, mkdtemp, writeFile, unlink } = require('node:fs/promises');
const {
  BadRequestException, Body, Controller, Get, HttpCode, Inject, Module, Param,
  Post, UploadedFile, UseInterceptors,
} = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { FileInterceptor } = require('@nestjs/platform-express');
const { Tasks } = require('./tasks');

const root = join(__dirname, '..');
const upload = FileInterceptor('file', { limits: { fileSize: 32 * 1024 * 1024, files: 1 } });

class ImageController {
  constructor(tasks) {
    this.tasks = tasks;
  }

  status() {
    return { ready: this.tasks.ready, device: 'CPU', pid: process.pid, maxSide: 7680, maxPixels: 7680 * 4320 };
  }

  async upload(file) {
    return this.submitFile('upload', file);
  }

  segment(body) {
    const image = this.tasks.image(body?.imageId);
    const points = body?.points;
    if (!Array.isArray(points) || points.length < 1 || points.length > 16
      || !points.some((p) => p?.label === 1)
      || points.some((p) => !p || ![0, 1].includes(p.label)
        || !Number.isFinite(p.x) || !Number.isFinite(p.y)
        || p.x < 0 || p.y < 0 || p.x >= image.width || p.y >= image.height)) {
      throw new BadRequestException('请提供 1 到 16 个图内坐标，其中至少一个是前景点');
    }
    return this.tasks.add('segment', { image, points });
  }

  async importMask(imageId, file) {
    return this.submitFile('mask', file, { image: this.tasks.image(imageId) });
  }

  drawMask(imageId, body) {
    const image = this.tasks.image(imageId);
    const strokes = body?.strokes;
    if (!Array.isArray(strokes) || !strokes.length || strokes.length > 64) {
      throw new BadRequestException('请提供 1 到 64 笔手绘选区');
    }
    let pointCount = 0;
    for (const stroke of strokes) {
      if (!stroke || !['paint', 'subtract'].includes(stroke.mode)
        || !Number.isInteger(stroke.radius) || stroke.radius < 1 || stroke.radius > 2048
        || !Array.isArray(stroke.points) || !stroke.points.length) {
        throw new BadRequestException('手绘笔迹无效');
      }
      pointCount += stroke.points.length;
      if (pointCount > 1500 || stroke.points.some((point) => !Array.isArray(point) || point.length !== 2
        || !point.every(Number.isInteger) || point[0] < 0 || point[0] >= image.width
        || point[1] < 0 || point[1] >= image.height)) {
        throw new BadRequestException('手绘坐标超出范围或笔迹过多');
      }
    }
    const mask = body.maskId == null ? null : this.tasks.mask(body.maskId, image.id);
    return this.tasks.add('draw', { image, mask, strokes });
  }

  erase(body) {
    const image = this.tasks.image(body?.imageId);
    const mask = this.tasks.mask(body?.maskId, image.id);
    if (mask.areaRatio > 0.5) throw new BadRequestException('此 Demo 的擦除选区不能超过原图面积的 50%');
    return this.tasks.add('erase', { image, mask });
  }

  task(id) {
    return this.tasks.get(id);
  }

  cancel(id) {
    return this.tasks.cancel(id);
  }

  async submitFile(type, file, args = {}) {
    if (!file?.buffer?.length) throw new BadRequestException('请选择要上传的文件');
    const input = join(this.tasks.directory, randomUUID() + '.upload');
    await writeFile(input, file.buffer, { flag: 'wx' });
    try {
      return this.tasks.add(type, { ...args, input });
    } catch (error) {
      await unlink(input).catch(() => {});
      throw error;
    }
  }
}

// Apply Nest decorators directly so the demo can run as JavaScript without a build step.
Controller('api')(ImageController);
Inject(Tasks)(ImageController, undefined, 0);
const proto = ImageController.prototype;
function route(name, method, path, ...decorators) {
  const descriptor = Object.getOwnPropertyDescriptor(proto, name);
  method(path)(proto, name, descriptor);
  for (const decorator of decorators) decorator(proto, name, descriptor);
}

route('status', Get, 'health');
route('upload', Post, 'images', HttpCode(202), UseInterceptors(upload));
UploadedFile()(proto, 'upload', 0);
route('segment', Post, 'segmentations', HttpCode(202));
Body()(proto, 'segment', 0);
route('importMask', Post, 'images/:imageId/masks', HttpCode(202), UseInterceptors(upload));
Param('imageId')(proto, 'importMask', 0);
UploadedFile()(proto, 'importMask', 1);
route('drawMask', Post, 'images/:imageId/masks/draw', HttpCode(202));
Param('imageId')(proto, 'drawMask', 0);
Body()(proto, 'drawMask', 1);
route('erase', Post, 'erasures', HttpCode(202));
Body()(proto, 'erase', 0);
route('task', Get, 'tasks/:id');
Param('id')(proto, 'task', 0);
route('cancel', Post, 'tasks/:id/cancel', HttpCode(200));
Param('id')(proto, 'cancel', 0);

class AppModule {}
Module({ controllers: [ImageController], providers: [Tasks] })(AppModule);

async function main() {
  const dataRoot = join(root, '.poc-data');
  await mkdir(dataRoot, { recursive: true });
  const directory = await mkdtemp(join(dataRoot, 'run-'));
  const app = await NestFactory.create(AppModule);
  const tasks = app.get(Tasks);
  app.enableShutdownHooks();
  app.useStaticAssets(join(root, 'public'));
  // Uploaded bytes remain inaccessible. Only files produced by the worker end in PNG.
  app.use('/files', (req, res, next) => {
    if (!/^\/[0-9a-f-]{36}-(original|preview|mask|overlay|result)\.png$/.test(req.path)) {
      return res.sendStatus(404);
    }
    next();
  });
  app.useStaticAssets(directory, { prefix: '/files/' });
  try {
    await tasks.start(directory);
    await app.listen(Number(process.env.PORT ?? 3000), '127.0.0.1');
    console.log('图片擦除 Demo ' + await app.getUrl());
  } catch (error) {
    await app.close();
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
