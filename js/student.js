import { openDb } from './db.js';
import { TYPES, questionHtml, passageHtml, optionsHtml, letter } from './bank.js';
import { $, esc, textHtml, sha256, fmtTime, throttle, ID_PATTERN, stripNonAlnum, enableImageZoom } from './util.js';
import { buildCells, defaultCells, useGrid, paintInkThumb, cellData, guideChars, ensureKai } from './ink.js';
import { applyTheme } from './theme.js';

const app = $('#app');
const room = new URLSearchParams(location.search).get('r');
const JOIN_KEY = 'lcq-join';

const S = {
  db: null,
  sid: null,
  cur: null,          // 老師目前的題目狀態
  drafts: {},         // qkey -> {v, submitted, n, cells:[{s,t,seen}]}
  sub: 0,             // 題組目前做到第幾小題
  viewSig: '',
  cells: null,        // 目前畫面上的田字格
  inkUnsub: null,
  pen: null,          // 老師的作答開關
  score: null,
  theme: null,
};

// ---------- 加入 ----------

function renderJoin(msg = '') {
  app.className = 's-app center';
  app.innerHTML = `<form id="joinForm" class="join-form">
    <h1>加入作答</h1>
    <label>認證碼<input id="code" type="text" inputmode="numeric" autocomplete="off" maxlength="4" placeholder="看老師的畫面"></label>
    <label>你的代號（英文或數字）<input id="sid" type="text" inputmode="latin" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="12" placeholder="例如 A01"></label>
    <div class="err">${esc(msg)}</div>
    <button class="primary big" type="submit">加入</button>
  </form>`;
  const sidIn = $('#sid');
  // 擋掉中文和符號
  const clean = () => { const v = stripNonAlnum(sidIn.value); if (v !== sidIn.value) sidIn.value = v; };
  sidIn.addEventListener('input', e => { if (!e.isComposing) clean(); });
  sidIn.addEventListener('compositionend', clean);
  $('#code').addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 4); });
  $('#joinForm').addEventListener('submit', async e => {
    e.preventDefault();
    clean();
    const code = $('#code').value.trim();
    const sid = sidIn.value.trim();
    if (!ID_PATTERN.test(sid)) return renderJoin('代號只能用英文字母或數字。');
    const meta = await S.db.get(`rooms/${room}/meta`);
    if (!meta) return renderJoin('找不到這個教室，請重新掃描 QR code。');
    if (await sha256(meta.salt + code) !== meta.codeHash) return renderJoin('認證碼不對，請再看一次老師的畫面。');
    const existing = await S.db.get(`rooms/${room}/students/${sid}`);
    if (existing && existing.online !== false && S.db.mode === 'firebase') return renderJoin('這個代號已經有人在用了，請換一個。');
    await join(sid, existing);
  });
}

async function join(sid, existing) {
  S.sid = sid;
  sessionStorage.setItem(JOIN_KEY, JSON.stringify({ room, sid }));
  const P = `rooms/${room}/students/${sid}`;
  const joinedAt = existing?.joinedAt || S.db.now();
  S.db.onConnected(async ok => {
    if (!ok) return;
    await S.db.set(P, { joinedAt, online: true });
    S.db.onDisconnectSet(`${P}/online`, false);
  });
  S.db.on(`rooms/${room}/current`, v => { S.cur = v; render(); });
  S.db.on(`rooms/${room}/scores/${sid}`, v => { S.score = v; if (S.cur?.phase === 'finished') render(true); });
  S.db.on(`rooms/${room}/pen`, v => { S.pen = v; updateSendState(); });
  S.db.on(`rooms/${room}/meta`, v => {
    if (!v) { S.cur = { phase: 'closed' }; render(true); return; }
    if (v.theme && v.theme !== S.theme) { S.theme = v.theme; applyTheme(v.theme); render(true); }
  });
}

// ---------- 畫面 ----------

function penAllowed() {
  const p = S.pen || {};
  const mine = p.by ? p.by[S.sid] : undefined;
  return mine ?? p.all ?? true;
}

function timeUp() {
  const c = S.cur;
  if (!c || c.phase !== 'answering') return true;
  return !!(c.endsAt && S.db.now() >= c.endsAt);
}
const locked = () => timeUp() || !penAllowed();

function render(force = false) {
  const c = S.cur;
  const phase = c?.phase || 'waiting';
  const sig = `${phase}|${c?.round}|${(c?.keys || []).join(',')}|${phase === 'answering' ? S.sub : ''}|${phase === 'revealed' ? c.guide !== false : ''}`;
  if (!force && sig === S.viewSig) { tick(); return; }
  S.viewSig = sig;
  if (S.inkUnsub) { S.inkUnsub(); S.inkUnsub = null; }
  S.cells = null;
  if (phase === 'answering') renderQuestion();
  else if (phase === 'revealed') renderReveal();
  else if (phase === 'finished') renderFinal();
  else if (phase === 'closed') renderMessage('老師已經關閉這個教室。');
  else renderMessage('等老師出題…');
}

