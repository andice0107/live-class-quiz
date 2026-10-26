// 田字格手寫板
// 每一格分開記錄學生筆劃（s）和老師筆劃（t），座標是 0~1 的相對位置。
// 學生只能擦、復原、清除自己的筆劃；老師協作時也只能動老師自己的筆劃。

export const TEACHER_INK = '#e5484d';
const ERASE_R = 0.045;

export function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = n => cs.getPropertyValue(n).trim();
  return { ink: v('--ink') || '#f3efe4', bg: v('--pad-bg') || '#1f242b', grid: v('--pad-grid') || 'rgba(255,255,255,.25)' };
}

const q3 = n => Math.round(n * 1000) / 1000;

// 依題型決定格數；造詞由學生自己選 2～4 格
export function defaultCells(q) {
  if (q.cells) return Math.max(1, Math.min(8, Number(q.cells)));
  const ans = String(q.answer ?? '');
  const han = s => (s.match(/[㐀-鿿豈-﫿]/g) || []).length;
  switch (q.type) {
    case 'hanzi': return Math.max(1, Math.min(8, han(ans.split(/[|｜、,，]/)[0]) || 1));
    case 'zhuyin': return Math.max(1, Math.min(8, ans.trim().split(/\s+/).filter(Boolean).length || 1));
    case 'correction': return Math.max(1, Math.min(4, han(ans.split(/→|->|改成|＞|>/).pop()) || 1));
    case 'word': return 2;
    default: return 1;
  }
}
export const useGrid = q => q.type !== 'write';

export function paintCell(ctx, size, { s, t, grid, colors, bg = true }) {
  ctx.clearRect(0, 0, size, size);
  if (bg) { ctx.fillStyle = colors.bg; ctx.fillRect(0, 0, size, size); }
  if (grid) {
    ctx.save();
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = Math.max(1, size / 160);
    ctx.setLineDash([size / 30, size / 40]);
    ctx.beginPath();
    ctx.moveTo(size / 2, 0); ctx.lineTo(size / 2, size);
    ctx.moveTo(0, size / 2); ctx.lineTo(size, size / 2);
    ctx.stroke();
    ctx.restore();
  }
  const lw = Math.max(1.5, size * 0.03);
  drawStrokes(ctx, size, s || [], colors.ink, lw);
  drawStrokes(ctx, size, t || [], TEACHER_INK, lw);
}

function drawStrokes(ctx, size, strokes, color, lw) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = lw;
  for (const st of strokes) {
    if (!st || !st.length) continue;
    if (st.length === 1) {
      ctx.beginPath();
      ctx.arc(st[0][0] * size, st[0][1] * size, lw / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(st[0][0] * size, st[0][1] * size);
    for (let i = 1; i < st.length - 1; i++) {
      const mx = (st[i][0] + st[i + 1][0]) / 2, my = (st[i][1] + st[i + 1][1]) / 2;
      ctx.quadraticCurveTo(st[i][0] * size, st[i][1] * size, mx * size, my * size);
    }
    const last = st[st.length - 1];
    ctx.lineTo(last[0] * size, last[1] * size);
    ctx.stroke();
  }
}

const arr = a => (Array.isArray(a) ? a.filter(Boolean) : a && typeof a === 'object' ? Object.values(a) : []);
export const cellData = c => ({ s: arr(c && c.s).map(arr), t: arr(c && c.t).map(arr) });
export const hasInk = ink => !!ink && arr(ink.c).some(c => cellData(c).s.length);

// 把一位學生的所有格子畫成一張縮圖
export function paintInkThumb(canvas, ink, { grid = true } = {}) {
  const cells = arr(ink && ink.c);
  const n = Math.max(1, (ink && ink.n) || cells.length || 1);
  const r = canvas.getBoundingClientRect();
  const W = Math.max(10, r.width), H = Math.max(10, r.height);
  const gap = 4;
  // 選排法：讓每格最大
  let best = { cols: n, size: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const size = Math.min((W - gap * (cols - 1)) / cols, (H - gap * (rows - 1)) / rows);
    if (size > best.size) best = { cols, size };
  }
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const colors = themeColors();
  const rows = Math.ceil(n / best.cols);
  const totalW = best.cols * best.size + gap * (best.cols - 1);
  const totalH = rows * best.size + gap * (rows - 1);
  const ox = (W - totalW) / 2, oy = (H - totalH) / 2;
  for (let i = 0; i < n; i++) {
    const x = ox + (i % best.cols) * (best.size + gap);
    const y = oy + Math.floor(i / best.cols) * (best.size + gap);
    ctx.save();
    ctx.translate(x, y);
    paintCell(ctx, best.size, { ...cellData(cells[i]), grid, colors });
    ctx.restore();
  }
}

export class InkCell {
  // own：'s' 學生、't' 老師
  constructor(canvas, { own = 's', grid = true, onChange = () => {} } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.own = own;
    this.grid = grid;
    this.s = [];
    this.t = [];
    this.tool = 'pen';
    this.history = [];
    this.enabled = true;
    this.onChange = onChange;
    this.active = null;
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', e => this.down(e));
    canvas.addEventListener('pointermove', e => this.move(e));
    for (const ev of ['pointerup', 'pointercancel']) canvas.addEventListener(ev, () => this.up());
    new ResizeObserver(() => this.redraw()).observe(canvas);
  }

  get mine() { return this[this.own]; }
  set mine(v) { this[this.own] = v; }
  get other() { return this.own === 's' ? 't' : 's'; }

  pt(e) {
    const r = this.canvas.getBoundingClientRect();
    return [q3(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))), q3(Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)))];
  }

  down(e) {
    if (!this.enabled) return;
    e.preventDefault();
    this.canvas.setPointerCapture?.(e.pointerId);
    const p = this.pt(e);
    if (this.tool === 'pen') {
      const st = [p];
      this.mine = [...this.mine, st];
      this.active = { type: 'add', stroke: st };
    } else {
      this.active = { type: 'erase', removed: [] };
      this.eraseAt(p);
    }
    this.redraw();
  }

  move(e) {
    if (!this.active) return;
    e.preventDefault();
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ce of evs) {
      const p = this.pt(ce);
      if (this.active.type === 'add') this.active.stroke.push(p);
      else this.eraseAt(p);
    }
    this.redraw();
    this.onChange('live');
  }

  up() {
    if (!this.active) return;
    const a = this.active;
    this.active = null;
    if (a.type === 'erase' && !a.removed.length) return;
    this.history.push(a);
    this.onChange('end');
  }

  // 橡皮擦：碰到的整筆擦掉（只擦自己的）
  eraseAt([x, y]) {
    const keep = [];
    for (const st of this.mine) {
      const hit = st.some(([a, b]) => (a - x) ** 2 + (b - y) ** 2 < ERASE_R ** 2);
      if (hit) this.active.removed.push(st); else keep.push(st);
    }
    if (keep.length !== this.mine.length) this.mine = keep;
  }

  undo() {
    const a = this.history.pop();
    if (!a) return;
    if (a.type === 'add') this.mine = this.mine.filter(s => s !== a.stroke);
    else if (a.type === 'erase') this.mine = [...this.mine, ...a.removed];
    else if (a.type === 'clear') this.mine = a.prev;
    this.redraw();
    this.onChange('end');
  }

  clear() {
    if (!this.mine.length) return;
    this.history.push({ type: 'clear', prev: this.mine });
    this.mine = [];
    this.redraw();
    this.onChange('end');
  }

  // 別人（老師）清掉了我的筆劃：不能復原
  wipeMine() { this.mine = []; this.history = []; this.redraw(); this.onChange('end'); }
  setOther(strokes) { this[this.other] = strokes || []; this.redraw(); }
  setMine(strokes) { this.mine = strokes || []; this.redraw(); }
  setEnabled(on) { this.enabled = on; if (!on) this.active = null; this.canvas.classList.toggle('locked', !on); }

  redraw() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const size = Math.round(Math.min(r.width, r.height) * dpr);
    if (!size) return;
    if (this.canvas.width !== size) { this.canvas.width = size; this.canvas.height = size; }
    paintCell(this.ctx, size, { s: this.s, t: this.t, grid: this.grid, colors: themeColors() });
  }
}

