// 即時同步層：有 Firebase 設定時用 Firebase Realtime Database，
// 沒有設定時用「單機測試模式」（同一台電腦、同一個瀏覽器的多個分頁互相同步）。
import { FIREBASE_CONFIG } from './config.js';

const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';

export async function openDb() {
  if (FIREBASE_CONFIG && FIREBASE_CONFIG.databaseURL) return firebaseDb();
  return localDb();
}

async function firebaseDb() {
  const appM = await import(FB + 'firebase-app.js');
  const d = await import(FB + 'firebase-database.js');
  const app = appM.initializeApp(FIREBASE_CONFIG);
  const db = d.getDatabase(app);
  const r = p => d.ref(db, p);
  let offset = 0;
  d.onValue(r('.info/serverTimeOffset'), s => { offset = s.val() || 0; });
  return {
    mode: 'firebase',
    set: (p, v) => d.set(r(p), v),
    update: (p, v) => d.update(r(p), v),
    remove: p => d.remove(r(p)),
    get: async p => (await d.get(r(p))).val(),
    on: (p, cb) => d.onValue(r(p), s => cb(s.val())),
    onDisconnectSet: (p, v) => d.onDisconnect(r(p)).set(v),
    onDisconnectRemove: p => d.onDisconnect(r(p)).remove(),
    onConnected: cb => d.onValue(r('.info/connected'), s => cb(!!s.val())),
    now: () => Date.now() + offset,
  };
}

function localDb() {
  const KEY = 'lcq-local-db';
  const subs = new Set();
  const parts = p => p.split('/').filter(Boolean);
  const load = () => {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
  };
  const getAt = (t, p) => parts(p).reduce((o, k) => (o == null ? null : (o[k] ?? null)), t);
  const setAt = (t, p, v) => {
    const ks = parts(p);
    let o = t;
    for (let i = 0; i < ks.length - 1; i++) {
      if (typeof o[ks[i]] !== 'object' || o[ks[i]] === null) o[ks[i]] = {};
      o = o[ks[i]];
    }
    const last = ks[ks.length - 1];
    if (v === null || v === undefined) delete o[last];
    else o[last] = JSON.parse(JSON.stringify(v));
  };
  let scheduled = false;
  const notify = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      const t = load();
      for (const s of subs) {
        const v = getAt(t, s.p);
        const json = JSON.stringify(v);
        if (json !== s.last) { s.last = json; s.cb(v); }
      }
    });
  };
  const write = fn => {
    const t = load();
    fn(t);
    localStorage.setItem(KEY, JSON.stringify(t));
    notify();
    return Promise.resolve();
  };
  window.addEventListener('storage', e => { if (e.key === KEY) notify(); });
  return {
    mode: 'local',
    set: (p, v) => write(t => setAt(t, p, v)),
    update: (p, obj) => write(t => { for (const [k, v] of Object.entries(obj)) setAt(t, p + '/' + k, v); }),
    remove: p => write(t => setAt(t, p, null)),
    get: async p => getAt(load(), p),
    on: (p, cb) => {
      const s = { p, cb, last: undefined };
      subs.add(s);
      notify();
      return () => subs.delete(s);
    },
    onDisconnectSet: () => {},
    onDisconnectRemove: () => {},
    onConnected: cb => cb(true),
    now: () => Date.now(),
  };
}