function header() {
  const c = S.cur;
  return `<header class="s-top"><span class="who">${esc(S.sid)}</span>
    <span class="prog">${c && c.no ? `第 ${c.no} / ${c.total} 題` : ''}</span>
    <span id="sTimer" class="s-timer"></span></header>`;
}

function renderMessage(msg) {
  app.className = 's-app';
  app.innerHTML = `${header()}<main class="s-msg"><div>${esc(msg)}</div></main>`;
}

function keys() { return S.cur.keys || []; }
function curQ() {
  const q = S.cur.q;
  if (q.type === 'group') return { q: q.subs[S.sub], key: keys()[S.sub], group: q };
  return { q, key: keys()[0], group: null };
}

function draft(key, q) {
  if (!S.drafts[key]) {
    const n = q ? defaultCells(q) : 1;
    S.drafts[key] = { v: null, submitted: false, n, cells: Array.from({ length: n }, () => ({ s: [], t: [], seen: 0 })) };
  }
  return S.drafts[key];
}

function renderQuestion() {
  // 新的一題：題組從第一小題開始
  if (S.lastKeys !== keys().join(',')) { S.lastKeys = keys().join(','); S.sub = 0; }
  const { q, key, group } = curQ();
  const d = draft(key, q);
  const input = TYPES[q.type].input;
  const subNav = group ? `<div class="sub-nav">
      <button id="prevSub" ${S.sub === 0 ? 'disabled' : ''}>◀ 上一小題</button>
      <span>第 ${S.sub + 1} / ${group.subs.length} 小題</span>
      <button id="nextSub" ${S.sub + 1 >= group.subs.length || !d.submitted ? 'disabled' : ''}>下一小題 ▶</button></div>` : '';
  let answerArea = '';
  if (input === 'draw') {
    const chooser = q.type === 'word' && !q.cells
      ? `<div class="cell-count"><span>這個詞有幾個字？</span>${[2, 3, 4].map(n => `<button data-n="${n}" class="${d.n === n ? 'on' : ''}">${n} 格</button>`).join('')}</div>` : '';
    answerArea = `<div class="draw-area">${chooser}<div id="cells"></div></div>`;
  } else if (input === 'text') {
    answerArea = `<textarea id="txt" class="s-text" placeholder="在這裡打字作答">${esc(d.v || '')}</textarea>`;
  } else {
    answerArea = `<div class="s-options">${optionsHtml(q, { selected: d.v, clickable: true })}</div>`;
  }
  const sendLabel = input === 'choice' ? '確認送出' : '送出';
  app.className = `s-app answering ${group ? 'is-group' : ''} input-${input}`;
  app.innerHTML = `${header()}
    <section class="s-question">
      ${group ? `<details class="s-passage" open><summary>題組文章（點一下收合）</summary>${passageHtml(group)}</details>` : ''}
      ${questionHtml(q, { label: group ? `第 ${S.sub + 1} 小題` : '' })}
    </section>
    <section class="s-answer">${answerArea}</section>
    <div id="penOff" class="pen-off hidden">老師暫停了作答，請看老師的說明</div>
    <footer class="s-actions">${subNav}<span class="spacer"></span><span id="sendState" class="send-state"></span>
      <button id="sendBtn" class="primary big">${sendLabel}</button></footer>`;
  bindQuestion(q, key, input);
  updateSendState();
  tick();
}

// 每一小題各自節流，切換小題時才不會漏送
const pushers = {};
function pushAnswer(key, d) {
  // 按下送出時立刻傳，不等節流
  if (d.submitted) {
    S.db.set(`rooms/${room}/answers/${key}/${S.sid}`, { v: d.v, submitted: true, at: S.db.now() });
    return;
  }
  const f = pushers[key] || (pushers[key] = throttle((k, dd) => {
    S.db.set(`rooms/${room}/answers/${k}/${S.sid}`, { v: dd.v, submitted: dd.submitted, at: S.db.now() });
  }, 500));
  f(key, d);
}
function pushCell(key, i, strokes) {
  const id = `${key}/${i}`;
  const f = pushers[id] || (pushers[id] = throttle((k, j, st) => {
    S.db.set(`rooms/${room}/ink/${k}/${S.sid}/c/${j}/s`, st.length ? st : null);
  }, 250));
  f(key, i, strokes);
}