// 一組田字格（每格下面各有一條工具列）
export function buildCells(container, n, { own = 's', grid = true, teacher = false, onChange }) {
  container.innerHTML = '';
  container.classList.add('cells');
  const cells = [];
  for (let i = 0; i < n; i++) {
    const box = document.createElement('div');
    box.className = 'cell-box';
    box.innerHTML = `<canvas class="cell"></canvas>
      <div class="cell-tools">
        <button data-tool="pen" class="on" title="鉛筆">✏️<span>鉛筆</span></button>
        <button data-tool="eraser" title="橡皮擦">🧽<span>橡皮擦</span></button>
        <button data-act="undo" title="復原">↶<span>復原</span></button>
        <button data-act="clear" title="${teacher ? '清除老師筆劃' : '全部清除'}">🗑<span>${teacher ? '清老師' : '清除'}</span></button>
        ${teacher ? '<button data-act="wipeS" class="danger" title="清除學生筆劃">✕<span>清學生</span></button>' : ''}
      </div>`;
    container.append(box);
    const cell = new InkCell(box.querySelector('canvas'), { own, grid, onChange: kind => onChange(i, kind) });
    box.querySelector('.cell-tools').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b || !cell.enabled) return;
      if (b.dataset.tool) {
        cell.tool = b.dataset.tool;
        for (const x of box.querySelectorAll('[data-tool]')) x.classList.toggle('on', x === b);
      } else if (b.dataset.act === 'undo') cell.undo();
      else if (b.dataset.act === 'clear') cell.clear();
      else if (b.dataset.act === 'wipeS') onChange(i, 'wipeS');
    });
    cells.push(cell);
  }
  layoutCells(container, n);
  new ResizeObserver(() => layoutCells(container, n)).observe(container);
  return cells;
}

// 讓田字格在可用空間裡盡量大，而且保持正方形
function layoutCells(container, n) {
  const W = container.clientWidth, H = container.clientHeight;
  if (!W || !H) return;
  const toolH = 52, gap = 12;
  let best = { cols: n, size: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const size = Math.min((W - gap * (cols - 1)) / cols, (H - rows * toolH - gap * (rows - 1)) / rows);
    if (size > best.size) best = { cols, size };
  }
  container.style.setProperty('--cell', `${Math.max(60, Math.floor(best.size))}px`);
  container.style.gridTemplateColumns = `repeat(${best.cols}, var(--cell))`;
}
