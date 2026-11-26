const el = (id) => document.getElementById(id);
const state = {
  image: null, mask: null, points: [], label: 1, mode: 'point', revision: 0,
  jobs: new Map(), erasing: new Set(), pendingMask: false, applying: false,
};
const types = { upload: '图片上传', segment: '点选分割', mask: '校验 mask', draw: '手绘选区', erase: '局部擦除' };
const brush = new Brush(el('drawing'), el('preview'), el('overlay'), () => {
  if (brush.strokes.length === 1) state.revision++;
  el('result-panel').hidden = true;
  hint('可继续手绘，或点击「擦除选区」');
  renderSelection();
});
const terminal = new Set(['succeeded', 'failed', 'cancelled']);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let activeTask = null;
let selectionTask = null;

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
  for (const id of ['reset', 'import-button', 'mask-input']) el(id).disabled = !image;
  for (const id of ['positive', 'negative']) el(id).disabled = !image || brush.dirty || applying;
  for (const id of ['paint', 'subtract']) {
    el(id).disabled = !image || pendingMask || applying;
    el(id).setAttribute('aria-pressed', mode === id);
  }
  el('positive').setAttribute('aria-pressed', !drawing && label === 1);
  el('negative').setAttribute('aria-pressed', !drawing && label === 0);
  el('brush-settings').hidden = !drawing;
  el('drawing').hidden = !drawing;
  el('apply-drawing').disabled = !brush.dirty || applying;
  el('erase').disabled = applying || (brush.dirty ? state.erasing.size > 0
    : !mask || mask.areaRatio > 0.5 || state.erasing.has(mask.id));
  el('area').textContent = brush.dirty ? '待计算' : mask ? mask.areaPixels.toLocaleString() + ' px²' : '—';
  el('ratio').textContent = mask && !brush.dirty ? (mask.areaRatio * 100).toFixed(3) + '%' : '—';
  el('overlay').hidden = !mask || brush.dirty;
  el('mask-download').hidden = !mask || brush.dirty;
  if (mask) {
    if (el('overlay').getAttribute('src') !== mask.overlayUrl) el('overlay').src = mask.overlayUrl;
    el('mask-download').href = mask.maskUrl;
  }
  el('points').replaceChildren(...points.map(({ x, y, label }) => {
    const dot = document.createElement('span');
    dot.className = label ? 'point' : 'point negative';
    dot.style.left = x / image.width * 100 + '%';
    dot.style.top = y / image.height * 100 + '%';
    return dot;
  }));
}

function clearSelection() {
  state.revision++;
  state.points = [];
  state.mask = null;
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
  el('drawing').addEventListener(event, (pointer) => brush.stop(pointer));
}

async function applyDrawing() {
  if (!brush.dirty || state.applying) return null;
  const { image, mask, revision } = state;
  state.applying = true;
  renderSelection();
  hint('正在计算手绘选区面积');
  try {
    const edited = await job('/api/images/' + image.id + '/masks/draw', {
      maskId: mask?.id, strokes: brush.strokes,
    });
    if (revision !== state.revision) return null;
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

el('reset').addEventListener('click', () => {
  clearSelection();
  hint('已清除选区');
});

async function selectPoint(fractionX, fractionY) {
  const image = state.image;
  if (!image || state.mode !== 'point') return;
  if (!state.label && !state.points.length) return hint('请先添加一个前景点', true);
  if (state.points.length >= 16) return hint('最多 16 个点，可清除后重新选取', true);
  const revision = ++state.revision;
  const x = Math.min(image.width - 1, Math.max(0, Math.floor(fractionX * image.width)));
  const y = Math.min(image.height - 1, Math.max(0, Math.floor(fractionY * image.height)));
  state.points.push({ x, y, label: state.label });
  state.mask = null;
  state.pendingMask = true;
  brush.reset();
  el('result-panel').hidden = true;
  renderSelection();
  hint('正在计算选区');
  if (selectionTask) cancelTask(selectionTask);
  selectionTask = null;
  try {
    const mask = await job('/api/segmentations', { imageId: image.id, points: state.points }, ({ id }) => {
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
  const mask = brush.dirty ? await applyDrawing() : state.mask;
  if (!image || !mask || mask.areaRatio > 0.5 || revision !== state.revision || state.erasing.has(mask.id)) return;
  state.erasing.add(mask.id);
  renderSelection();
  try {
    hint('正在擦除选区');
    const result = await job('/api/erasures', { imageId: image.id, maskId: mask.id });
    if (revision !== state.revision) return;
    el('result-image').src = result.imageUrl;
    el('compare').dataset.original = image.originalUrl;
    el('compare').dataset.result = result.imageUrl;
    el('compare').setAttribute('aria-pressed', 'false');
    el('compare').textContent = '查看原图';
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

el('compare').addEventListener('click', (event) => {
  const button = event.currentTarget;
  const showOriginal = button.getAttribute('aria-pressed') !== 'true';
  button.setAttribute('aria-pressed', showOriginal);
  button.textContent = showOriginal ? '查看结果' : '查看原图';
  el('result-image').src = showOriginal ? button.dataset.original : button.dataset.result;
});

el('cancel').addEventListener('click', () => activeTask && cancelTask(activeTask.id));
request('/api/health').then(({ ready, device }) => {
  el('device').textContent = ready ? device + ' · 本地运行' : '模型未就绪';
}).catch(() => {
  el('device').textContent = '连接失败';
});
