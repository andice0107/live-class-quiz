import { openDb } from './db.js';
import { TYPES, readBankFile, normalizeBank, publicItem, answerText, autoGrade, questionHtml, passageHtml, optionsHtml, letter } from './bank.js';
import { $, $$, esc, textHtml, randomString, shuffle, sha256, fmtTime, showModal, enableImageZoom } from './util.js';
import { renderSummary, computeScores, showQuestion, credit, fmtNum, partLabel } from './report.js';
import { buildCells, defaultCells, useGrid, paintInkThumb, cellData, guideChars, ensureKai } from './ink.js';
import { THEMES, applyTheme, saveTheme } from './theme.js';
import { questionHints, hintCardsHtml } from './hints.js';
import { radicalOf } from './radicals.js';

const USED_KEY = 'lcq-used';
const FS_KEY = 'lcq-font-scale';
const VOICE_KEY = 'lcq-voice';

const S = {
  db: null,
  banks: [],            // 載入的題庫
  items: [],            // 合併後的所有題目（單題或題組）
  used: new Set(JSON.parse(sessionStorage.getItem(USED_KEY) || '[]')),
  room: null,
  code: null,
  joinUrl: '',
  students: {},         // sid -> {id, joinedAt, online}
  live: {},             // sid -> {qkey, sub, at}
  answers: {},          // qkey -> sid -> {v, submitted, at}
  ink: {},              // qkey -> sid -> {n, c:[{s,t,clearS}]}
  pen: { all: true, by: {} },  // 學生作答（畫筆）開關
  guide: true,          // 公布答案後，田字格裡顯示半透明範字
  hintOn: false,        // 這一題是否開放部件提示
  hintPrep: null,       // 準備部件提示中（Promise）
  hintUsed: {},         // qkey -> sid -> 第一次看提示的時間
  radicalOn: false,     // 這一題是否開放改錯字的部首意義提示
  scoreOpen: false,     // 即時成績面板是否展開
  // 文字縮放：q 題目、a 答案、s 學生作答（1 = 自動調到剛好放得下）
  fs: { q: 1, a: 1, s: 1, ...JSON.parse(localStorage.getItem(FS_KEY) || '{}') },
  collab: null,         // 正在協助的學生手寫板
  theme: 'dark',        // 每次打開都從護眼模式開始
  unsub: [],
  rounds: [],
  round: null,
  masks: {},
  defaultMask: false,
  subTab: 'follow',     // 題組時老師看哪一小題：follow = 各自進度
  showAnswer: false,
};

// ---------- 題庫 ----------

function rebuildItems() {
  const seen = new Set();
  S.items = [];
  for (const b of S.banks) {
    for (const it of b.items) {
      let id = it.id;
      while (seen.has(id)) id += '*';
      seen.add(id);
      S.items.push(id === it.id ? it : { ...it, id });
    }
  }
}

function typeCounts() {
  const c = {};
  for (const it of S.items) {
    const t = c[it.type] || (c[it.type] = { total: 0, fresh: 0 });
    t.total++;
    if (!S.used.has(it.id)) t.fresh++;
  }
  return c;
}

function renderBankInfo() {
  const info = $('#bankInfo');
  const errs = S.banks.flatMap(b => b.errors.map(e => `${b.title}：${e}`));
  if (!S.items.length) {
    info.textContent = '尚未載入題庫。';
  } else {
    const subCount = S.items.reduce((n, it) => n + (it.type === 'group' ? it.subs.length : 1), 0);
    info.innerHTML = `已載入 ${S.banks.map(b => `「${esc(b.title)}」`).join('、')}，共 ${S.items.length} 題（含題組小題共 ${subCount} 題）。`;
  }
  $('#bankErrors').classList.toggle('hidden', !errs.length);
  $('#bankErrors').innerHTML = errs.length ? `<b>有 ${errs.length} 個問題需要檢查：</b><br>${errs.map(esc).join('<br>')}` : '';
  $('#previewBtn').disabled = !S.items.length;
  renderTypeRows();
}

function renderTypeRows() {
  const counts = typeCounts();
  const prev = readSettings();
  const rows = Object.keys(TYPES).filter(t => counts[t]).map(t => {
    const c = counts[t];
    const n = prev.counts[t] ?? Math.min(c.total, 5);
    const time = prev.times[t] ?? (TYPES[t].time || 60);
    const unlimited = prev.unlimited[t] ?? TYPES[t].time === 0;
    return `<tr data-type="${t}">
      <td>${TYPES[t].label}</td><td>${c.total}</td><td>${c.fresh}</td>
      <td><input type="number" class="cnt" min="0" max="${c.total}" value="${n}"></td>
      <td><input type="number" class="time" min="5" step="5" value="${time}" ${unlimited ? 'disabled' : ''}></td>
      <td><input type="checkbox" class="unl" ${unlimited ? 'checked' : ''}></td></tr>`;
  });
  $('#typeRows').innerHTML = rows.join('') || '<tr><td colspan="6" class="muted">載入題庫後會出現。</td></tr>';
  updateDrawInfo();
}

function readSettings() {
  const s = { counts: {}, times: {}, unlimited: {}, repeat: document.querySelector('input[name=repeat]:checked').value,
    order: document.querySelector('input[name=order]:checked')?.value || 'random' };
  // 只指定總題數：不分題型，從整個題庫抽
  if (document.querySelector('input[name=countMode]:checked')?.value === 'total') {
    s.total = Math.min(S.items.length, Math.max(0, Math.round(Number($('#totalCount').value) || 0)));
  }
  for (const tr of $$('#typeRows tr[data-type]')) {
    const t = tr.dataset.type;
    s.counts[t] = Math.max(0, Number($('.cnt', tr).value) || 0);
    s.times[t] = Math.max(5, Number($('.time', tr).value) || TYPES[t].time || 60);
    s.unlimited[t] = $('.unl', tr).checked;
  }
  return s;
}

function updateDrawInfo() {
  const s = readSettings();
  const byTotal = s.total !== undefined;
  $('#totalCount').disabled = !byTotal;
  $('#totalCount').max = S.items.length;
  $('#totalMax').textContent = S.items.length;
  for (const el of $$('#typeRows .cnt')) el.disabled = byTotal;
  const n = byTotal ? s.total : Object.values(s.counts).reduce((a, b) => a + b, 0);
  $('#drawInfo').textContent = n ? `這次會抽 ${n} 題` : '';
  $('#startBtn').disabled = !n;
  $('#startBtn').textContent = S.room ? '抽下一份題組' : '建立教室並抽題';
}

function previewAll() {
  const html = S.items.map((it, i) => itemPreviewHtml(it, `${i + 1}`)).join('<hr>');
  showModal(`<h2>題庫預覽（共 ${S.items.length} 題）</h2>${html}`);
}

function itemPreviewHtml(it, label) {
  if (it.type === 'group') {
    return `<div class="preview-item"><span class="badge">${label}．題組${it.time ? `（${it.time} 秒）` : ''}</span>${passageHtml(it)}
      ${it.subs.map((q, j) => `<div class="preview-sub">${questionPreviewHtml(q, `${label}-${j + 1}`)}</div>`).join('')}</div>`;
  }
  return `<div class="preview-item">${questionPreviewHtml(it, label)}</div>`;
}

function questionPreviewHtml(q, label) {
  return `${questionHtml(q, { label })}${q.type === 'choice' ? optionsHtml(q, { correct: q.answer }) : ''}
    <div class="preview-answer">答案：<b>${textHtml(answerText(q))}</b>${q.time ? `　<span class="muted">（${q.time} 秒）</span>` : ''}</div>`;
}

// ---------- 抽題 ----------

// 從一堆題目裡抽 n 題；「出過的先不再出」時先抽沒出過的，不夠才重新開始一輪
function pickFrom(list, n, settings) {
  if (settings.repeat === 'repeat') return shuffle(list).slice(0, n);
  const chosen = shuffle(list.filter(it => !S.used.has(it.id))).slice(0, n);
  if (chosen.length < n) {
    for (const it of list) S.used.delete(it.id);
    chosen.push(...shuffle(list.filter(it => !chosen.includes(it))).slice(0, n - chosen.length));
  }
  return chosen;
}

