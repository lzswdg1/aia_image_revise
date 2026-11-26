class ResultComparison {
  constructor(elements) {
    Object.assign(this, elements);
    this.range.addEventListener('input', () => this.setSplit(Number(this.range.value)));
    this.originalButton.addEventListener('click', () => {
      this.setSplit(this.range.value === '100' ? 50 : 100);
    });
    this.zoomButton.addEventListener('click', () => this.setZoom(!this.frame.classList.contains('native')));
    this.divider.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      this.divider.setPointerCapture(event.pointerId);
    });
    this.divider.addEventListener('pointermove', (event) => {
      if (!this.divider.hasPointerCapture(event.pointerId)) return;
      const frame = this.frame.getBoundingClientRect();
      const percent = Math.round((event.clientX - frame.left) / frame.width * 100);
      this.setSplit(Math.max(1, Math.min(99, percent)));
    });
  }

  show(image, result, bbox) {
    this.bbox = bbox;
    this.frame.style.setProperty('--image-width', result.width + 'px');
    this.result.width = this.original.width = result.width;
    this.result.height = this.original.height = result.height;
    this.original.src = image.originalUrl;
    this.result.src = result.imageUrl;
    this.setSplit(50);
    this.setZoom(false);
  }

  setSplit(value) {
    this.range.value = value;
    this.frame.style.setProperty('--split', value + '%');
    this.frame.classList.toggle('at-edge', value === 0 || value === 100);
    this.originalButton.setAttribute('aria-pressed', value === 100);
    this.originalButton.textContent = value === 100 ? '恢复对比' : '查看原图';
  }

  setZoom(nativeSize) {
    this.frame.classList.toggle('native', nativeSize);
    this.zoomButton.setAttribute('aria-pressed', nativeSize);
    this.zoomButton.textContent = nativeSize ? '适应窗口' : '100% 局部';
    const { left, top, width, height } = this.bbox;
    this.scroll.scrollTo(
      nativeSize ? left + width / 2 - this.scroll.clientWidth / 2 : 0,
      nativeSize ? top + height / 2 - this.scroll.clientHeight / 2 : 0,
    );
  }
}
