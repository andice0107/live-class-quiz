// 寫國字的部件提示
//
// 部件的形狀不用字型，而是從教育部標準筆劃（g0v/zh-stroke-data）取出那幾筆畫出來；
// 哪幾筆屬於哪個部件，記在共用的「部件筆劃對照表」（hanzi-component-detective/hanzi_parts_strokes.json）。
// 補字規則見那個 repo 的「部件提示原則.md」。

const MAP_URL = 'https://raw.githubusercontent.com/andice0107/hanzi-component-detective/main/hanzi_parts_strokes.json';
const STROKE_URL = hex => `https://raw.githubusercontent.com/g0v/zh-stroke-data/master/json/${hex}.json`;
const HAN = /^[㐀-鿿豈-﫿]$/;

// 用位置命名的部件，形狀其實等於某個有名字的部件；挑干擾部件時要避開，免得出現「看起來一樣」的卡片
const LOOKS_LIKE = { '遙:右上': '夕', '氧:下': '羊', '朗:左': '良', '響:中': '良', '響:左': '乡', '盡:上': '聿', '拋:右上': '九' };

let mapPromise = null;
const strokeCache = new Map();

export function loadPartsMap() {
  if (!mapPromise) {
    mapPromise = fetch(MAP_URL, { cache: 'no-cache' })
      .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
      .catch(err => { mapPromise = null; throw err; });
  }
  return mapPromise;
}

function loadStrokes(ch) {
  if (!strokeCache.has(ch)) {
    const hex = ch.codePointAt(0).toString(16);
    const p = fetch(STROKE_URL(hex))
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null);
    strokeCache.set(ch, p);
  }
  return strokeCache.get(ch);
}

// "1-4" 或 "1,7" → 從 0 起算的筆劃索引
function strokeIdx(spec) {
  const out = [];
  for (const r of String(spec).split(',')) {
    const [a, b] = r.split('-').map(Number);
    for (let i = a; i <= (b || a); i++) out.push(i - 1);
  }
  return out;
}

function strokePath(st) {
  let d = '';
  const n = v => Math.round(v);
  for (const c of st.outline) {
    if (c.type === 'M') d += `M${n(c.x)} ${n(c.y)}`;
    else if (c.type === 'L') d += `L${n(c.x)} ${n(c.y)}`;
    else if (c.type === 'Q') d += `Q${n(c.begin.x)} ${n(c.begin.y)} ${n(c.end.x)} ${n(c.end.y)}`;
    else if (c.type === 'C') d += `C${n(c.begin.x)} ${n(c.begin.y)} ${n(c.mid.x)} ${n(c.mid.y)} ${n(c.end.x)} ${n(c.end.y)}`;
  }
  return d + 'Z';
}

// 一張部件卡：只含那幾筆，放大置中到同樣大小，學生看不出原本的位置和大小
function partCard(strokes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const st of strokes) {
    for (const c of st.outline) {
      for (const p of [c, c.begin, c.mid, c.end]) {
        if (!p || p.x === undefined) continue;
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
      }
    }
  }
  const w = x1 - x0, h = y1 - y0, side = Math.max(w, h) * 1.25;
  const vb = [x0 - (side - w) / 2, y0 - (side - h) / 2, side, side].map(Math.round).join(' ');
  return { vb, d: strokes.map(strokePath).join('') };
}

const shuffle = arr => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

// 挑 2～3 個干擾部件：優先挑「相似部件」同一組的，不能和正確部件同名或同形
function pickDistractors(map, ch, labels) {
  const avoid = new Set(labels.flatMap(l => [l, LOOKS_LIKE[`${ch}:${l}`]]).filter(Boolean));
  const similar = new Set();
  for (const g of map['相似部件'] || []) if (g.some(x => avoid.has(x))) g.forEach(x => similar.add(x));
  const pool = [];
  for (const [c, parts] of Object.entries(map['字'] || {})) {
    if (c === ch) continue;
    // 只有一個部件的字（拆不開的字），筆劃少的才拿來當干擾部件，例如 大、必
    if (parts.length === 1 && strokeIdx(parts[0][1]).length > 5) continue;
    for (const [label, spec] of parts) {
      const look = LOOKS_LIKE[`${c}:${label}`] || label;
      if (avoid.has(label) || avoid.has(look)) continue;
      pool.push({ c, label, spec, look });
    }
  }
  const want = 2 + Math.floor(Math.random() * 2);
  const picked = [];
  const used = new Set();
  const take = list => {
    for (const p of shuffle(list)) {
      if (picked.length >= want) return;
      if (used.has(p.look)) continue;
      used.add(p.look);
      picked.push(p);
    }
  };
  take(pool.filter(p => similar.has(p.look)));
  take(pool);
  return picked;
}

// 一個字（一格）的提示
//   { kind: 'parts', cards: [{vb, d}] }               部件卡（已混入干擾部件、打亂）
//   { kind: 'strokes', count, first: [d, d] | null }  拆不開或對照表沒有的字：筆畫數＋前兩筆
async function charHint(map, ch) {
  const strokes = await loadStrokes(ch);
  if (!strokes || !strokes.length) return null;
  const parts = (map['字'] || {})[ch];
  if (!parts || parts.length < 2) {
    return { kind: 'strokes', count: strokes.length, first: strokes.length > 3 ? strokes.slice(0, 2).map(strokePath) : null };
  }
  const cards = parts.map(([, spec]) => partCard(strokeIdx(spec).map(i => strokes[i]).filter(Boolean)));
  for (const p of pickDistractors(map, ch, parts.map(([l]) => l))) {
    const src = await loadStrokes(p.c);
    if (src) cards.push(partCard(strokeIdx(p.spec).map(i => src[i]).filter(Boolean)));
  }
  return { kind: 'parts', cards: shuffle(cards) };
}

// 寫國字題每一格的提示；注音格和其他題型回傳 null
export async function questionHints(q, cellChars) {
  if (q.type !== 'hanzi') return null;
  const map = await loadPartsMap();
  const out = [];
  for (const ch of cellChars) out.push(HAN.test(ch) ? await charHint(map, ch) : null);
  return out.some(Boolean) ? out : null;
}

// 提示卡的 HTML（老師預覽和學生視窗共用）
export function hintCardsHtml(h, { clickable = false, off = [] } = {}) {
  if (!h) return '';
  if (h.kind === 'strokes') {
    const first = h.first
      ? `<div class="hint-first"><svg viewBox="0 0 2150 2150"><path class="hint-grid" d="M1075 0V2150M0 1075H2150"/>${h.first.map(d => `<path d="${d}"/>`).join('')}</svg><div class="muted">前兩筆</div></div>`
      : '';
    return `<div class="hint-strokes"><div class="hint-count">${h.count} 畫</div>${first}</div>`;
  }
  return `<div class="hint-cards">${h.cards.map((c, i) => {
    const inner = `<svg viewBox="${c.vb}"><path d="${c.d}"/></svg>`;
    return clickable
      ? `<button class="hint-card ${off.includes(i) ? 'off' : ''}" data-card="${i}">${inner}</button>`
      : `<div class="hint-card">${inner}</div>`;
  }).join('')}</div>`;
}
