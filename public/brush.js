class Brush {
  strokes = [];
  pointCount = 0;
  active = null;

  constructor(canvas, preview, overlay, onChange) {
    this.canvas = canvas;
    this.preview = preview;
    this.overlay = overlay;
    this.onChange = onChange;
    this.context = canvas.getContext('2d', { willReadFrequently: true });
  }

  get dirty() {
    return this.strokes.length > 0;
  }

  reset() {
    this.strokes = [];
    this.pointCount = 0;
    this.active = null;
    this.canvas.width = 0;
    this.canvas.height = 0;
  }

  prepare(image, mask) {
    this.image = image;
    if (this.dirty) return true;
    const width = this.preview.naturalWidth;
    const height = this.preview.naturalHeight;
    if (!width || !height || (mask && (!this.overlay.complete || !this.overlay.naturalWidth))) return false;
    if (this.canvas.width === width && this.canvas.height === height) return true;
    this.canvas.width = width;
    this.canvas.height = height;
    if (mask) {
      this.context.drawImage(this.overlay, 0, 0, width, height);
      const pixels = this.context.getImageData(0, 0, width, height);
      for (let i = 3; i < pixels.data.length; i += 4) pixels.data[i] = pixels.data[i] > 64 ? 255 : 0;
      this.context.putImageData(pixels, 0, 0);
    }
    return true;
  }

  start(event, mode, diameter, image, mask) {
    if (event.button !== 0 || this.active || !this.prepare(image, mask)) return;
    if (this.strokes.length >= 64 || this.pointCount >= 1500) return '请先应用已画的笔迹';
    const box = this.canvas.getBoundingClientRect();
    const scale = Math.max(image.width, image.height) / Math.max(box.width, box.height);
    const radius = Math.min(2048, Math.max(1, Math.round(diameter * scale / 2)));
    const stroke = { mode, radius, points: [] };
    this.strokes.push(stroke);
    this.active = { pointerId: event.pointerId, stroke };
    this.canvas.setPointerCapture(event.pointerId);
    this.addPoint(event);
  }

  addPoint(event) {
    if (this.active?.pointerId !== event.pointerId || this.pointCount >= 1500) return;
    const { stroke } = this.active;
    const { width, height } = this.image;
    const box = this.canvas.getBoundingClientRect();
    const x = Math.min(width - 1, Math.max(0, Math.floor((event.clientX - box.left) / box.width * width)));
    const y = Math.min(height - 1, Math.max(0, Math.floor((event.clientY - box.top) / box.height * height)));
    const last = stroke.points.at(-1);
    if (last?.[0] === x && last?.[1] === y) return;
    stroke.points.push([x, y]);
    this.pointCount++;
    const context = this.context;
    context.save();
    context.scale(this.canvas.width / width, this.canvas.height / height);
    context.globalCompositeOperation = stroke.mode === 'subtract' ? 'destination-out' : 'source-over';
    context.fillStyle = context.strokeStyle = '#46e699';
    context.beginPath();
    if (last) {
      context.lineWidth = stroke.radius * 2;
      context.lineCap = 'round';
      context.moveTo(last[0], last[1]);
      context.lineTo(x, y);
      context.stroke();
    } else {
      context.arc(x, y, stroke.radius, 0, Math.PI * 2);
      context.fill();
    }
    context.restore();
    if (!last) this.onChange();
  }

  stop(event) {
    if (this.active?.pointerId !== event.pointerId) return;
    if (event.type === 'pointerup') this.addPoint(event);
    this.active = null;
  }
}
