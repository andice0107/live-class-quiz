// 手寫板：手指或觸控筆都可以寫，支援復原與清除
export class Pad {
  constructor(canvas, { onChange, ink = '#f3efe4', guide = true } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.strokes = [];
    this.current = null;
    this.ink = ink;
    this.guide = guide;
    this.enabled = true;
    this.onChange = onChange || (() => {});
    this.resize = this.resize.bind(this);
    new ResizeObserver(this.resize).observe(canvas);
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', e => this.down(e));
    canvas.addEventListener('pointermove', e => this.move(e));
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) canvas.addEventListener(ev, e => this.up(e));
    this.resize();
  }

  // 筆畫用 0~1 的相對座標記錄，畫面大小改變也不會跑掉
  point(e) {
    const r = this.canvas.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  }

  down(e) {
    if (!this.enabled) return;
    e.preventDefault();
    this.canvas.setPointerCapture?.(e.pointerId);
    this.current = [this.point(e)];
    this.strokes.push(this.current);
    this.redraw();
  }

  move(e) {
    if (!this.current) return;
    e.preventDefault();
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ce of evs) this.current.push(this.point(ce));
    this.redraw();
  }

  up() {
    if (!this.current) return;
    this.current = null;
    this.onChange();
  }

  undo() { this.strokes.pop(); this.redraw(); this.onChange(); }
  clear() { this.strokes = []; this.redraw(); this.onChange(); }
  isEmpty() { return this.strokes.length === 0; }
  setEnabled(on) { this.enabled = on; this.canvas.classList.toggle('locked', !on); }
  load(strokes) { this.strokes = strokes ? JSON.parse(JSON.stringify(strokes)) : []; this.redraw(); }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.redraw();
  }

  redraw() {
    paint(this.ctx, this.canvas.width, this.canvas.height, this.strokes, { ink: this.ink, guide: this.guide, bg: null });
  }

  // 縮小成圖片，傳給老師端的縮圖
  toImage(maxW = 300) {
    const r = this.canvas.getBoundingClientRect();
    const w = Math.min(maxW, Math.round(r.width));
    const h = Math.max(1, Math.round(w * r.height / Math.max(1, r.width)));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    paint(c.getContext('2d'), w, h, this.strokes, { ink: this.ink, guide: false, bg: '#1f242b' });
    return c.toDataURL('image/jpeg', 0.55);
  }
}

function paint(ctx, w, h, strokes, { ink, guide, bg }) {
  ctx.clearRect(0, 0, w, h);
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h); }
  if (guide) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.setLineDash([8, 10]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2);
    ctx.stroke();
    ctx.restore();
  }
  const lw = Math.max(3, Math.min(w, h) * 0.022);
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = lw;
  for (const s of strokes) {
    if (s.length === 1) {
      ctx.beginPath();
      ctx.arc(s[0][0] * w, s[0][1] * h, lw / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(s[0][0] * w, s[0][1] * h);
    for (let i = 1; i < s.length - 1; i++) {
      const mx = (s[i][0] + s[i + 1][0]) / 2, my = (s[i][1] + s[i + 1][1]) / 2;
      ctx.quadraticCurveTo(s[i][0] * w, s[i][1] * h, mx * w, my * h);
    }
    const last = s[s.length - 1];
    ctx.lineTo(last[0] * w, last[1] * h);
    ctx.stroke();
  }
}