function drawRound(settings) {
  const picked = [];
  const pickedIds = new Set();
  if (settings.total !== undefined) picked.push(...pickFrom(S.items, settings.total, settings));
  else for (const [t, n] of Object.entries(settings.counts)) {
    if (!n) continue;
    const ofType = S.items.filter(it => it.type === t);
    let chosen = [];
    if (settings.repeat === 'repeat') {
      chosen = shuffle(ofType).slice(0, n);
    } else {
      let fresh = shuffle(ofType.filter(it => !S.used.has(it.id)));
      chosen = fresh.slice(0, n);
      if (chosen.length < n) {
        // 這個題型全部出過了：重新開始一輪，但這一份裡不重複
        for (const it of ofType) S.used.delete(it.id);
        const more = shuffle(ofType.filter(it => !chosen.includes(it)));
        chosen = chosen.concat(more.slice(0, n - chosen.length));
      }
    }
    for (const it of chosen) if (!pickedIds.has(it.id)) { pickedIds.add(it.id); picked.push(it); }
  }
  // 亂序：所有抽到的題目一起打亂，不分題型；依序：照題庫檔裡的順序
  if (settings.order === 'sequential') return picked.sort((x, y) => S.items.indexOf(x) - S.items.indexOf(y));
  return shuffle(picked);
}

function newRound(settings) {
  const items = drawRound(settings);
  const no = S.rounds.length + 1;
  const round = { no, settings, steps: [], idx: -1, questions: {}, order: [], finished: false };
  items.forEach((item, i) => {
    const step = { item, keys: [] };
    const base = `r${no}s${i + 1}`;
    if (item.type === 'group') {
      item.subs.forEach((q, j) => {
        const key = `${base}q${j + 1}`;
        step.keys.push(key);
        round.questions[key] = { key, q, label: `${i + 1}-${j + 1}`, step: i, marks: {}, cellMarks: {}, participants: [] };
        round.order.push(key);
      });
    } else {
      const key = `${base}q1`;
      step.keys.push(key);
      round.questions[key] = { key, q: item, label: `${i + 1}`, step: i, marks: {}, cellMarks: {}, participants: [] };
      round.order.push(key);
    }
    round.steps.push(step);
  });
  S.rounds.push(round);
  S.round = round;
  S.hintPrep = prepareHints(round);
  return round;
}

// 抽好題目就先在背景準備寫國字的部件提示，換題時老師一按就能開放
async function prepareHints(round) {
  let failed = 0;
  for (const Q of Object.values(round.questions)) {
    if (Q.q.type !== 'hanzi') continue;
    try { Q.hints = await questionHints(Q.q, guideChars('hanzi', answerText(Q.q))); } catch { failed++; }
  }
  return failed;
}

const stepHints = step => step ? step.keys.filter(k => S.round.questions[k].hints) : [];
const stepHasHanzi = step => !!step && step.keys.some(k => S.round.questions[k].q.type === 'hanzi');

function stepTime(step) {
  const it = step.item;
  const st = S.round.settings;
  if (st.unlimited[it.type]) return 0;
  if (it.time) return it.time;
  return st.times[it.type] ?? TYPES[it.type].time;
}

// ---------- 教室 ----------

