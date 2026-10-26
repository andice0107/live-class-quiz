// 共用小工具
export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 題目文字保留換行
export function textHtml(s) {
  return esc(s).replace(/\n/g, '<br>');
}

export function randomString(n, alphabet = 'abcdefghjkmnpqrstuvwxyz23456789') {
  const buf = new Uint32Array(n);
  crypto.getRandomValues(buf);
  return [...buf].map(x => alphabet[x % alphabet.length]).join('');
}

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export async function sha256(s) {
  const data = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function fmtTime(sec) {
  sec = Math.max(0, Math.ceil(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function throttle(fn, ms) {
  let last = 0, timer = null, pending = null;
  return (...args) => {
    pending = args;
    const wait = ms - (Date.now() - last);
    if (wait <= 0) {
      last = Date.now();
      fn(...pending);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn(...pending);
      }, wait);
    }
  };
}

// 學生代號只允許英文與數字
export const ID_PATTERN = /^[A-Za-z0-9]{1,12}$/;
export const stripNonAlnum = s => s.replace(/[^A-Za-z0-9]/g, '').slice(0, 12);

export function showModal(html) {
  const wrap = document.createElement('div');
  wrap.className = 'modal';
  wrap.innerHTML = `<div class="modal-box"><button class="modal-close" aria-label="關閉">✕</button><div class="modal-body">${html}</div></div>`;
  wrap.addEventListener('click', e => {
    if (e.target === wrap || e.target.classList.contains('modal-close')) wrap.remove();
  });
  document.body.append(wrap);
  return wrap;
}

// 點圖片放大
export function enableImageZoom(root) {
  root.addEventListener('click', e => {
    const img = e.target.closest('img.q-img');
    if (img) showModal(`<img class="zoom-img" src="${img.src}" alt="">`);
  });
}
