const el = (id) => document.getElementById(id);
const state = {
  image: null, mask: null, points: [], label: 1, mode: 'point', revision: 0,
  jobs: new Map(), erasing: new Set(), pendingMask: false, applying: false,
  drawingHistory: [], pointBase: null, expandedMask: null, expansionRadius: 0, expanding: false,
};
const types = { upload: '图片上传', segment: '点选分割', mask: '校验 mask', draw: '手绘选区', expand: '扩选预览', erase: '局部擦除' };
const brush = new Brush(el('drawing'), el('preview'), el('overlay'), () => {
  state.revision++;
  invalidateExpansion();
  el('result-panel').hidden = true;
  hint(state.expansionRadius ? '手绘有变更，请重新预览扩选' : '可继续手绘，或点击「擦除选区」');
  renderSelection();
});
const comparison = new ResultComparison({
  range: el('compare-split'), frame: el('compare-frame'), scroll: el('compare-scroll'),
  divider: el('compare-divider'),
  originalButton: el('compare'), zoomButton: el('compare-zoom'),
  original: el('compare-original'), result: el('result-image'),
});
const terminal = new Set(['succeeded', 'failed', 'cancelled']);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let activeTask = null;
let selectionTask = null;
let expansionRequest = 0;

function hint(message, error = false) {
  el('hint').textContent = message;
  el('hint').classList.toggle('error', error);
}

async function request(url, body) {
  let options;
  if (body instanceof FormData) options = { method: 'POST', body };
  else if (body !== undefined) {
    options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  }
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || '请求失败');
  return result;
}

function renderJobs() {
  const jobs = [...state.jobs.values()].reverse();
  el('task-empty').hidden = jobs.length > 0;
  activeTask = jobs.find((task) => !terminal.has(task.status));
  el('cancel').hidden = !activeTask || Boolean(activeTask.cancelRequested);
  el('task-list').replaceChildren(...jobs.slice(0, 5).map((task) => {
    const li = document.createElement('li');
    const title = document.createElement('strong');
    title.textContent = types[task.type] + ' · ' + task.stage;
    li.append(title);
    if (task.error || task.runMs !== undefined) {
      const line = document.createElement('small');
      const rss = task.peakRssBytes ? ' · RSS ' + Math.round(task.peakRssBytes / 2 ** 20) + ' MiB' : '';
      line.textContent = task.error || '排队 ' + task.queueMs + ' ms · 执行 ' + task.runMs + ' ms' + rss;
      li.append(line);
    }
    return li;
  }));
}

function updateTask(task) {
  state.jobs.set(task.id, task);
  if (state.jobs.size > 20) {
    const old = [...state.jobs.values()].find((entry) => terminal.has(entry.status));
    if (old) state.jobs.delete(old.id);
  }
  renderJobs();
}

async function job(url, body, onStart) {
  let task = await request(url, body);
  onStart?.(task);
  updateTask(task);
  while (!terminal.has(task.status)) {
    await wait(240);
    task = await request('/api/tasks/' + task.id);
    updateTask(task);
  }
  if (task.status !== 'succeeded') throw new Error(task.error || '任务已取消');
  return task.result;
}

function fileForm(file) {
  const data = new FormData();
  data.append('file', file);
  return data;
}

