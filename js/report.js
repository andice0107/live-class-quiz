// 成績畫面與試算表匯出
import { TYPES, answerText, questionHtml, passageHtml, optionsHtml, letter } from './bank.js';
import { $, esc, textHtml, showModal } from './util.js';

export function computeScores(S, r) {
  const out = {};
  for (const sid of Object.keys(S.students)) {
    let correct = 0, total = 0;
    for (const k of r.givenKeys || []) {
      const Q = r.questions[k];
      if (!Q.participants.includes(sid)) continue;
      total++;
      if (Q.marks[sid] === true) correct++;
    }
    out[sid] = { correct, total, score: total ? Math.round(correct / total * 100) : 0 };
  }
  return out;
}

// 每題的統計：答對率、平均作答秒數、未作答人數
export function questionStats(S, r, k) {
  const Q = r.questions[k];
  const step = r.steps[Q.step];
  const ans = S.answers[k] || {};
  let right = 0, blank = 0, secs = 0, timed = 0;
  for (const sid of Q.participants) {
    if (Q.marks[sid] === true) right++;
    const a = ans[sid];
    if (!a || a.v === undefined || a.v === null || a.v === '') blank++;
    else if (a.at && step.startedAt) { secs += (a.at - step.startedAt) / 1000; timed++; }
  }
  const n = Q.participants.length;
  return {
    n, right, blank,
    rate: n ? Math.round(right / n * 100) : null,
    avgSec: timed ? Math.round(secs / timed) : null,
  };
}

function sortedSids(S) {
  return Object.keys(S.students).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

export function renderSummary(S, { onToggle, onNextRound }) {
  const r = S.round;
  const root = $('#summary');
  const draw = () => {
    const keys = r.givenKeys;
    const scores = computeScores(S, r);
    const sids = sortedSids(S).filter(sid => scores[sid].total > 0);
    const vals = sids.map(s => scores[s].score);
    const avg = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
    const stats = Object.fromEntries(keys.map(k => [k, questionStats(S, r, k)]));
    const pending = keys.reduce((n, k) => n + r.questions[k].participants.filter(s => r.questions[k].marks[s] === undefined).length, 0);
    const hardest = [...keys].filter(k => stats[k].rate !== null).sort((a, b) => stats[a].rate - stats[b].rate).slice(0, 3);
    const early = keys.length < r.order.length;

    root.innerHTML = `
      <header class="sum-head">
        <h1>第 ${r.no} 份題組成績</h1>
        <span class="spacer"></span>
        <button id="xlsxBtn" class="primary">下載成績試算表</button>
        <button id="againBtn">出下一份題組</button>
      </header>
      ${early ? `<p class="mode-note">提早結束：只計算已經出過的 ${keys.length} 題（原本 ${r.order.length} 題）。</p>` : ''}
      ${pending ? `<p class="mode-note">還有 ${pending} 格尚未批改（表格中的「？」），目前先算答錯。點格子可以改成對或錯，學生畫面上的分數會跟著更新。</p>` : ''}
      <div class="stat-cards">
        <div class="stat"><div class="muted">全班平均</div><div class="stat-num">${avg}</div></div>
        <div class="stat"><div class="muted">最高分</div><div class="stat-num">${vals.length ? Math.max(...vals) : '-'}</div></div>
        <div class="stat"><div class="muted">最低分</div><div class="stat-num">${vals.length ? Math.min(...vals) : '-'}</div></div>
        <div class="stat"><div class="muted">出題數</div><div class="stat-num">${keys.length}</div></div>
        <div class="stat wide"><div class="muted">答對率最低的題目</div><div>${hardest.map(k => `<button class="link" data-q="${k}">第 ${r.questions[k].label} 題（${stats[k].rate}%）</button>`).join('　') || '-'}</div></div>
      </div>
      <div class="table-wrap">
        <table class="score-table">
          <thead><tr><th>學生</th><th>分數</th><th>答對</th>${keys.map(k => `<th><button class="link" data-q="${k}" title="看完整題目">${r.questions[k].label}</button><div class="small muted">${TYPES[r.questions[k].q.type].label}</div></th>`).join('')}</tr></thead>
          <tbody>${sids.map(sid => `<tr><th>${esc(sid)}</th><td class="score">${scores[sid].score}</td><td>${scores[sid].correct}/${scores[sid].total}</td>${keys.map(k => cellHtml(r.questions[k], sid)).join('')}</tr>`).join('')}</tbody>
          <tfoot>
            <tr><th>答對率</th><td></td><td></td>${keys.map(k => `<td>${stats[k].rate ?? '-'}%</td>`).join('')}</tr>
            <tr><th>平均秒數</th><td></td><td></td>${keys.map(k => `<td>${stats[k].avgSec ?? '-'}</td>`).join('')}</tr>
            <tr><th>空白人數</th><td></td><td></td>${keys.map(k => `<td>${stats[k].blank}</td>`).join('')}</tr>
          </tfoot>
        </table>
      </div>`;
  };

  root.onclick = async e => {
    const q = e.target.closest('[data-q]');
    if (q) { showQuestion(S, r, q.dataset.q); return; }
    const cell = e.target.closest('td[data-k]');
    if (cell) {
      const Q = r.questions[cell.dataset.k];
      const sid = cell.dataset.sid;
      Q.marks[sid] = Q.marks[sid] !== true;
      draw();
      await onToggle();
      return;
    }
    if (e.target.id === 'xlsxBtn') exportXlsx(S, r);
    if (e.target.id === 'againBtn') onNextRound();
  };
  draw();
}

function cellHtml(Q, sid) {
  if (!Q.participants.includes(sid)) return '<td class="na">—</td>';
  const m = Q.marks[sid];
  const cls = m === true ? 'ok' : m === false ? 'no' : 'pend';
  const sym = m === true ? '○' : m === false ? '✕' : '？';
  return `<td class="cell ${cls}" data-k="${Q.key}" data-sid="${esc(sid)}">${sym}</td>`;
}

function showQuestion(S, r, k) {
  const Q = r.questions[k];
  const step = r.steps[Q.step];
  const st = questionStats(S, r, k);
  const ans = S.answers[k] || {};
  const input = TYPES[Q.q.type].input;
  const answers = Q.participants.slice().sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).map(sid => {
    const a = ans[sid];
    const m = Q.marks[sid];
    let body = '<span class="muted">（空白）</span>';
    if (a && a.v !== undefined && a.v !== null && a.v !== '') {
      if (input === 'draw') body = `<img src="${a.v}" alt="">`;
      else if (input === 'choice') body = `<b>${letter(a.v)}</b>${a.submitted ? '' : ' <span class="muted small">（沒按確認）</span>'}`;
      else body = textHtml(a.v);
    }
    return `<div class="ans-card ${m === true ? 'ok' : m === false ? 'no' : ''}"><div class="ans-sid">${esc(sid)} ${m === true ? '○' : m === false ? '✕' : '？'}</div><div class="ans-body">${body}</div></div>`;
  }).join('');
  showModal(`
    ${step.item.type === 'group' ? `<details class="passage-box"><summary>題組文章</summary>${passageHtml(step.item)}</details>` : ''}
    ${questionHtml(Q.q, { label: `第 ${Q.label} 題` })}
    ${Q.q.type === 'choice' ? optionsHtml(Q.q, { correct: Q.q.answer }) : ''}
    <div class="answer-mid">答案：${textHtml(answerText(Q.q))}</div>
    <p>答對率 <b>${st.rate ?? '-'}%</b>（${st.right}/${st.n}）　平均作答 <b>${st.avgSec ?? '-'}</b> 秒　空白 <b>${st.blank}</b> 人</p>
    <div class="ans-grid">${answers}</div>`);
}

