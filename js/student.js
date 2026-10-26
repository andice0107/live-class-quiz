import { openDb } from './db.js';
import { TYPES, questionHtml, passageHtml, optionsHtml, letter } from './bank.js';
import { $, esc, textHtml, sha256, fmtTime, throttle, ID_PATTERN, stripNonAlnum, enableImageZoom } from './util.js';
import { Pad } from './pad.js';

const app = $('#app');
const room = new URLSearchParams(location.search).get('r');
const JOIN_KEY = 'lcq-join';

const S = {
  db: null,
  sid: null,
  cur: null,          // 老師目前的題目狀態
  drafts: {},         // qkey -> {v, submitted, strokes}
  sub: 0,             // 題組目前做到第幾小題
  viewSig: '',
  pad: null,
  score: null,
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
  S.db.on(`rooms/${room}/meta`, v => { if (!v) { S.cur = { phase: 'closed' }; render(true); } });
}

// ---------- 畫面 ----------

function locked() {
  const c = S.cur;
  if (!c || c.phase !== 'answering') return true;
  return !!(c.endsAt && S.db.now() >= c.endsAt);
}

function render(force = false) {
  const c = S.cur;
  const phase = c?.phase || 'waiting';
  const sig = `${phase}|${c?.round}|${(c?.keys || []).join(',')}|${phase === 'answering' ? S.sub : ''}`;
  if (!force && sig === S.viewSig) { tick(); return; }
  S.viewSig = sig;
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
  S.pad = null;
  app.className = 's-app';
  app.innerHTML = `${header()}<main class="s-msg"><div>${esc(msg)}</div></main>`;
}

function keys() { return S.cur.keys || []; }
function curQ() {
  const q = S.cur.q;
  if (q.type === 'group') return { q: q.subs[S.sub], key: keys()[S.sub], group: q };
  return { q, key: keys()[0], group: null };
}

function draft(key) { return S.drafts[key] || (S.drafts[key] = { v: null, submitted: false, strokes: [] }); }

function renderQuestion() {
  const c = S.cur;
  // 新的一題：題組從第一小題開始
  if (S.lastKeys !== keys().join(',')) { S.lastKeys = keys().join(','); S.sub = 0; }
  const { q, key, group } = curQ();
  const d = draft(key);
  const input = TYPES[q.type].input;
  const subNav = group ? `<div class="sub-nav">
      <button id="prevSub" ${S.sub === 0 ? 'disabled' : ''}>◀ 上一小題</button>
      <span>第 ${S.sub + 1} / ${group.subs.length} 小題</span>
      <button id="nextSub" ${S.sub + 1 >= group.subs.length || !d.submitted ? 'disabled' : ''}>下一小題 ▶</button></div>` : '';
  let answerArea = '';
  if (input === 'draw') {
    answerArea = `<div class="pad-wrap"><canvas id="pad" class="pad"></canvas></div>`;
  } else if (input === 'text') {
    answerArea = `<textarea id="txt" class="s-text" placeholder="在這裡打字作答">${esc(d.v || '')}</textarea>`;
  } else {
    answerArea = `<div class="s-options">${optionsHtml(q, { selected: d.v, clickable: true })}</div>`;
  }
  const tools = input === 'draw' ? `<button id="undoBtn">↶ 復原</button><button id="clearBtn">清除</button>` : '';
  const sendLabel = input === 'choice' ? '確認送出' : '送出';
  app.className = `s-app answering ${group ? 'is-group' : ''} input-${input}`;
  app.innerHTML = `${header()}
    <section class="s-question">
      ${group ? `<details class="s-passage" open><summary>題組文章（點一下收合）</summary>${passageHtml(group)}</details>` : ''}
      ${questionHtml(q, { label: group ? `第 ${S.sub + 1} 小題` : '' })}
    </section>
    <section class="s-answer">${answerArea}</section>
    <footer class="s-actions">${tools}${subNav}<span class="spacer"></span><span id="sendState" class="send-state"></span>
      <button id="sendBtn" class="primary big">${sendLabel}</button></footer>`;
  bindQuestion(q, key, input);
  updateSendState();
  tick();
}