function renderSelection() {
  const { image, mask, points, label, mode, applying, pendingMask } = state;
  const drawing = mode !== 'point';
  const effectiveMask = state.expandedMask ?? mask;
  const draft = brush.dirty;
  const busy = applying || Boolean(brush.active);
  for (const id of ['reset', 'import-button', 'mask-input']) el(id).disabled = !image;
  for (const id of ['positive', 'negative']) el(id).disabled = !image || draft || busy;
  for (const id of ['paint', 'subtract']) {
    el(id).disabled = !image || pendingMask || busy;
    el(id).setAttribute('aria-pressed', mode === id);
  }
  el('positive').setAttribute('aria-pressed', !drawing && label === 1);
  el('negative').setAttribute('aria-pressed', !drawing && label === 0);
  el('brush-settings').hidden = !drawing;
  el('drawing').hidden = !drawing;
  el('apply-drawing').disabled = !draft || busy;
  el('undo').disabled = busy || !(draft || points.length || state.drawingHistory.length);
  el('erase').disabled = busy || (state.expansionRadius > 0 && !state.expandedMask) || (draft ? state.erasing.size > 0
    : !effectiveMask || effectiveMask.areaRatio > 0.5 || state.erasing.has(effectiveMask.id));
  el('area').textContent = draft ? '待计算' : effectiveMask ? effectiveMask.areaPixels.toLocaleString() + ' px²' : '—';
  el('ratio').textContent = effectiveMask && !draft ? (effectiveMask.areaRatio * 100).toFixed(3) + '%' : '—';
  el('overlay').hidden = !mask || draft || Boolean(state.expandedMask);
  el('expanded-overlay').hidden = !state.expandedMask;
  el('mask-download').hidden = !effectiveMask || draft;
  if (mask) {
    if (el('overlay').getAttribute('src') !== mask.overlayUrl) el('overlay').src = mask.overlayUrl;
  }
  if (state.expandedMask) el('expanded-overlay').src = state.expandedMask.overlayUrl;
  if (effectiveMask) el('mask-download').href = effectiveMask.maskUrl;
  el('expand-radius').disabled = busy || (!mask && !draft);
  el('expand-radius').value = state.expansionRadius;
  el('expand-value').textContent = state.expansionRadius + ' px';
  el('expand-preview').disabled = busy || state.expanding || Boolean(state.expandedMask)
    || !state.expansionRadius || (!mask && !draft);
  el('expand-status').textContent = expansionStatus();
  el('points').replaceChildren(...points.map(({ x, y, label }) => {
    const dot = document.createElement('span');
    dot.className = label ? 'point' : 'point negative';
    dot.style.left = x / image.width * 100 + '%';
    dot.style.top = y / image.height * 100 + '%';
    return dot;
  }));
}

function expansionStatus() {
  if (!state.expansionRadius) return '按原图像素计算';
  if (state.expanding) return '正在计算扩选范围';
  if (!state.expandedMask) return '预览后可擦除扩选范围';
  if (state.expandedMask.areaRatio > 0.5) return '扩选超过 50%，请缩小范围';
  return '绿色区域为实际擦除范围';
}

function invalidateExpansion() {
  expansionRequest++;
  state.expandedMask = null;
  state.expanding = false;
}

function clearSelection() {
  state.revision++;
  state.points = [];
  state.mask = null;
  state.pointBase = null;
  state.drawingHistory = [];
  state.expansionRadius = 0;
  invalidateExpansion();
  state.pendingMask = false;
  state.applying = false;
  brush.reset();
  el('result-panel').hidden = true;
  if (selectionTask) cancelTask(selectionTask);
  selectionTask = null;
  renderSelection();
}

async function cancelTask(id) {
  try {
    updateTask(await request('/api/tasks/' + id + '/cancel', {}));
  } catch (error) {
    hint(error.message, true);
  }
}

el('upload-button').addEventListener('click', () => el('image-input').click());
el('import-button').addEventListener('click', () => el('mask-input').click());
el('image-input').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  el('upload-button').disabled = true;
  try {
    hint('正在上传与解码');
    const image = await job('/api/images', fileForm(file));
    state.image = image;
    state.label = 1;
    state.mode = 'point';
    clearSelection();
    el('preview').src = image.previewUrl;
    el('empty').hidden = true;
    el('viewport').hidden = false;
    el('dimensions').textContent = image.width + ' × ' + image.height + ' px' + (image.large ? ' · 大图' : '');
    hint('点击目标自动选区，或用「画笔」拖动涂抹');
  } catch (error) {
    hint(error.message, true);
  } finally {
    el('upload-button').disabled = false;
  }
});

for (const [id, label] of [['positive', 1], ['negative', 0]]) {
  el(id).addEventListener('click', () => {
    state.mode = 'point';
    state.label = label;
    renderSelection();
  });
}

for (const mode of ['paint', 'subtract']) {
  el(mode).addEventListener('click', () => {
    state.mode = mode;
    hint(mode === 'paint' ? '按住鼠标拖动，涂出要擦除的区域' : '按住鼠标拖动，从选区中减去区域');
    renderSelection();
  });
}