function exportXlsx(S, r) {
  if (!window.XLSX) { alert('試算表元件載入失敗，請確認網路後重新整理。'); return; }
  const keys = r.givenKeys;
  const scores = computeScores(S, r);
  const sids = sortedSids(S).filter(sid => scores[sid].total > 0);
  const head = ['學生代號', '分數', '答對題數', '作答題數', ...keys.map(k => `第${r.questions[k].label}題`)];
  const rows = sids.map(sid => [sid, scores[sid].score, scores[sid].correct, scores[sid].total, ...keys.map(k => {
    const Q = r.questions[k];
    if (!Q.participants.includes(sid)) return '—';
    return Q.marks[sid] === true ? '○' : Q.marks[sid] === false ? '✕' : '未批改';
  })]);
  const statRows = [
    ['答對率(%)', '', '', '', ...keys.map(k => questionStats(S, r, k).rate ?? '')],
    ['平均作答秒數', '', '', '', ...keys.map(k => questionStats(S, r, k).avgSec ?? '')],
  ];
  const ws1 = XLSX.utils.aoa_to_sheet([head, ...rows, [], ...statRows]);
  ws1['!cols'] = [{ wch: 12 }, { wch: 6 }, { wch: 8 }, { wch: 8 }, ...keys.map(() => ({ wch: 7 }))];

  const qHead = ['題號', '題型', '題目', '選項', '答案', '答對率(%)', '平均作答秒數', '空白人數', '題組文章'];
  const qRows = keys.map(k => {
    const Q = r.questions[k];
    const st = questionStats(S, r, k);
    const step = r.steps[Q.step];
    return [Q.label, TYPES[Q.q.type].label, Q.q.prompt + (Q.q.images?.length ? '（含圖片）' : ''),
      Q.q.options ? Q.q.options.map((o, i) => `${letter(i)}. ${o.text}`).join('\n') : '',
      answerText(Q.q), st.rate ?? '', st.avgSec ?? '', st.blank,
      step.item.type === 'group' ? step.item.passage : ''];
  });
  const ws2 = XLSX.utils.aoa_to_sheet([qHead, ...qRows]);
  ws2['!cols'] = [{ wch: 6 }, { wch: 8 }, { wch: 40 }, { wch: 30 }, { wch: 16 }, { wch: 9 }, { wch: 10 }, { wch: 8 }, { wch: 40 }];

  const ansHead = ['學生代號', ...keys.map(k => `第${r.questions[k].label}題`)];
  const ansRows = sids.map(sid => [sid, ...keys.map(k => {
    const a = (S.answers[k] || {})[sid];
    const input = TYPES[r.questions[k].q.type].input;
    if (!a || a.v === undefined || a.v === null || a.v === '') return '';
    if (input === 'draw') return '（手寫）';
    if (input === 'choice') return letter(a.v) + (a.submitted ? '' : '（未確認）');
    return String(a.v);
  })]);
  const ws3 = XLSX.utils.aoa_to_sheet([ansHead, ...ansRows]);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws1, '成績');
  XLSX.utils.book_append_sheet(wb, ws2, '題目與統計');
  XLSX.utils.book_append_sheet(wb, ws3, '學生作答內容');
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  XLSX.writeFile(wb, `成績_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}_第${r.no}份.xlsx`);
}