// 每一小題各自節流，切換小題時才不會漏送
const pushers = {};
function pushDraft(key, d) {
  const f = pushers[key] || (pushers[key] = throttle((k, dd) => {
    S.db.set(`rooms/${room}/answers/${k}/${S.sid}`, { v: dd.v, submitted: dd.submitted, at: S.db.now() });
  }, 600));
  f(key, d);
}

function bindQuestion(q, key, input) {
  const d = draft(key);
  const changed = () => { d.submitted = false; pushDraft(key, d); updateSendState(); };
  if (input === 'draw') {
    S.pad = new Pad($('#pad'), {
      onChange: () => {
        d.strokes = S.pad.strokes;
        d.v = S.pad.isEmpty() ? null : S.pad.toImage();
        changed();
      },
    });
    S.pad.load(d.strokes);
    $('#undoBtn').onclick = () => !locked() && S.pad.undo();
    $('#clearBtn').onclick = () => !locked() && S.pad.clear();
  } else if (input === 'text') {
    S.pad = null;
    $('#txt').addEventListener('input', e => { d.v = e.target.value; changed(); });
  } else {
    S.pad = null;
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
    pushDraft(key, d);
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
  const { key } = curQ();
  const d = draft(key);
  const st = $('#sendState');
  const btn = $('#sendBtn');
  if (!st) return;
  const lock = locked();
  st.textContent = lock ? '時間到，不能再作答' : d.submitted ? '✓ 已送出（還可以修改）' : (d.v === null || d.v === '' ? '' : '還沒送出');
  st.className = 'send-state' + (d.submitted ? ' ok' : '');
  btn.disabled = lock || d.v === null || d.v === '';
  if (S.pad) S.pad.setEnabled(!lock);
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

function myAnswerHtml(q, key) {
  const d = S.drafts[key];
  const input = TYPES[q.type].input;
  if (!d || d.v === null || d.v === '' || d.v === undefined) return '<span class="muted">（沒有作答）</span>';
  if (input === 'draw') return `<img class="my-img" src="${d.v}" alt="">`;
  if (input === 'choice') return `<b>${letter(d.v)}</b>${d.submitted ? '' : '（沒有按確認）'}`;
  return textHtml(d.v);
}

function revealBlock(q, key, label) {
  const ans = S.cur.reveal?.[key] ?? '';
  const input = TYPES[q.type].input;
  const d = S.drafts[key];
  return `<div class="reveal-q">
    ${questionHtml(q, { label })}
    ${q.type === 'choice' ? optionsHtml(q, { selected: d && d.submitted ? d.v : null }) : ''}
    <div class="reveal-label">正確答案</div>
    <div class="${input === 'draw' ? 'answer-big' : 'answer-mid'}">${textHtml(ans)}</div>
    <div class="mine"><span class="muted">你的答案：</span>${myAnswerHtml(q, key)}</div></div>`;
}

function renderReveal() {
  S.pad = null;
  const q = S.cur.q;
  const ks = keys();
  let body;
  if (q.type === 'group') {
    body = `<details class="s-passage"><summary>題組文章</summary>${passageHtml(q)}</details>` +
      q.subs.map((sq, j) => revealBlock(sq, ks[j], `第 ${j + 1} 小題`)).join('');
  } else body = revealBlock(q, ks[0], '');
  app.className = 's-app revealed';
  app.innerHTML = `${header()}<main class="s-reveal">${body}</main>`;
  // 選擇題的正確選項標出來
  if (q.type !== 'group' && q.type === 'choice') markChoice(app, q, ks[0]);
  if (q.type === 'group') q.subs.forEach((sq, j) => sq.type === 'choice' && markChoice(app.querySelectorAll('.reveal-q')[j], sq, ks[j]));
}

function markChoice(root, q, key) {
  const ans = S.cur.reveal?.[key] || '';
  const i = 'ABCDEFGH'.indexOf(ans[0]);
  const opts = root.querySelectorAll('.option');
  if (opts[i]) opts[i].classList.add('correct');
}

function renderFinal() {
  S.pad = null;
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