function bindQuestion(q, key, input) {
  const d = draft(key, q);
  const changed = () => { d.submitted = false; pushAnswer(key, d); updateSendState(); };
  if (input === 'draw') {
    const container = $('#cells');
    const build = () => {
      S.cells = buildCells(container, d.n, {
        own: 's', grid: useGrid(q),
        onChange: (i, kind) => {
          d.cells[i].s = S.cells[i].s;
          pushCell(key, i, d.cells[i].s);
          if (kind === 'end') {
            d.v = d.cells.some(c => c.s.length) ? d.n : null;
            changed();
          }
        },
      });
      S.cells.forEach((c, i) => { c.s = d.cells[i].s; c.t = d.cells[i].t; c.redraw(); });
      S.db.set(`rooms/${room}/ink/${key}/${S.sid}/n`, d.n);
      updateSendState();
    };
    build();
    // 老師的紅筆，以及老師要求清掉學生筆劃
    S.inkUnsub = S.db.on(`rooms/${room}/ink/${key}/${S.sid}/c`, v => {
      const list = Array.isArray(v) ? v : v ? Object.values(v) : [];
      for (let i = 0; i < d.n; i++) {
        const raw = (Array.isArray(v) ? v[i] : v && v[i]) || null;
        const cd = cellData(raw);
        d.cells[i].t = cd.t;
        if (S.cells && S.cells[i]) S.cells[i].setOther(cd.t);
        const clr = raw && raw.clearS;
        if (clr && clr > (d.cells[i].seen || 0)) {
          d.cells[i].seen = clr;
          d.cells[i].s = [];
          if (S.cells && S.cells[i]) S.cells[i].wipeMine();
        }
      }
      void list;
    });
    const chooser = $('.cell-count');
    if (chooser) chooser.addEventListener('click', e => {
      const b = e.target.closest('[data-n]');
      if (!b || locked()) return;
      const n = Number(b.dataset.n);
      if (n === d.n) return;
      const lost = d.cells.slice(n).some(c => c.s.length);
      if (lost && !confirm('格子變少，最後面那幾格寫的字會被刪掉，確定嗎？')) return;
      while (d.cells.length < n) d.cells.push({ s: [], t: [], seen: 0 });
      for (let i = n; i < d.cells.length; i++) pushCell(key, i, []);
      d.cells = d.cells.slice(0, n);
      d.n = n;
      for (const x of chooser.querySelectorAll('[data-n]')) x.classList.toggle('on', Number(x.dataset.n) === n);
      build();
      d.v = d.cells.some(c => c.s.length) ? d.n : null;
      changed();
    });
  } else if (input === 'text') {
    $('#txt').addEventListener('input', e => { d.v = e.target.value; changed(); });
  } else {
    $('.s-options').addEventListener('click', e => {
      const b = e.target.closest('[data-opt]');
      if (!b || locked()) return;
      d.v = Number(b.dataset.opt);
      for (const o of app.querySelectorAll('.option')) o.classList.toggle('selected', Number(o.dataset.opt) === d.v);
      changed();
    });
  }
  $('#sendBtn').onclick = () => {
    if (locked() || d.v === null || d.v === '') return;
    d.submitted = true;
    pushAnswer(key, d);
    updateSendState();
    const nb = $('#nextSub');
    if (nb && S.sub + 1 < S.cur.q.subs.length) nb.disabled = false;
  };
  const prev = $('#prevSub'), next = $('#nextSub');
  if (prev) prev.onclick = () => { S.sub--; render(true); };
  if (next) next.onclick = () => { S.sub++; render(true); };
  // 讓老師知道目前在第幾小題
  S.db.set(`rooms/${room}/live/${S.sid}`, { qkey: key, at: S.db.now() });
}

function updateSendState() {
  if (S.cur?.phase !== 'answering') return;
  const st = $('#sendState');
  if (!st) return;
  const { key, q } = curQ();
  const d = draft(key, q);
  const btn = $('#sendBtn');
  const up = timeUp();
  const pen = penAllowed();
  const lock = up || !pen;
  st.textContent = up ? '時間到，不能再作答' : !pen ? '暫停作答' : d.submitted ? '✓ 已送出（還可以修改）' : (d.v === null || d.v === '' ? '' : '還沒送出');
  st.className = 'send-state' + (d.submitted ? ' ok' : '');
  btn.disabled = lock || d.v === null || d.v === '';
  $('#penOff').classList.toggle('hidden', pen || up);
  if (S.cells) for (const c of S.cells) c.setEnabled(!lock);
  app.classList.toggle('pen-locked', lock);
  const t = $('#txt');
  if (t) t.disabled = lock;
}

function tick() {
  const el = $('#sTimer');
  const c = S.cur;
  if (!el || !c) return;
  if (c.phase !== 'answering') { el.textContent = ''; return; }
  if (!c.endsAt) { el.textContent = '不限時'; el.className = 's-timer'; return; }
  const left = (c.endsAt - S.db.now()) / 1000;
  el.textContent = fmtTime(left);
  el.className = 's-timer' + (left <= 10 ? ' urgent' : '');
  updateSendState();
}
setInterval(tick, 250);