el('drawing').addEventListener('pointerdown', (event) => {
  if (!state.image || state.applying) return;
  const message = brush.start(event, state.mode, Number(el('brush-size').value), state.image, state.mask);
  if (message) hint(message, true);
});
el('drawing').addEventListener('pointermove', (event) => brush.addPoint(event));
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  el('drawing').addEventListener(event, (pointer) => {
    if (brush.active?.pointerId !== pointer.pointerId) return;
    brush.stop(pointer);
    renderSelection();
  });
}
el('overlay').addEventListener('load', () => {
  if (brush.dirty) brush.prepare(state.image, state.mask);
});

async function applyDrawing() {
  if (!brush.dirty || state.applying) return null;
  const { image, mask, points, revision } = state;
  const strokes = brush.strokes.slice();
  state.applying = true;
  renderSelection();
  hint('正在计算手绘选区面积');
  try {
    const edited = await job('/api/images/' + image.id + '/masks/draw', {
      maskId: mask?.id, strokes,
    });
    if (revision !== state.revision) return null;
    state.drawingHistory.push({ mask, points, strokes });
    state.mask = edited.empty ? null : edited;
    state.points = [];
    brush.reset();
    hint(edited.empty ? '选区已清空' : edited.areaRatio > 0.5
      ? '选区超过 50%，可以用橡皮缩小' : '已应用手绘选区');
    return state.mask;
  } catch (error) {
    if (revision === state.revision) hint(error.message, true);
    return null;
  } finally {
    if (revision === state.revision) {
      state.applying = false;
      renderSelection();
    }
  }
}

el('apply-drawing').addEventListener('click', applyDrawing);

el('expand-radius').addEventListener('input', (event) => {
  state.expansionRadius = Number(event.target.value);
  state.revision++;
  invalidateExpansion();
  el('result-panel').hidden = true;
  renderSelection();
});

el('expand-preview').addEventListener('click', async () => {
  const { image, revision, expansionRadius: radius } = state;
  const mask = brush.dirty ? await applyDrawing() : state.mask;
  if (!mask || !radius || revision !== state.revision) return;
  const requestId = ++expansionRequest;
  state.expanding = true;
  renderSelection();
  try {
    const expanded = await job('/api/images/' + image.id + '/masks/expand', { maskId: mask.id, radius });
    if (requestId !== expansionRequest) return;
    const preview = new Image();
    preview.src = expanded.overlayUrl;
    await preview.decode();
    if (requestId === expansionRequest) state.expandedMask = expanded;
  } catch (error) {
    if (requestId === expansionRequest) hint(error.message, true);
  } finally {
    if (requestId === expansionRequest) {
      state.expanding = false;
      renderSelection();
    }
  }
});

el('reset').addEventListener('click', () => {
  clearSelection();
  hint('已清除选区');
});

async function selectPoint(fractionX, fractionY) {
  const image = state.image;
  if (!image || state.mode !== 'point') return;
  if (!state.label && !state.points.length) return hint('请先添加一个前景点', true);
  if (state.points.length >= 16) return hint('最多 16 个点，可清除后重新选取', true);
  const x = Math.min(image.width - 1, Math.max(0, Math.floor(fractionX * image.width)));
  const y = Math.min(image.height - 1, Math.max(0, Math.floor(fractionY * image.height)));
  if (!state.points.length) {
    state.pointBase = { mask: state.mask, drawingHistory: state.drawingHistory };
    state.drawingHistory = [];
  }
  state.points = [...state.points, { x, y, label: state.label }];
  await resolvePoints();
}

async function resolvePoints() {
  const { image, points } = state;
  const revision = ++state.revision;
  invalidateExpansion();
  state.mask = null;
  state.pendingMask = true;
  brush.reset();
  el('result-panel').hidden = true;
  renderSelection();
  hint('正在计算选区');
  if (selectionTask) cancelTask(selectionTask);
  selectionTask = null;
  try {
    const mask = await job('/api/segmentations', { imageId: image.id, points }, ({ id }) => {
      if (revision === state.revision) selectionTask = id;
      else cancelTask(id);
    });
    if (revision !== state.revision) return;
    state.mask = mask;
    renderSelection();
    hint(mask.areaRatio > 0.5 ? '选区超过 50%，请增加背景点缩小选区'
      : (mask.cacheHit ? '已复用图片特征' : '选区已生成') + ' · 解码 ' + mask.decodeMs + ' ms');
  } catch (error) {
    if (revision === state.revision) hint(error.message, true);
  } finally {
    if (revision === state.revision) {
      selectionTask = null;
      state.pendingMask = false;
      renderSelection();
    }
  }
}