async function createRoom() {
  S.room = randomString(16);
  S.code = String(Math.floor(1000 + Math.random() * 9000));
  const salt = randomString(8);
  const base = location.href.replace(/[^/]*([?#].*)?$/, '');
  S.joinUrl = `${base}student.html?r=${S.room}`;
  const R = `rooms/${S.room}`;
  await S.db.set(`${R}/meta`, { codeHash: await sha256(salt + S.code), salt, created: S.db.now(), theme: S.theme });
  S.db.onDisconnectRemove(R);
  S.db.on(`${R}/students`, v => { S.students = v || {}; renderRun(); });
  S.db.on(`${R}/live`, v => { S.live = v || {}; renderGrid(); });
  window.addEventListener('beforeunload', e => { e.preventDefault(); e.returnValue = ''; });
  renderJoinPanel();
}

function joinBlockHtml(big) {
  return `<div class="join-block ${big ? 'big' : ''}">
    <div class="qr">${qrSvg(S.joinUrl)}</div>
    <div class="join-text">
      <div class="muted">用平板掃描 QR code，再輸入認證碼</div>
      <div class="code-label">認證碼</div>
      <div class="code">${S.code}</div>
      <div class="muted small url">${esc(S.joinUrl)}</div>
    </div></div>`;
}

function qrSvg(text) {
  if (!window.qrcode) return `<div class="muted">QR code 載入失敗，請用下方網址。</div>`;
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
}

function renderJoinPanel() {
  $('#joinPanel').innerHTML = `${joinBlockHtml(false)}
    <div class="row join-theme"><label>畫面主題 <select class="theme-select"></select></label></div>
    <div class="row join-theme voice-row"><label>讀題語音 <select class="voice-select"></select></label><button class="voice-test" type="button">試聽</button>
      <span class="spacer"></span><span class="muted small">點空白處收合</span></div>`;
  fillThemeSelects();
  fillVoiceSelects();
}

// ---------- 讀題語音 ----------

// 中文語音，臺灣國語排最前面；Google 國語（臺灣）只有 Chrome 瀏覽器才有
function zhVoices() {
  const all = window.speechSynthesis ? speechSynthesis.getVoices() : [];
  const rank = v => (/zh[-_]TW/i.test(v.lang) ? 0 : /zh[-_]HK/i.test(v.lang) ? 2 : 1) * 2 + (/google/i.test(v.name) ? 0 : 1);
  return all.filter(v => /^zh|^cmn/i.test(v.lang)).sort((a, b) => rank(a) - rank(b));
}

function savedVoiceName() {
  try { return localStorage.getItem(VOICE_KEY) || ''; } catch { return ''; }
}

// 老師選的語音；沒選過時預設 Google 國語（臺灣），沒有的話用第一個臺灣國語語音
function currentVoice() {
  const list = zhVoices();
  return list.find(v => v.name === savedVoiceName())
    || list.find(v => /google/i.test(v.name) && /zh[-_]TW/i.test(v.lang))
    || list[0] || null;
}

function voiceLabel(v) {
  const where = /zh[-_]TW/i.test(v.lang) ? '臺灣' : /zh[-_]HK/i.test(v.lang) ? '香港' : /zh[-_]CN/i.test(v.lang) ? '中國' : v.lang;
  return `${v.name}（${where}）`;
}

function fillVoiceSelects() {
  const list = zhVoices();
  const cur = currentVoice();
  const html = list.length
    ? list.map(v => `<option value="${esc(v.name)}">${esc(voiceLabel(v))}</option>`).join('')
    : '<option value="">這台電腦找不到中文語音</option>';
  for (const sel of $$('.voice-select')) {
    sel.innerHTML = html;
    sel.value = cur ? cur.name : '';
    if (!sel.dataset.bound) {
      sel.dataset.bound = '1';
      sel.addEventListener('change', () => {
        try { localStorage.setItem(VOICE_KEY, sel.value); } catch { /* 存不了沒關係 */ }
        fillVoiceSelects();
      });
    }
  }
}

function fillThemeSelects() {
  for (const sel of $$('.theme-select')) {
    if (!sel.options.length) {
      sel.innerHTML = Object.entries(THEMES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
      sel.addEventListener('change', () => setTheme(sel.value));
    }
    sel.value = S.theme;
  }
}

// ---------- 出題流程 ----------

function current() { return S.round && S.round.steps[S.round.idx]; }
let phase = 'idle';   // idle | answering | revealed | finished
let endsAt = null;
let pausedLeft = null; // 全班暫停作答時，倒數剩下的毫秒數

async function startStep(i) {
  const r = S.round;
  r.idx = i;
  const step = r.steps[i];
  const secs = stepTime(step);
  const now = S.db.now();
  endsAt = secs ? now + secs * 1000 : null;
  pausedLeft = null;
  phase = 'answering';
  S.subTab = 'follow';
  S.showAnswer = false;
  // 每進入新的一題，學生畫面預設全部遮蔽，老師再自己打開
  S.defaultMask = true;
  S.masks = {};
  step.startedAt = now;
  S.used.add(step.item.id);
  sessionStorage.setItem(USED_KEY, JSON.stringify([...S.used]));
  // 只聽這一題的作答
  S.unsub.forEach(f => f && f());
  S.unsub = step.keys.flatMap(k => [
    S.db.on(`rooms/${S.room}/answers/${k}`, v => { S.answers[k] = v || {}; renderGrid(); renderQPanel(); }),
    S.db.on(`rooms/${S.room}/ink/${k}`, v => { S.ink[k] = v || {}; renderGrid(); }),
    S.db.on(`rooms/${S.room}/hintUsed/${k}`, v => {
      S.hintUsed[k] = v || {};
      r.questions[k].hintUsed = Object.keys(v || {});
      renderGrid();
    }),
  ]);
  // 每一題開始時，部件提示、部首意義先關閉，由老師決定要不要開
  S.hintOn = false;
  S.radicalOn = false;
  stopReading();
  // 每一題開始時，全班都可以作答
  S.pen = { all: true, by: {} };
  await S.db.set(`rooms/${S.room}/pen`, S.pen);
  await S.db.set(`rooms/${S.room}/current`, {
    no: i + 1, total: r.steps.length, round: r.no,
    keys: step.keys, q: publicItem(step.item), phase, startedAt: now, endsAt, pausedLeft: null,
  });
  renderRun();
}

async function endStep() {
  if (phase !== 'answering') return;
  phase = 'revealed';
  closeCollab();
  const step = current();
  const present = Object.keys(S.students);
  const reveal = {};
  for (const k of step.keys) {
    const Q = S.round.questions[k];
    reveal[k] = { a: answerText(Q.q), e: Q.q.explanation || '' };
    Q.participants = present;
  }
  S.guide = true;
  S.hintOn = false;
  S.radicalOn = false;
  pausedLeft = null;
  await S.db.update(`rooms/${S.room}/current`, { phase, reveal, guide: true, hint: null, radical: null, endsAt: null, pausedLeft: null, endedAt: S.db.now() });
  const guides = step.keys.flatMap(k => guideChars(S.round.questions[k].q.type, answerText(S.round.questions[k].q)));
  if (guides.length) ensureKai(guides).then(() => { tileSigs = new WeakMap(); renderGrid(); });
  renderRun();
  // 等最後一刻按下送出的答案傳到，再自動批改
  S.gradingNow = true;
  S.grading = new Promise(res => setTimeout(() => {
    S.gradingNow = false;
    for (const k of step.keys) {
      const Q = S.round.questions[k];
      const ans = S.answers[k] || {};
      for (const sid of Q.participants) {
        if (Q.marks[sid] === undefined) {
          const g = autoGrade(Q.q, ans[sid]);
          if (g !== undefined) Q.marks[sid] = g;
        }
      }
    }
    renderRun();
    res();
  }, 1500));
  await S.grading;
}

// 這一題還有幾位學生沒有批改
function pendingCount(step) {
  if (!step || phase !== 'revealed') return 0;
  return step.keys.reduce((n, k) => {
    const Q = S.round.questions[k];
    return n + Q.participants.filter(sid => Q.marks[sid] === undefined).length;
  }, 0);
}

async function next() {
  const r = S.round;
  if (phase === 'answering' || S.nextBusy) return;
  await S.grading;
  if (pendingCount(current())) { renderRun(); return; }
  S.nextBusy = true;
  try {
    // 進入下一題前，先看目前的即時排行，按確認才真的換題
    if (r.idx >= 0) {
      const last = r.idx + 1 >= r.steps.length;
      const ok = await confirmBox(`<h2>目前的成績排行</h2>${rankingHtml()}`, last ? '確認，看成績' : '確認，進入下一題');
      if (!ok) return;
    }
    if (r.idx + 1 < r.steps.length) await startStep(r.idx + 1);
    else await finishRound();
  } finally { S.nextBusy = false; renderRun(); }
}

async function finishRound() {
  stopReading();
  $('#scorePanel').classList.add('hidden');
  if (phase === 'answering') await endStep();
  const r = S.round;
  r.finished = true;
  // 提早結束：只算已經出過的題目
  r.givenKeys = r.order.filter(k => r.steps[r.questions[k].step].startedAt);
  phase = 'finished';
  S.unsub.forEach(f => f && f());
  S.unsub = [];
  await S.db.update(`rooms/${S.room}/current`, { phase: 'finished' });
  await pushScores();
  showView('summary');
  renderSummary(S, { onToggle: pushScores, onNextRound: backToSetup });
}

async function pushScores() {
  const r = S.round;
  const scores = computeScores(S, r);
  const payload = {};
  for (const [sid, s] of Object.entries(scores)) payload[sid] = { ...s, round: r.no };
  await S.db.set(`rooms/${S.room}/scores`, payload);
}

function backToSetup() {
  phase = 'idle';
  showView('setup');
  renderTypeRows();
}

// ---------- 上課畫面 ----------

function showView(v) {
  for (const id of ['setup', 'run', 'summary']) $('#' + id).classList.toggle('hidden', id !== v);
}

function renderRun() {
  if (!S.room || !S.round) return;
  const ids = Object.keys(S.students);
  const online = ids.filter(id => S.students[id].online !== false).length;
  $('#studentCount').textContent = `${online} 人${online !== ids.length ? `（離線 ${ids.length - online}）` : ''}`;
  const r = S.round;
  $('#progress').textContent = r && r.idx >= 0 ? `${r.idx + 1}/${r.steps.length} 題` : `共 ${r ? r.steps.length : 0} 題`;
  const answering = phase === 'answering';
  const step = current();
  $('#endBtn').disabled = !answering;
  $('#earlyEnd').disabled = r.idx < 0;
  $('#penAllBtn').disabled = !answering;
  renderPenAll();
  renderHintBtn();
  renderRadicalBtn();
  for (const b of $$('#extendBox button')) b.disabled = !(answering && (endsAt || pausedLeft !== null));
  $('#readBtn').disabled = !step;
  $('#scoreBtn').disabled = r.idx < 0 && !S.scoreOpen;
  $('#reviewBtn').disabled = !reviewKeys().length;
  renderNextBtn();
  renderTimer();
  renderQPanel();
  renderGrid();
}

function renderNextBtn() {
  const r = S.round;
  const nb = $('#nextBtn');
  const pending = pendingCount(current());
  nb.disabled = phase === 'answering' || S.gradingNow || !!pending || !!S.nextBusy;
  nb.textContent = r.idx < 0 ? '開始第一題' : (r.idx + 1 < r.steps.length ? '下一題 ▶' : '完成，看成績');
  nb.title = phase === 'answering' ? '先結束這一題的作答' : pending ? `還有 ${pending} 位學生沒有批改對錯` : '';
}

function renderTimer() {
  const el = $('#timer');
  if (phase !== 'answering') { el.textContent = phase === 'revealed' ? '已結束' : '--:--'; el.className = 'timer'; return; }
  if (pausedLeft !== null) { el.textContent = '⏸ ' + fmtTime(pausedLeft / 1000); el.className = 'timer paused'; return; }
  if (!endsAt) { el.textContent = '不限時'; el.className = 'timer'; return; }
  const left = (endsAt - S.db.now()) / 1000;
  el.textContent = fmtTime(left);
  el.className = 'timer' + (left <= 10 ? ' urgent' : '');
}

setInterval(() => {
  if (phase === 'answering' && endsAt) {
    renderTimer();
    if (S.db.now() >= endsAt) endStep();
  }
}, 250);

function renderQPanel() {
  const p = $('#qPanel');
  const step = current();
  if (!step) {
    p.innerHTML = `<div class="lobby">${joinBlockHtml(true)}<p class="muted">學生都加入後，按上方「開始第一題」。</p></div>`;
    p.lastHtml = '';
    return;
  }
  const html = qPanelHtml(step);
  if (html === p.lastHtml) return;
  p.lastHtml = html;
  const scroll = p.querySelector('.q-scroll');
  const keep = scroll ? scroll.scrollTop : 0;
  p.innerHTML = html;
  addSpeakButtons(step);
  fitQPanel();
  const ns = p.querySelector('.q-scroll');
  if (ns) ns.scrollTop = keep;
}

function qPanelHtml(step) {
  const r = S.round;
  const it = step.item;
  const revealed = phase !== 'answering';
  const submittedCount = k => Object.values(S.answers[k] || {}).filter(a => a.submitted).length;
  const n = Object.keys(S.students).length;
  let html = '';
  if (it.type === 'group') {
    const tabs = [`<button data-sub="follow" class="${S.subTab === 'follow' ? 'on' : ''}">各自進度</button>`]
      .concat(step.keys.map((k, j) => `<button data-sub="${j}" class="${S.subTab === j ? 'on' : ''}">第 ${j + 1} 小題（${submittedCount(k)}/${n}）</button>`));
    html += `<div class="q-scroll">${passageHtml(it)}`;
    step.keys.forEach((k, j) => {
      const q = r.questions[k].q;
      html += `<div class="sub-q ${S.subTab === j ? 'focus' : ''}">${questionHtml(q, { label: r.questions[k].label })}
        ${q.type === 'choice' ? optionsHtml(q, { correct: revealed || S.showAnswer ? q.answer : null }) : ''}
        ${revealed || S.showAnswer ? `<div class="answer-mid">答案：${textHtml(answerText(q))}</div>${explainHtml(q)}` : ''}</div>`;
    });
    if (!revealed) html += hintPreviewHtml(step) + radicalPreviewHtml(step);
    html += `</div><div class="sub-tabs">${tabs.join('')}</div>`;
  } else {
    const k = step.keys[0];
    const q = it;
    const showAns = revealed || S.showAnswer;
    html += `<div class="q-scroll">${questionHtml(q, { label: `第 ${r.idx + 1} 題` })}
      ${q.type === 'choice' ? optionsHtml(q, { correct: showAns ? q.answer : null }) : ''}
      ${showAns && q.type !== 'choice' ? `<div class="${TYPES[q.type].input === 'draw' && [...answerText(q)].length <= 6 ? 'answer-big' : 'answer-mid'}">${textHtml(answerText(q))}</div>` : ''}
      ${showAns ? explainHtml(q) : ''}
      ${revealed ? '' : hintPreviewHtml(step) + radicalPreviewHtml(step)}
      </div><div class="q-foot"><span>已送出 ${submittedCount(k)} / ${n}</span></div>`;
  }
  if (!revealed) html += `<button id="peekBtn" class="peek">${S.showAnswer ? '隱藏答案' : '老師偷看答案'}</button>`;
  else {
    if (step.keys.some(k => guideChars(S.round.questions[k].q.type, answerText(S.round.questions[k].q)).length)) {
      html += `<button id="guideBtn" class="peek">${S.guide ? '格內範字：顯示中（點一下隱藏）' : '格內範字：已隱藏（點一下顯示）'}</button>`;
    }
    html += gradeBar(step);
  }
  return fontBarHtml() + html;
}

// ---------- 文字縮放 ----------

function fontBarHtml() {
  const grp = (k, name) => `<span class="fs-grp">${name}<button data-fs="${k}" data-d="-1" title="${name}縮小">－</button><button data-fs="${k}" data-d="1" title="${name}放大">＋</button></span>`;
  const custom = S.fs.q !== 1 || S.fs.a !== 1 || S.fs.s !== 1;
  return `<div class="fs-bar"><span class="muted">字級</span>${grp('q', '題目')}${grp('a', '答案')}${grp('s', '學生作答')}<button data-fs="reset" ${custom ? '' : 'disabled'} title="回到自動大小">自動</button></div>`;
}

function changeFont(k, d) {
  if (k === 'reset') S.fs = { q: 1, a: 1, s: 1 };
  else S.fs[k] = Math.min(3, Math.max(0.4, Math.round(S.fs[k] * (d > 0 ? 1.15 : 1 / 1.15) * 100) / 100));
  try { localStorage.setItem(FS_KEY, JSON.stringify(S.fs)); } catch { /* 無痕視窗存不了，沒關係 */ }
  renderQPanel();
  tileSigs = new WeakMap();
  renderGrid();
}

// 自動找出剛好能把題目區全部放進畫面的字級，再乘上老師調的倍數
function fitQPanel() {
  const box = $('#qPanel .q-scroll');
  if (!box) return;
  // 只有題目內容或視窗大小改變時才重新計算（作答人數更新時沿用）
  const sig = `${box.innerHTML.length}|${box.clientWidth}x${box.clientHeight}`;
  box.style.setProperty('--qs', 1);
  box.style.setProperty('--as', 1);
  if (fitQPanel.sig === sig) {
    box.style.setProperty('--base', fitQPanel.base + 'px');
    box.style.setProperty('--qs', S.fs.q);
    box.style.setProperty('--as', S.fs.a);
    return;
  }
  let lo = 12, hi = 44;
  while (hi - lo > 0.5) {
    const mid = (lo + hi) / 2;
    box.style.setProperty('--base', mid + 'px');
    if (box.scrollHeight <= box.clientHeight + 1 && box.scrollWidth <= box.clientWidth + 1) lo = mid; else hi = mid;
  }
  box.style.setProperty('--base', lo + 'px');
  fitQPanel.sig = sig;
  fitQPanel.base = lo;
  box.style.setProperty('--qs', S.fs.q);
  box.style.setProperty('--as', S.fs.a);
}

// 學生打字的答案：自動調到剛好塞滿縮圖，再乘上老師調的倍數
function fitTileText(el) {
  // 還沒排版好（量不到大小）就等下一個畫面再量
  if (!el.isConnected || !el.clientHeight) { requestAnimationFrame(() => el.isConnected && el.clientHeight && fitTileText(el)); return; }
  el.style.fontSize = '';
  let lo = 12, hi = 96;
  while (hi - lo > 1) {
    const mid = (lo + hi) / 2;
    el.style.fontSize = mid + 'px';
    if (el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1) lo = mid; else hi = mid;
  }
  el.style.fontSize = Math.round(lo * S.fs.s) + 'px';
}

function explainHtml(q) {
  return q.explanation ? `<div class="explain"><div class="reveal-label">詳解</div>${textHtml(q.explanation)}</div>` : '';
}

function gradeBar(step) {
  const keys = gradeKeys(step);
  const pending = keys.reduce((n, k) => {
    const Q = S.round.questions[k];
    return n + Q.participants.filter(sid => Q.marks[sid] === undefined).length;
  }, 0);
  return `<div class="grade-bar">${pending ? `<span>還有 ${pending} 位待批改</span><button id="allRight" class="primary">未批改的全部標對</button>` : '<span class="good">這題已全部批改</span>'}</div>`;
}

// 題組時，依照目前分頁決定要批改哪幾小題
function gradeKeys(step) {
  if (step.item.type !== 'group' || S.subTab === 'follow') return step.keys;
  return [step.keys[S.subTab]];
}

// ---------- 學生縮圖格 ----------

// 依人數算出最大的縮圖大小；最後一排的格子會自動拉寬，不留空位
function layoutGrid(n) {
  const g = $('#grid');
  const W = g.clientWidth, H = g.clientHeight;
  if (!n || !W || !H) return;
  let best = { cols: 1, size: 0 };
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const size = Math.min(W / cols, (H / rows) * 4 / 3);
    if (size > best.size) best = { cols, size };
  }
  const rows = Math.ceil(n / best.cols);
  const key = `${best.cols}x${rows}|${W}x${H}`;
  g.style.setProperty('--cols', best.cols);
  g.style.setProperty('--rows', rows);
  // 版面改變後，手寫縮圖要依新大小重畫
  if (g.dataset.layout !== key) {
    g.dataset.layout = key;
    tileSigs = new WeakMap();
    requestAnimationFrame(() => renderGrid());
  }
}

function tileKey(sid, step) {
  if (step.item.type !== 'group') return step.keys[0];
  if (S.subTab === 'follow') {
    const l = S.live[sid];
    const j = l && l.qkey && step.keys.includes(l.qkey) ? step.keys.indexOf(l.qkey) : 0;
    return step.keys[j];
  }
  return step.keys[S.subTab];
}

function renderGrid() {
  const g = $('#grid');
  if (!S.room) return;
  const sids = Object.keys(S.students).sort((a, b) => (S.students[a].joinedAt || 0) - (S.students[b].joinedAt || 0));
  const step = current();
  if (!sids.length) {
    g.innerHTML = `<div class="empty-grid muted">還沒有學生加入</div>`;
    return;
  }
  g.querySelector('.empty-grid')?.remove();
  for (const el of $$('.tile', g)) if (!S.students[el.dataset.sid]) el.remove();
  for (const sid of sids) {
    let el = g.querySelector(`.tile[data-sid="${CSS.escape(sid)}"]`);
    if (!el) {
      el = document.createElement('div');
      el.className = 'tile';
      el.dataset.sid = sid;
      el.innerHTML = `<div class="tile-head"><span class="sid"></span><span class="st"></span><span class="tile-btns"></span></div><div class="tile-body"></div><div class="tile-mark"></div><div class="mask">已遮蔽<br><span class="small">點一下顯示</span></div>`;
      g.append(el);
    }
    g.append(el); // 維持加入順序
    fillTile(el, sid, step);
  }
  layoutGrid(sids.length);
  renderMaskBtns();
  renderScorePanel();
  if (S.round) renderNextBtn();
}

let tileSigs = new WeakMap();
const penOn = sid => S.pen.by?.[sid] ?? S.pen.all ?? true;

function fillTile(el, sid, step) {
  const st = S.students[sid];
  $('.sid', el).textContent = sid;
  el.classList.toggle('offline', st.online === false);
  const masked = S.masks[sid] ?? S.defaultMask;
  el.classList.toggle('masked', !!masked);
  const body = $('.tile-body', el);
  const markEl = $('.tile-mark', el);
  if (!step) {
    $('.st', el).textContent = st.online === false ? '離線' : '已加入';
    body.innerHTML = '';
    markEl.innerHTML = '';
    $('.tile-btns', el).innerHTML = '';
    el.classList.remove('right', 'wrong', 'submitted', 'pen-off');
    return;
  }
  const k = tileKey(sid, step);
  const Q = S.round.questions[k];
  const a = (S.answers[k] || {})[sid];
  const input = TYPES[Q.q.type].input;
  const subInfo = step.item.type === 'group' ? `第 ${Q.label.split('-')[1]} 小題・` : '';
  const usedHint = !!(S.hintUsed[k] || {})[sid];
  $('.st', el).textContent = st.online === false ? '離線' : subInfo + (a ? (a.submitted ? '已送出' : '作答中') : '未作答') + (usedHint ? '・💡看過提示' : '');
  el.classList.toggle('submitted', !!(a && a.submitted));
  const allowed = penOn(sid);
  el.classList.toggle('pen-off', !allowed);
  const btnSig = `${phase}|${allowed}|${input}`;
  const btns = $('.tile-btns', el);
  if (btns.dataset.sig !== btnSig) {
    btns.dataset.sig = btnSig;
    btns.innerHTML = phase === 'answering'
      ? `${input === 'draw' ? '<button data-collab title="進入這位學生的手寫板">✍ 協助</button>' : ''}<button data-pen title="開關這位學生的作答">${allowed ? '🔓 可作答' : '🔒 暫停'}</button>`
      : '';
  }
  // 只在內容改變時更新，避免閃爍
  const ink = (S.ink[k] || {})[sid];
  const guides = input === 'draw' && phase === 'revealed' && S.guide ? guideChars(Q.q.type, answerText(Q.q)) : [];
  const sig = `${k}|${a ? a.at : ''}|${a ? a.submitted : ''}|${input === 'draw' ? JSON.stringify(ink || null) : ''}|${S.theme}|${guides.join('')}`;
  if (tileSigs.get(body) !== sig) {
    tileSigs.set(body, sig);
    if (input === 'draw') {
      if ((!ink || !ink.c) && !guides.length) body.innerHTML = '<span class="muted">（空白）</span>';
      else {
        if (!body.querySelector('canvas')) body.innerHTML = '<canvas class="tile-ink"></canvas>';
        paintInkThumb(body.querySelector('canvas'), ink || { n: guides.length, c: [] }, { grid: useGrid(Q.q), guides: guides.length ? guides : null });
      }
    } else if (!a || a.v === undefined || a.v === null || a.v === '') body.innerHTML = '<span class="muted">（空白）</span>';
    else if (input === 'choice') body.innerHTML = `<div class="tile-choice">${letter(a.v)}${a.submitted ? '' : '<span class="small muted">（未確認）</span>'}</div>`;
    else {
      body.innerHTML = `<div class="tile-text">${textHtml(a.v)}</div>`;
      const t = body.firstChild;
      requestAnimationFrame(() => fitTileText(t));
    }
  }
  const mark = Q.marks[sid];
  el.classList.toggle('right', mark === true);
  el.classList.toggle('wrong', mark === false);
  el.classList.toggle('partial', typeof mark === 'number');
  if (phase === 'revealed' && Q.participants.includes(sid)) {
    const n = perCell(Q) ? cellCount(Q, sid) : 1;
    if (n > 1) {
      // 手寫題：每個字各自的對錯鍵
      const cm = cellMarksOf(Q, sid);
      markEl.innerHTML = `<div class="cell-marks">${cm.map((m, i) => `<div class="cm"><span class="cm-n">${i + 1}</span>
        <button data-cmark="1" data-i="${i}" class="${m === true ? 'on' : ''}" title="第 ${i + 1} 個字對">✓</button><button data-cmark="0" data-i="${i}" class="${m === false ? 'on' : ''}" title="第 ${i + 1} 個字錯">✗</button></div>`).join('')}
        ${typeof mark === 'number' ? `<span class="cm-sum">${partLabel(Q, sid)}</span>` : ''}</div>`;
    } else {
      markEl.innerHTML = `<button data-mark="1" class="${mark === true ? 'on' : ''}">✓ 對</button><button data-mark="0" class="${mark === false ? 'on' : ''}">✗ 錯</button>`;
    }
    markEl.dataset.key = k;
  } else markEl.innerHTML = '';
}

// ---------- 手寫題每個字分開批改 ----------

// 會用到田字格的題型（手寫作答是一整塊手寫板，整題一起批改）
const perCell = Q => TYPES[Q.q.type].input === 'draw' && Q.q.type !== 'write';

// 這位學生的格數（造詞由學生自己選 2～4 格）
function cellCount(Q, sid) {
  const ink = (S.ink[Q.key] || {})[sid];
  return Math.max(1, (ink && ink.n) || defaultCells(Q.q));
}

// 每格的對錯；整題已經被標成全對或全錯時，每格跟著顯示
function cellMarksOf(Q, sid) {
  const n = cellCount(Q, sid);
  const m = Q.marks[sid];
  const cm = Q.cellMarks[sid];
  return Array.from({ length: n }, (_, i) => (cm && cm[i] !== undefined ? cm[i] : m === true ? true : m === false ? false : undefined));
}

// 每個字都批改後才算出這一題的分數：全對、全錯，或答對的比例
function setCellMark(Q, sid, i, v) {
  const cm = cellMarksOf(Q, sid);
  cm[i] = v;
  Q.cellMarks[sid] = cm;
  if (cm.some(x => x === undefined)) { delete Q.marks[sid]; return; }
  const right = cm.filter(x => x === true).length;
  Q.marks[sid] = right === cm.length ? true : right === 0 ? false : right / cm.length;
}

// ---------- 協助學生的手寫板 ----------

function openCollab(sid) {
  closeCollab();
  const step = current();
  if (!step) return;
  const k = tileKey(sid, step);
  const Q = S.round.questions[k];
  const P = `rooms/${S.room}/ink/${k}/${sid}`;
  const ov = document.createElement('div');
  ov.className = 'collab';
  ov.innerHTML = `<header class="collab-head">
      <b class="collab-who">協助 ${esc(sid)}</b><span class="muted">第 ${esc(Q.label)} 題</span>
      <span class="spacer"></span>
      <button data-cpen></button>
      <button data-wipe="s" class="danger">清除學生全部筆劃</button>
      <button data-wipe="t">清除老師全部筆劃</button>
      <button data-close class="primary">結束協助</button>
    </header>
    <div class="collab-q">${questionHtml(Q.q, { label: Q.label })}</div>
    <div class="collab-cells"></div>
    <p class="collab-note muted">紅色是老師的筆劃，學生不能擦掉。每格下面的工具只會動到老師自己的筆劃；「清學生」會清掉那一格學生寫的字。</p>`;
  document.body.append(ov);
  let n = 0, cells = [];
  const pushers = {};
  const push = (i, strokes) => {
    const f = pushers[i] || (pushers[i] = throttleTail(st => S.db.set(`${P}/c/${i}/t`, st.length ? st : null), 200));
    f(strokes);
  };
  const cellAt = (v, i) => v && v.c ? v.c[i] : null;
  const build = (nn, v) => {
    n = nn;
    cells = buildCells($('.collab-cells', ov), n, {
      own: 't', teacher: true, grid: useGrid(Q.q),
      onChange: (i, kind) => {
        if (kind === 'wipeS') { S.db.set(`${P}/c/${i}/clearS`, S.db.now()); return; }
        push(i, cells[i].t);
      },
    });
    cells.forEach((c, i) => { const cd = cellData(cellAt(v, i)); c.t = cd.t; c.s = cd.s; c.redraw(); });
  };
  const unsub = S.db.on(P, v => {
    const nn = (v && v.n) || defaultCells(Q.q);
    if (nn !== n) build(nn, v);
    cells.forEach((c, i) => c.setOther(cellData(cellAt(v, i)).s));
  });
  const penBtn = $('[data-cpen]', ov);
  const showPen = () => { penBtn.textContent = penOn(sid) ? '學生畫筆：開啟中（點一下關閉）' : '學生畫筆：關閉中（點一下開啟）'; penBtn.className = penOn(sid) ? '' : 'warn'; };
  showPen();
  ov.addEventListener('click', e => {
    if (e.target.closest('[data-close]')) { closeCollab(); return; }
    if (e.target.closest('[data-cpen]')) {
      const on = !penOn(sid);
      S.pen.by = { ...(S.pen.by || {}), [sid]: on };
      S.db.set(`rooms/${S.room}/pen/by/${sid}`, on);
      showPen();
      renderGrid();
      return;
    }
    const w = e.target.closest('[data-wipe]');
    if (w) {
      for (let i = 0; i < n; i++) {
        if (w.dataset.wipe === 's') S.db.set(`${P}/c/${i}/clearS`, S.db.now());
        else { cells[i].clear(); }
      }
    }
  });
  S.collab = { sid, close: () => { unsub(); ov.remove(); } };
}

function closeCollab() {
  if (S.collab) { S.collab.close(); S.collab = null; }
}

// 節流，但最後一次一定會送出
function throttleTail(fn, ms) {
  let timer = null, last = null;
  return arg => {
    last = arg;
    if (timer) return;
    timer = setTimeout(() => { timer = null; fn(last); }, ms);
  };
}

function setTheme(name) {
  S.theme = applyTheme(name);
  saveTheme(S.theme);
  for (const sel of $$('.theme-select')) sel.value = S.theme;
  if (S.room) S.db.update(`rooms/${S.room}/meta`, { theme: S.theme });
  renderGrid();
}

function renderHintBtn() {
  const b = $('#hintBtn');
  b.disabled = !(phase === 'answering' && stepHasHanzi(current()));
  b.textContent = S.hintOn ? '部件提示 開' : '部件提示';
  b.classList.toggle('primary', S.hintOn);
}

async function toggleHints() {
  const step = current();
  if (phase !== 'answering' || !step) return;
  if (S.hintOn) {
    S.hintOn = false;
    await S.db.update(`rooms/${S.room}/current`, { hint: null });
    renderHintBtn(); renderQPanel();
    return;
  }
  const b = $('#hintBtn');
  b.textContent = '準備部件提示中…';
  const failed = await S.hintPrep;
  const ks = stepHints(step);
  if (!ks.length) {
    renderHintBtn();
    alert(failed ? '讀不到部件資料，請確認網路後重新抽題。' : '這一題沒有可以用的部件提示（例如答案都是注音）。');
    return;
  }
  if (phase !== 'answering' || current() !== step) return;
  S.hintOn = true;
  const data = Object.fromEntries(ks.map(k => [k, S.round.questions[k].hints]));
  await S.db.update(`rooms/${S.room}/current`, { hint: { on: true, data } });
  renderHintBtn(); renderQPanel();
}

// 老師端預覽：學生按 💡 會看到的內容
function hintPreviewHtml(step) {
  if (!S.hintOn) return '';
  const blocks = stepHints(step).map(k => {
    const Q = S.round.questions[k];
    const cells = Q.hints.map((h, i) => h ? `<div class="hint-pre-cell"><div class="muted small">第 ${i + 1} 格</div>${hintCardsHtml(h)}</div>` : '').join('');
    return `${step.keys.length > 1 ? `<div class="muted small">第 ${esc(Q.label)} 小題</div>` : ''}${cells}`;
  }).join('');
  return `<div class="hint-pre"><div class="reveal-label">部件提示（學生按 💡 才會看到）</div>${blocks}</div>`;
}

function renderPenAll() {
  const b = $('#penAllBtn');
  if (!b) return;
  b.textContent = S.pen.all ? '作答：開放' : '作答：暫停';
  b.classList.toggle('warn', !S.pen.all);
}

// ---------- 改錯字：部首意義提示 ----------

// 每個要改的正確字的部首和意義；查不到的字是 null
function radicalData(Q) {
  if (Q.q.type !== 'correction') return null;
  if (Q.radicals === undefined) {
    const list = guideChars('correction', answerText(Q.q)).map(ch => {
      const r = radicalOf(ch);
      return r ? { ch, ...r } : null;
    });
    Q.radicals = list.some(Boolean) ? list : null;
  }
  return Q.radicals;
}
const stepRadicals = step => step ? step.keys.filter(k => radicalData(S.round.questions[k])) : [];

function renderRadicalBtn() {
  const b = $('#radicalBtn');
  b.disabled = !(phase === 'answering' && stepRadicals(current()).length);
  b.textContent = S.radicalOn ? '部首意義 開' : '部首意義';
  b.classList.toggle('primary', S.radicalOn);
}

async function toggleRadical() {
  const step = current();
  if (phase !== 'answering' || !step) return;
  S.radicalOn = !S.radicalOn;
  // 學生只拿到意義，拿不到部首本身
  const data = S.radicalOn
    ? Object.fromEntries(stepRadicals(step).map(k => [k, radicalData(S.round.questions[k]).map(x => (x ? x.meaning : ''))]))
    : null;
  await S.db.update(`rooms/${S.room}/current`, { radical: data ? { on: true, data } : null });
  renderRadicalBtn(); renderQPanel();
}

// 老師端預覽：老師看得到部首，學生只看得到意義
function radicalPreviewHtml(step) {
  if (!S.radicalOn) return '';
  const rows = stepRadicals(step).flatMap(k => radicalData(S.round.questions[k]).map((x, i, all) => {
    const which = all.length > 1 ? `第 ${i + 1} 個字` : '正確的字';
    return x ? `<li>${which}「${esc(x.ch)}」：部首 <b>${esc(x.radical)}</b>，學生看到「部首${esc(x.meaning)}」</li>`
      : `<li>${which}：查不到部首，學生不會看到這一個的提示</li>`;
  }));
  return `<div class="hint-pre"><div class="reveal-label">部首意義提示（學生畫面上看得到意義，看不到部首）</div><ul class="radical-pre">${rows.join('')}</ul></div>`;
}

// ---------- 讀題 ----------

const speakClean = t => String(t || '').replace(/[（(]\s*[）)]/g, '，空格，').replace(/[　_＿]{2,}/g, '，空格，');

// 要唸的文字：data-speak="p|k"（題目）、"o|k|i"（選項）、"g"（題組文章）
function speakTextOf(spec) {
  const step = current();
  if (!step) return '';
  const [kind, k, i] = spec.split('|');
  if (kind === 'g') return `${speakClean(step.item.title)}。${speakClean(step.item.passage)}`;
  const q = S.round.questions[k]?.q;
  if (!q) return '';
  if (kind === 'o') return `${letter(Number(i))}，${speakClean(q.options[Number(i)].text) || '圖片'}`;
  return speakClean(q.prompt);
}

// 功能列的「讀題」只唸題目（題組時唸目前看的那一小題），選項用各自的 🔊
function toolbarSpeakSpec() {
  const step = current();
  if (!step) return '';
  const k = typeof S.subTab === 'number' ? step.keys[S.subTab] : step.keys[0];
  return `p|${k}`;
}

function readQuestion(spec = toolbarSpeakSpec(), btn = $('#readBtn')) {
  const synth = window.speechSynthesis;
  if (!synth) { alert('這台電腦的瀏覽器不支援朗讀。'); return; }
  const same = S.speaking === spec;
  stopReading();
  if (same) return;
  const text = speakTextOf(spec);
  if (!text) return;
  S.speaking = spec;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-TW';
  const voice = currentVoice();
  if (voice) { u.voice = voice; u.lang = voice.lang; }
  u.rate = 0.9;
  u.onend = u.onerror = () => { if (S.speaking === spec) { S.speaking = null; renderReadBtns(); } };
  synth.speak(u);
  renderReadBtns();
}

function speakSample() {
  if (!window.speechSynthesis) { alert('這台電腦的瀏覽器不支援朗讀。'); return; }
  stopReading();
  const u = new SpeechSynthesisUtterance('小朋友，請看第一題。老鷹在天空中飛翔。');
  const voice = currentVoice();
  u.lang = 'zh-TW';
  if (voice) { u.voice = voice; u.lang = voice.lang; }
  u.rate = 0.9;
  speechSynthesis.speak(u);
}

function stopReading() {
  S.speaking = null;
  if (window.speechSynthesis) speechSynthesis.cancel();
  renderReadBtns();
}

// 正在唸的那個鍵變成「停止」
function renderReadBtns() {
  const b = $('#readBtn');
  const tb = S.speaking && S.speaking === toolbarSpeakSpec();
  b.textContent = tb ? '⏹ 停止' : '🔊 讀題';
  b.classList.toggle('primary', !!tb);
  for (const x of $$('#qPanel [data-speak]')) {
    const on = x.dataset.speak === S.speaking;
    x.classList.toggle('on', on);
    x.textContent = on ? '⏹' : '🔊';
  }
}

// 題目區每個題目、選項、題組文章前面加一個 🔊
function addSpeakButtons(step) {
  const box = $('#qPanel .q-scroll');
  if (!box) return;
  const mk = spec => {
    const b = document.createElement('button');
    b.className = 'speak-btn';
    b.dataset.speak = spec;
    b.title = '唸出來';
    b.textContent = '🔊';
    return b;
  };
  const passage = box.querySelector('.passage');
  if (passage && step.item.type === 'group') passage.prepend(mk('g'));
  const blocks = step.item.type === 'group' ? $$('.sub-q', box) : [box];
  blocks.forEach((el, j) => {
    const k = step.keys[j];
    if (!k) return;
    const p = el.querySelector('.q-prompt');
    if (p) p.prepend(mk(`p|${k}`));
    $$('.option', el).forEach((o, i) => o.prepend(mk(`o|${k}|${i}`)));
  });
  renderReadBtns();
}

// ---------- 確認視窗 ----------

function confirmBox(html, okLabel, { danger = false } = {}) {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.innerHTML = `<div class="modal-box confirm-box"><div class="modal-body">${html}</div>
      <div class="confirm-btns"><button data-no class="big">取消</button><button data-ok class="big ${danger ? 'stop-btn' : 'primary'}">${esc(okLabel)}</button></div></div>`;
    const done = v => { wrap.remove(); resolve(v); };
    wrap.addEventListener('click', e => {
      if (e.target.closest('[data-ok]')) done(true);
      else if (e.target === wrap || e.target.closest('[data-no]')) done(false);
    });
    document.body.append(wrap);
  });
}

// ---------- 即時成績 ----------

// 已經公布答案的題目
function gradedKeys() {
  const r = S.round;
  if (!r) return [];
  return r.order.filter(k => {
    const i = r.questions[k].step;
    return i < r.idx || (i === r.idx && phase !== 'answering');
  });
}

function liveScores() {
  const r = S.round;
  const keys = gradedKeys();
  return Object.keys(S.students).map(sid => {
    let right = 0, wrong = 0, pend = 0, asked = 0;
    const marks = keys.map(k => {
      const Q = r.questions[k];
      if (!Q.participants.includes(sid)) return { k, m: 'na' };
      asked++;
      const c = credit(Q.marks[sid]);
      if (c === null) pend++; else { right += c; wrong += 1 - c; }
      return { k, m: c === null ? 'pend' : c === 1 ? 'ok' : c === 0 ? 'no' : 'part', label: c !== null && c > 0 && c < 1 ? partLabel(Q, sid) : '' };
    });
    const score = asked ? Math.round(right / asked * 100) : 0;
    return { sid, right: Math.round(right * 10) / 10, wrong: Math.round(wrong * 10) / 10, pend, asked, score, marks };
  });
}

function rankingHtml() {
  const list = liveScores().filter(x => x.asked).sort((a, b) => b.right - a.right || a.wrong - b.wrong || a.sid.localeCompare(b.sid, 'en', { numeric: true }));
  if (!list.length) return '<p class="muted">目前還沒有成績。</p>';
  let rank = 0, prev = null;
  const rows = list.map((x, i) => {
    if (!prev || x.right !== prev.right || x.wrong !== prev.wrong) rank = i + 1;
    prev = x;
    return `<tr><td class="rank">${rank}</td><th>${esc(x.sid)}</th><td class="ok">${fmtNum(x.right)}</td><td class="no">${fmtNum(x.wrong)}</td><td class="score">${x.score}</td></tr>`;
  });
  return `<p class="muted">已出 ${gradedKeys().length} 題，分數＝答對題數 ÷ 已作答題數 × 100（手寫題部分對的，依答對的字數比例計分）</p>
    <div class="rank-wrap"><table class="rank-table"><thead><tr><th>名次</th><th>學生</th><th>答對</th><th>答錯</th><th>目前分數</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

function renderScorePanel() {
  const p = $('#scorePanel');
  $('#scoreBtn').classList.toggle('primary', S.scoreOpen);
  if (!S.scoreOpen || !S.round) { p.classList.add('hidden'); return; }
  p.classList.remove('hidden');
  const r = S.round;
  const list = liveScores().sort((a, b) => a.sid.localeCompare(b.sid, 'en', { numeric: true }));
  const sym = { ok: '○', no: '✕', pend: '？', na: '—', part: '△' };
  const rows = list.map(x => `<tr><th>${esc(x.sid)}</th><td class="ok">${fmtNum(x.right)}</td><td class="no">${fmtNum(x.wrong)}</td><td class="pend">${x.pend || ''}</td>
    <td class="dots">${x.marks.map(({ k, m, label }) => `<span class="dot ${m}" title="第 ${esc(r.questions[k].label)} 題${label ? ` 對 ${label} 字` : ''}">${sym[m]}</span>`).join('')}</td></tr>`);
  p.innerHTML = `<div class="sp-head"><b>即時成績</b><span class="muted small">已公布 ${gradedKeys().length} 題</span><span class="spacer"></span><button data-close title="收合">收合 ▴</button></div>
    <div class="sp-body"><table class="sp-table"><thead><tr><th>學生</th><th>對</th><th>錯</th><th>待批</th><th>每一題</th></tr></thead><tbody>${rows.join('') || '<tr><td colspan="5" class="muted">還沒有學生</td></tr>'}</tbody></table></div>`;
}

// ---------- 回看前面的題目 ----------

function reviewKeys() {
  return gradedKeys();
}

function openReview() {
  const r = S.round;
  const keys = reviewKeys();
  if (!keys.length) return;
  const items = keys.map(k => {
    const Q = r.questions[k];
    const right = fmtNum(Math.round(Q.participants.reduce((n, sid) => n + (credit(Q.marks[sid]) || 0), 0) * 10) / 10);
    const text = String(Q.q.prompt || '').replace(/\s+/g, ' ');
    return `<button class="review-item" data-q="${k}"><span class="badge type-badge">第 ${esc(Q.label)} 題．${TYPES[Q.q.type].label}</span>
      <span class="review-text">${esc(text.length > 40 ? text.slice(0, 40) + '…' : text)}</span><span class="muted small">答對 ${right}/${Q.participants.length}</span></button>`;
  }).join('');
  const m = showModal(`<h2>回看前面的題目</h2><p class="muted">只能看題目和大家的作答，學生不能重新作答。點一題看詳細內容。</p><div class="review-list">${items}</div>`);
  m.addEventListener('click', e => {
    const b = e.target.closest('[data-q]');
    if (b) showQuestion(S, r, b.dataset.q);
  });
}

// ---------- 遮蔽 ----------

function renderMaskBtns() {
  const anyOpen = Object.keys(S.students).some(sid => !(S.masks[sid] ?? S.defaultMask));
  const anyMasked = Object.keys(S.students).some(sid => (S.masks[sid] ?? S.defaultMask));
  $('#showAll').classList.toggle('active', !anyMasked);
  $('#maskAll').classList.toggle('active', !anyOpen);
}

// ---------- 事件 ----------

function bind() {
  const loadFiles = async files => {
    $('#bankInfo').textContent = '讀取中…';
    for (const f of files) {
      try { S.banks.push(await readBankFile(f)); } catch (err) { alert(err.message); }
    }
    rebuildItems();
    renderBankInfo();
  };
  $('#bankFile').addEventListener('change', e => {
    const files = [...e.target.files];
    e.target.value = '';
    loadFiles(files);
  });
  // 把檔案拖拉到設定畫面任何地方都可以載入
  const setup = $('#setup');
  let depth = 0;
  setup.addEventListener('dragenter', e => { e.preventDefault(); depth++; setup.classList.add('dragging'); });
  setup.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; setup.classList.remove('dragging'); } });
  setup.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  setup.addEventListener('drop', e => {
    e.preventDefault();
    depth = 0;
    setup.classList.remove('dragging');
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) loadFiles(files);
  });
  $('#sampleBtn').addEventListener('click', async () => {
    const raw = await (await fetch('samples/sample-bank.json')).json();
    S.banks.push(normalizeBank(raw, '範例題庫'));
    rebuildItems();
    renderBankInfo();
  });
  $('#previewBtn').addEventListener('click', previewAll);
  for (const r of $$('input[name=countMode]')) r.addEventListener('change', updateDrawInfo);
  $('#totalCount').addEventListener('input', updateDrawInfo);
  $('#typeRows').addEventListener('input', e => {
    if (e.target.classList.contains('unl')) e.target.closest('tr').querySelector('.time').disabled = e.target.checked;
    updateDrawInfo();
  });
  $('#startBtn').addEventListener('click', async () => {
    const settings = readSettings();
    if (!S.room) {
      try { await createRoom(); } catch (err) {
        S.room = null;
        alert('無法連上即時同步資料庫，請確認 Firebase 的規則已經發布。\n（' + err.message + '）');
        return;
      }
    }
    newRound(settings);
    phase = 'idle';
    S.masks = {};
    if (S.round.steps.length === 0) { alert('沒有抽到題目，請檢查出題數量。'); return; }
    await S.db.set(`rooms/${S.room}/current`, { phase: 'waiting', round: S.round.no, total: S.round.steps.length });
    await S.db.remove(`rooms/${S.room}/scores`);
    showView('run');
    renderRun();
  });
  $('#joinToggle').addEventListener('click', () => {
    const p = $('#joinPanel');
    p.classList.toggle('hidden');
    $('#joinToggle').textContent = p.classList.contains('hidden') ? '加入資訊 ▾' : '加入資訊 ▴';
  });
  $('#joinPanel').addEventListener('click', e => { if (!e.target.closest('select, label, button')) $('#joinToggle').click(); });
  $('#nextBtn').addEventListener('click', next);
  $('#penAllBtn').addEventListener('click', async () => {
    S.pen = { all: !S.pen.all, by: {} };
    S.db.set(`rooms/${S.room}/pen`, S.pen);
    // 有倒數的題目：暫停作答時倒數也停住，開放作答時從剩下的時間繼續
    if (phase === 'answering') {
      if (!S.pen.all && endsAt) {
        pausedLeft = Math.max(0, endsAt - S.db.now());
        endsAt = null;
        await S.db.update(`rooms/${S.room}/current`, { endsAt: null, pausedLeft });
      } else if (S.pen.all && pausedLeft !== null) {
        endsAt = S.db.now() + pausedLeft;
        pausedLeft = null;
        await S.db.update(`rooms/${S.room}/current`, { endsAt, pausedLeft: null });
      }
      renderRun();
    }
    renderPenAll();
    renderGrid();
  });
  fillThemeSelects();
  fillVoiceSelects();
  // 語音清單在部分瀏覽器要等一下才會載入好
  if (window.speechSynthesis) speechSynthesis.addEventListener('voiceschanged', fillVoiceSelects);
  document.addEventListener('click', e => {
    if (!e.target.closest('.voice-test')) return;
    e.stopPropagation();
    speakSample();
  }, true);
  $('#endBtn').addEventListener('click', async () => {
    if (phase !== 'answering') return;
    if (await confirmBox('<h2>要結束這一題的作答嗎？</h2><p>結束後學生就不能再修改，畫面會公布答案。</p>', '確認結束本題作答', { danger: true })) endStep();
  });
  $('#hintBtn').addEventListener('click', toggleHints);
  $('#radicalBtn').addEventListener('click', toggleRadical);
  $('#readBtn').addEventListener('click', () => readQuestion());
  $('#scoreBtn').addEventListener('click', () => { S.scoreOpen = !S.scoreOpen; renderScorePanel(); });
  $('#scorePanel').addEventListener('click', e => { if (e.target.closest('[data-close]')) { S.scoreOpen = false; renderScorePanel(); } });
  $('#reviewBtn').addEventListener('click', openReview);
  $('#extendBox').addEventListener('click', async e => {
    const add = Number(e.target.dataset.add);
    if (!add || phase !== 'answering') return;
    if (pausedLeft !== null) {
      pausedLeft += add * 1000;
      await S.db.update(`rooms/${S.room}/current`, { pausedLeft });
    } else {
      if (!endsAt) return;
      endsAt += add * 1000;
      await S.db.update(`rooms/${S.room}/current`, { endsAt });
    }
    renderTimer();
  });
  $('#earlyEnd').addEventListener('click', async () => {
    const ok = await confirmBox('<h2>要提早結束所有題目嗎？</h2><p>後面還沒出的題目都不會再出，分數只用已經出過的題目計算。</p>', '確認結束所有題目作答', { danger: true });
    if (ok) finishRound();
  });
  $('#showAll').addEventListener('click', () => { S.defaultMask = false; S.masks = {}; renderGrid(); });
  $('#maskAll').addEventListener('click', () => { S.defaultMask = true; S.masks = {}; renderGrid(); });
  $('#grid').addEventListener('click', e => {
    const tile = e.target.closest('.tile');
    if (!tile) return;
    const sid = tile.dataset.sid;
    if (e.target.closest('[data-pen]')) {
      const on = !penOn(sid);
      S.pen.by = { ...(S.pen.by || {}), [sid]: on };
      S.db.set(`rooms/${S.room}/pen/by/${sid}`, on);
      renderGrid();
      return;
    }
    if (e.target.closest('[data-collab]')) { openCollab(sid); return; }
    const cbtn = e.target.closest('[data-cmark]');
    if (cbtn) {
      const Q = S.round.questions[cbtn.closest('.tile-mark').dataset.key];
      setCellMark(Q, sid, Number(cbtn.dataset.i), cbtn.dataset.cmark === '1');
      renderGrid();
      renderQPanel();
      return;
    }
    const btn = e.target.closest('[data-mark]');
    if (btn) {
      const Q = S.round.questions[btn.parentElement.dataset.key];
      Q.marks[sid] = btn.dataset.mark === '1';
      delete Q.cellMarks[sid];
      renderGrid();
      renderQPanel();
      return;
    }
    S.masks[sid] = !(S.masks[sid] ?? S.defaultMask);
    renderGrid();
  });
  $('#qPanel').addEventListener('click', e => {
    const fs = e.target.closest('[data-fs]');
    if (fs) { changeFont(fs.dataset.fs, Number(fs.dataset.d)); return; }
    const sp = e.target.closest('[data-speak]');
    if (sp) { readQuestion(sp.dataset.speak); return; }
    if (e.target.id === 'peekBtn') { S.showAnswer = !S.showAnswer; renderQPanel(); return; }
    if (e.target.id === 'guideBtn') {
      S.guide = !S.guide;
      S.db.update(`rooms/${S.room}/current`, { guide: S.guide });
      renderQPanel(); renderGrid();
      return;
    }
    if (e.target.id === 'allRight') {
      for (const k of gradeKeys(current())) {
        const Q = S.round.questions[k];
        for (const sid of Q.participants) {
          if (Q.marks[sid] !== undefined) continue;
          // 手寫題已經批了幾個字：沒批的字標對，批過的維持老師的判斷
          if (perCell(Q) && Q.cellMarks[sid]) cellMarksOf(Q, sid).forEach((m, i) => { if (m === undefined) setCellMark(Q, sid, i, true); });
          else Q.marks[sid] = true;
        }
      }
      renderGrid(); renderQPanel();
      return;
    }
    const sub = e.target.closest('[data-sub]');
    if (sub) { S.subTab = sub.dataset.sub === 'follow' ? 'follow' : Number(sub.dataset.sub); renderQPanel(); renderGrid(); }
  });
  new ResizeObserver(() => layoutGrid(Object.keys(S.students).length)).observe($('#grid'));
  new ResizeObserver(() => { $('#qPanel').lastHtml = ''; renderQPanel(); }).observe($('#qPanel'));
  enableImageZoom(document.body);
}

async function init() {
  applyTheme(S.theme);
  S.db = await openDb();
  if (S.db.mode === 'local') {
    const note = $('#modeNote');
    note.classList.remove('hidden');
    note.textContent = '目前是單機測試模式：學生畫面只能在這台電腦的其他瀏覽器分頁打開。正式上課需要先完成 Firebase 設定。';
  }
  bind();
}

init();