function revealOf(key) {
  const r = S.cur.reveal?.[key];
  return typeof r === 'string' ? { a: r } : (r || {});
}

function myAnswerHtml(q, key) {
  const d = S.drafts[key];
  const input = TYPES[q.type].input;
  if (input === 'draw') {
    const blank = !d || !d.cells.some(c => c.s.length || c.t.length);
    if (blank && !guideChars(q.type, revealOf(key).a).length) return '<span class="muted">（沒有作答）</span>';
    return `${blank ? '<span class="muted">（沒有作答）</span>' : ''}<canvas class="my-ink" data-key="${esc(key)}" data-type="${q.type}"></canvas>`;
  }
  if (!d || d.v === null || d.v === '' || d.v === undefined) return '<span class="muted">（沒有作答）</span>';
  if (input === 'choice') return `<b>${letter(d.v)}</b>${d.submitted ? '' : '（沒有按確認）'}`;
  return textHtml(d.v);
}

function revealBlock(q, key, label) {
  const { a = '', e = '' } = revealOf(key);
  const input = TYPES[q.type].input;
  const d = S.drafts[key];
  return `<div class="reveal-q ${e ? 'has-exp' : ''}">
    ${questionHtml(q, { label })}
    ${q.type === 'choice' ? optionsHtml(q, { selected: d && d.submitted ? d.v : null }) : ''}
    <div class="reveal-label">正確答案</div>
    <div class="${input === 'draw' && [...a].length <= 6 ? 'answer-big' : 'answer-mid'}">${textHtml(a)}</div>
    ${e ? `<div class="explain"><div class="reveal-label">詳解</div>${textHtml(e)}</div>` : ''}
    <div class="mine ${input === 'draw' ? 'mine-draw' : ''}"><span class="muted">你的答案：</span>${myAnswerHtml(q, key)}</div></div>`;
}

function renderReveal() {
  const q = S.cur.q;
  const ks = keys();
  let body;
  if (q.type === 'group') {
    body = `<details class="s-passage"><summary>題組文章</summary>${passageHtml(q)}</details>` +
      q.subs.map((sq, j) => revealBlock(sq, ks[j], `第 ${j + 1} 小題`)).join('');
  } else body = revealBlock(q, ks[0], '');
  app.className = 's-app revealed';
  app.innerHTML = `${header()}<main class="s-reveal">${body}</main>`;
  const subs = q.type === 'group' ? q.subs : [q];
  const blocks = app.querySelectorAll('.reveal-q');
  subs.forEach((sq, j) => { if (sq.type === 'choice') markChoice(blocks[j], ks[j]); });
  const paintMine = () => {
    for (const cv of app.querySelectorAll('canvas.my-ink')) {
      const d = S.drafts[cv.dataset.key];
      const guides = S.cur.guide !== false ? guideChars(cv.dataset.type, revealOf(cv.dataset.key).a) : null;
      paintInkThumb(cv, d ? { n: d.n, c: d.cells } : { n: guides.length, c: [] }, { grid: cv.dataset.type !== 'write', guides });
    }
  };
  paintMine();
  const all = ks.flatMap((k, j) => guideChars((q.type === 'group' ? q.subs[j] : q).type, revealOf(k).a));
  if (all.length) ensureKai(all).then(paintMine);
}

function markChoice(root, key) {
  const ans = revealOf(key).a || '';
  const i = 'ABCDEFGH'.indexOf(ans[0]);
  const opts = root.querySelectorAll('.option');
  if (opts[i]) opts[i].classList.add('correct');
}

function renderFinal() {
  const s = S.score;
  app.className = 's-app';
  app.innerHTML = `${header()}<main class="s-final">
    ${s ? `<div class="muted">這次的分數</div><div class="final-score">${s.score}</div><div class="final-detail">答對 ${s.correct} / ${s.total} 題</div>`
        : '<div>老師正在計算分數…</div>'}</main>`;
}

async function init() {
  if (!room) {
    app.className = 's-app center';
    app.innerHTML = '<div class="s-msg">請用平板掃描老師畫面上的 QR code。</div>';
    return;
  }
  S.db = await openDb();
  enableImageZoom(document.body);
  const saved = JSON.parse(sessionStorage.getItem(JOIN_KEY) || 'null');
  if (saved && saved.room === room && await S.db.get(`rooms/${room}/meta`)) {
    const existing = await S.db.get(`rooms/${room}/students/${saved.sid}`);
    if (existing) return join(saved.sid, existing);
  }
  renderJoin();
}

init();