function undo() {
  if (el('undo').disabled) return;
  if (brush.dirty || state.drawingHistory.length) {
    const draft = brush.dirty ? { mask: state.mask, points: state.points, strokes: brush.strokes }
      : state.drawingHistory.pop();
    state.revision++;
    invalidateExpansion();
    state.mask = draft.mask;
    state.points = draft.points;
    if (state.mode === 'point') state.mode = 'paint';
    el('result-panel').hidden = true;
    renderSelection();
    brush.restore(draft.strokes.slice(0, -1), state.image, state.mask);
    hint('已撤销上一笔');
    renderSelection();
    return;
  }
  state.points = state.points.slice(0, -1);
  if (state.points.length) {
    resolvePoints();
    return;
  }
  state.revision++;
  invalidateExpansion();
  if (selectionTask) cancelTask(selectionTask);
  selectionTask = null;
  state.pendingMask = false;
  state.mask = state.pointBase?.mask ?? null;
  state.drawingHistory = state.pointBase?.drawingHistory ?? [];
  state.pointBase = null;
  el('result-panel').hidden = true;
  hint('已撤销点击');
  renderSelection();
}

el('undo').addEventListener('click', undo);

el('preview').addEventListener('click', (event) => {
  const box = event.currentTarget.getBoundingClientRect();
  selectPoint((event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height);
});
el('preview').addEventListener('keydown', (event) => {
  if (!['Enter', ' '].includes(event.key)) return;
  event.preventDefault();
  selectPoint(0.5, 0.5);
});

el('mask-input').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file || !state.image) return;
  clearSelection();
  const revision = state.revision;
  state.mode = 'point';
  state.pendingMask = true;
  renderSelection();
  try {
    const mask = await job('/api/images/' + state.image.id + '/masks', fileForm(file));
    if (revision !== state.revision) return;
    state.mask = mask;
    renderSelection();
    hint(mask.areaRatio > 0.5 ? 'Mask 已校验。选区超过 50%，请缩小后再擦除' : 'Mask 已校验');
  } catch (error) {
    if (revision === state.revision) hint(error.message, true);
  } finally {
    if (revision === state.revision) {
      state.pendingMask = false;
      renderSelection();
    }
  }
});

el('erase').addEventListener('click', async () => {
  const { image, revision } = state;
  const mask = brush.dirty ? await applyDrawing() : state.expandedMask ?? state.mask;
  if (!image || !mask || mask.areaRatio > 0.5 || revision !== state.revision || state.erasing.has(mask.id)) return;
  state.erasing.add(mask.id);
  renderSelection();
  try {
    hint('正在擦除选区');
    const result = await job('/api/erasures', { imageId: image.id, maskId: mask.id });
    if (revision !== state.revision) return;
    comparison.show(image, result, mask.bbox);
    el('download').href = result.imageUrl;
    el('result-info').textContent = result.width + ' × ' + result.height + ' px · 裁剪 ' +
      result.crop.width + ' × ' + result.crop.height + ' · 推理 ' + result.inferenceMs + ' ms';
    el('result-panel').hidden = false;
    hint('擦除完成');
  } catch (error) {
    if (revision === state.revision) hint(error.message, true);
  } finally {
    state.erasing.delete(mask.id);
    renderSelection();
  }
});

el('return-to-editor').addEventListener('click', () => {
  el('paint').focus({ preventScroll: true });
  el('preview').scrollIntoView({ block: 'center', behavior: 'smooth' });
});

el('cancel').addEventListener('click', () => activeTask && cancelTask(activeTask.id));
request('/api/health').then(({ ready, device }) => {
  el('device').textContent = ready ? device + ' · 本地运行' : '模型未就绪';
}).catch(() => {
  el('device').textContent = '连接失败';
});
