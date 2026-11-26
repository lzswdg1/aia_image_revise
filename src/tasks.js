const { randomUUID } = require('node:crypto');
const { join } = require('node:path');
const { unlink } = require('node:fs/promises');
const { Worker } = require('node:worker_threads');
const {
  BadRequestException, NotFoundException, ServiceUnavailableException, HttpException,
} = require('@nestjs/common');

const MAX_QUEUED = 12;
const RETAIN_TASKS = 120;

class Tasks {
  records = new Map();
  images = new Map();
  masks = new Map();
  queue = [];
  ready = false;
  current = null;

  async start(directory) {
    this.directory = directory;
    this.worker = new Worker(join(__dirname, 'inference-worker.js'));
    await new Promise((resolve, reject) => {
      const disconnected = (error) => {
        const message = error instanceof Error ? error.message : '推理线程已退出';
        if (this.ready) this.onWorkerFailure(message);
        else reject(new Error(message));
      };
      this.worker.on('error', disconnected);
      this.worker.on('exit', disconnected);
      this.worker.on('message', (message) => {
        if (message.startupError) reject(new Error(message.startupError));
        else if (message.ready) {
          this.ready = true;
          resolve();
        } else this.onMessage(message);
      });
    });
  }

  async onApplicationShutdown() {
    this.ready = false;
    await this.worker?.terminate();
  }

  image(id) {
    const image = this.images.get(id);
    if (!image) throw new NotFoundException('图片不存在或服务已重启');
    return image;
  }

  mask(id, imageId) {
    const mask = this.masks.get(id);
    if (!mask) throw new NotFoundException('Mask 不存在');
    if (mask.imageId !== imageId) throw new BadRequestException('Mask 不属于此图片');
    return mask;
  }

  add(type, args) {
    if (!this.ready) throw new ServiceUnavailableException('推理线程未就绪');
    if (this.queue.length >= MAX_QUEUED) throw new HttpException('队列已满，请稍后重试', 429);
    const id = randomUUID();
    const task = { id, type, status: 'queued', stage: '等待执行', queuedAt: Date.now() };
    this.records.set(id, task);
    this.queue.push({ ...args, type, id, directory: this.directory });
    this.pump();
    return task;
  }

  get(id) {
    const task = this.records.get(id);
    if (!task) throw new NotFoundException('找不到任务');
    return task;
  }

  cancel(id) {
    const task = this.get(id);
    if (task.status === 'queued') {
      const index = this.queue.findIndex((job) => job.id === id);
      if (index !== -1) {
        const [job] = this.queue.splice(index, 1);
        this.finish(job, 'cancelled', '已取消');
      }
    } else if (task.status === 'running') {
      task.cancelRequested = true;
      task.stage = '等待当前计算结束';
    }
    return task;
  }

  pump() {
    if (!this.ready || this.current || !this.queue.length) return;
    const interactive = this.queue.findIndex(({ type }) => type === 'segment');
    const [job] = this.queue.splice(Math.max(0, interactive), 1);
    this.current = job;
    const task = this.get(job.id);
    task.status = 'running';
    task.stage = '开始执行';
    task.startedAt = Date.now();
    task.queueMs = task.startedAt - task.queuedAt;
    task.peakRssBytes = process.memoryUsage.rss();
    this.memorySample = setInterval(() => {
      task.peakRssBytes = Math.max(task.peakRssBytes, process.memoryUsage.rss());
    }, 100);
    this.worker.postMessage(job);
  }

  finish(job, status, stage, fields = {}) {
    const task = this.get(job.id);
    const finishedAt = Date.now();
    Object.assign(task, {
      status, stage, finishedAt,
      totalMs: finishedAt - task.queuedAt,
      ...(task.startedAt ? {
        runMs: finishedAt - task.startedAt,
        peakRssBytes: Math.max(task.peakRssBytes, process.memoryUsage.rss()),
      } : {}),
      ...fields,
    });
    if (job.input) unlink(job.input).catch(() => {});
    for (const [id, record] of this.records) {
      if (this.records.size <= RETAIN_TASKS) break;
      if (!['queued', 'running'].includes(record.status)) this.records.delete(id);
    }
  }

  onMessage({ id, stage, result, error }) {
    const job = this.current;
    if (!job || id !== job.id) return;
    const task = this.get(id);
    if (stage) {
      if (!task.cancelRequested) task.stage = stage;
      return;
    }
    clearInterval(this.memorySample);
    if (task.cancelRequested) {
      this.finish(job, 'cancelled', '已取消');
    } else if (error) {
      // Sharp errors can include absolute input paths. Keep those in the local log.
      const safeError = /[\u4e00-\u9fff]/u.test(error) ? error : '处理失败，请检查图片格式、像素上限或服务日志';
      console.error('任务失败', id, error);
      this.finish(job, 'failed', '失败', { error: safeError });
    } else {
      this.finish(job, 'succeeded', '完成', { result: this.publish(id, result) });
    }
    this.current = null;
    this.pump();
  }

  publish(id, { image, mask, result }) {
    if (image) {
      this.images.set(id, image);
      const { file, ...metadata } = image;
      return { ...metadata, previewUrl: '/files/' + id + '-preview.png', originalUrl: '/files/' + id + '-original.png' };
    }
    if (mask) {
      this.masks.set(id, mask);
      const { file, ...metadata } = mask;
      return { ...metadata, maskUrl: '/files/' + id + '-mask.png', overlayUrl: '/files/' + id + '-overlay.png' };
    }
    return { ...result, imageUrl: '/files/' + id + '-result.png' };
  }

  onWorkerFailure(message) {
    this.ready = false;
    clearInterval(this.memorySample);
    console.error(message);
    const pending = this.current ? [this.current, ...this.queue] : this.queue;
    for (const job of pending) this.finish(job, 'failed', '失败', { error: '推理线程已退出，请重启服务' });
    this.current = null;
    this.queue = [];
  }
}

module.exports = { Tasks };
