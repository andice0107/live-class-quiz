// 題庫格式、題型與題目顯示
import { esc, textHtml } from './util.js';
import { defaultCells } from './ink.js';

// input：draw 手寫板、text 打字、choice 點選
// time：預設作答秒數，0 代表無限時
export const TYPES = {
  hanzi:      { label: '寫國字',   input: 'draw',   time: 30 },
  zhuyin:     { label: '寫注音',   input: 'draw',   time: 30 },
  correction: { label: '改錯字',   input: 'draw',   time: 45 },
  choice:     { label: '選擇題',   input: 'choice', time: 45, auto: true },
  word:       { label: '造詞',     input: 'draw',   time: 60 },
  sentence:   { label: '造句',     input: 'text',   time: 180 },
  fill:       { label: '填答',     input: 'text',   time: 60, auto: true },
  write:      { label: '手寫作答', input: 'draw',   time: 60 },
  essay:      { label: '作文',     input: 'text',   time: 0 },
  group:      { label: '題組',     input: null,     time: 300 },
};

const ALIASES = {
  寫國字: 'hanzi', 國字: 'hanzi', 看注音寫國字: 'hanzi',
  寫注音: 'zhuyin', 注音: 'zhuyin', 看國字寫注音: 'zhuyin',
  改錯字: 'correction', 改錯: 'correction',
  選擇: 'choice', 選擇題: 'choice',
  造詞: 'word',
  造句: 'sentence', 照樣造句: 'sentence', 短語造句: 'sentence', 句型造句: 'sentence',
  填充: 'fill', 填充題: 'fill', 填答: 'fill',
  手寫: 'write', 手寫作答: 'write', 計算: 'write',
  作文: 'essay',
  題組: 'group', 閱讀測驗: 'group',
};

const LETTERS = 'ABCDEFGH';

function normType(t) {
  if (!t) return null;
  if (TYPES[t]) return t;
  return ALIASES[String(t).trim()] || null;
}

function normOptions(opts) {
  return (opts || []).map(o => (typeof o === 'string' ? { text: o } : { text: o.text || '', image: o.image || null }));
}

function normChoiceAnswer(ans, options) {
  if (typeof ans === 'number') return ans;
  const s = String(ans ?? '').trim().toUpperCase();
  if (/^[A-H]$/.test(s)) return LETTERS.indexOf(s);
  if (/^[1-8]$/.test(s)) return Number(s) - 1;
  const i = options.findIndex(o => o.text.trim() === String(ans).trim());
  return i;
}

function normQuestion(raw, id, errors, where) {
  const type = normType(raw.type);
  if (!type || type === 'group') {
    errors.push(`${where}：看不懂題型「${raw.type ?? ''}」`);
    return null;
  }
  const q = {
    id,
    type,
    prompt: raw.prompt ?? raw.question ?? '',
    images: raw.images || (raw.image ? [raw.image] : []),
    answer: raw.answer ?? '',
  };
  const exp = raw.explanation ?? raw.詳解 ?? raw.解析 ?? raw.analysis;
  if (exp) q.explanation = String(exp);
  if (raw.cells) q.cells = Number(raw.cells);
  if (raw.time !== undefined && raw.time !== null && raw.time !== '') q.time = Number(raw.time);
  if (type === 'choice') {
    q.options = normOptions(raw.options);
    q.answer = normChoiceAnswer(raw.answer, q.options);
    if (q.options.length < 2) errors.push(`${where}：選擇題至少要有兩個選項`);
    if (q.answer < 0 || q.answer >= q.options.length) errors.push(`${where}：選擇題的答案對不上選項`);
  }
  return q;
}

// 把一份題庫檔整理成統一格式
export function normalizeBank(raw, fileTag = 'bank') {
  const errors = [];
  const items = [];
  const list = Array.isArray(raw) ? raw : raw.items || raw.questions || [];
  list.forEach((r, i) => {
    const id = String(r.id || `${fileTag}-${i + 1}`);
    const where = `第 ${i + 1} 題`;
    if (normType(r.type) === 'group' || Array.isArray(r.questions)) {
      const subs = (r.questions || []).map((s, j) => normQuestion(s, `${id}-${j + 1}`, errors, `${where}第 ${j + 1} 小題`)).filter(Boolean);
      if (!subs.length) { errors.push(`${where}：題組裡沒有小題`); return; }
      const g = { id, type: 'group', title: r.title || '', passage: r.passage || r.prompt || '', images: r.images || (r.image ? [r.image] : []), subs };
      if (r.time !== undefined && r.time !== null && r.time !== '') g.time = Number(r.time);
      items.push(g);
    } else {
      const q = normQuestion(r, id, errors, where);
      if (q) items.push(q);
    }
  });
  return { title: raw.title || fileTag, subject: raw.subject || '', items, errors };
}

export async function readBankFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  const tag = file.name.replace(/\.[^.]+$/, '');
  if (ext === 'docx') {
    const { readDocxBank } = await import('./docx-import.js');
    const raw = await readDocxBank(file);
    const bank = normalizeBank(raw, tag);
    bank.errors = raw.errors.concat(bank.errors);
    return bank;
  }
  if (ext === 'doc' || ext === 'pdf') {
    throw new Error(`「${file.name}」是 ${ext.toUpperCase()} 檔，工具沒辦法直接讀。請把它傳給 Claude 轉成題庫檔；如果是照「Word 題庫範本」寫的，請在 Word 裡「另存新檔」成 .docx 再載入。`);
  }
  const text = await file.text();
  let raw;
  try { raw = JSON.parse(text); } catch { throw new Error(`「${file.name}」不是題庫檔（可以載入 .json 題庫檔，或照「Word 題庫範本」寫的 .docx）`); }
  return normalizeBank(raw, tag);
}

// 給學生看的版本：拿掉答案
export function publicQuestion(q) {
  // 格數要在拿掉答案前算好（例如寫國字依答案字數決定格數）
  if (TYPES[q.type].input === 'draw' && !q.cells && q.type !== 'word') q = { ...q, cells: defaultCells(q) };
  const { answer, explanation, ...rest } = q;
  return rest;
}

export function publicItem(item) {
  if (item.type !== 'group') return publicQuestion(item);
  return { ...item, subs: item.subs.map(publicQuestion) };
}

export function answerText(q) {
  if (q.type === 'choice') {
    const o = q.options[q.answer];
    return `${LETTERS[q.answer]}${o && o.text ? '. ' + o.text : ''}`;
  }
  return String(q.answer ?? '');
}

// 自動批改：true／false；需要老師判斷時回傳 undefined
export function autoGrade(q, ans) {
  const empty = !ans || ans.v === undefined || ans.v === null || ans.v === '';
  if (q.type === 'choice') return !!(ans && ans.submitted && ans.v === q.answer);
  if (empty) return false;
  if (q.type === 'fill') {
    const norm = s => String(s).replace(/\s+/g, '').toLowerCase();
    const accepted = String(q.answer).split(/[|｜]/).map(norm).filter(Boolean);
    return accepted.includes(norm(ans.v)) ? true : undefined;
  }
  return undefined;
}

function imagesHtml(images) {
  if (!images || !images.length) return '';
  return `<div class="q-images">${images.map(src => `<img class="q-img" src="${esc(src)}" alt="題目圖片">`).join('')}</div>`;
}

export function optionsHtml(q, { selected = null, correct = null, clickable = false } = {}) {
  return `<div class="options">${q.options.map((o, i) => {
    const cls = ['option'];
    if (selected === i) cls.push('selected');
    if (correct === i) cls.push('correct');
    const inner = `<span class="opt-letter">${LETTERS[i]}</span><span class="opt-body">${o.image ? `<img class="q-img" src="${esc(o.image)}" alt="">` : ''}${textHtml(o.text)}</span>`;
    return clickable
      ? `<button class="${cls.join(' ')}" data-opt="${i}">${inner}</button>`
      : `<div class="${cls.join(' ')}">${inner}</div>`;
  }).join('')}</div>`;
}

// 單題內容（題型標籤、題目、圖片）
export function questionHtml(q, { label = '' } = {}) {
  const t = TYPES[q.type];
  return `<div class="q-head"><span class="badge">${label ? esc(label) + '．' : ''}${t ? t.label : ''}</span></div>
    <div class="q-prompt">${textHtml(q.prompt)}</div>${imagesHtml(q.images)}`;
}

export function passageHtml(g) {
  return `${g.title ? `<div class="passage-title">${esc(g.title)}</div>` : ''}
    <div class="passage">${textHtml(g.passage)}</div>${imagesHtml(g.images)}`;
}

export function letter(i) { return LETTERS[i] ?? '?'; }
