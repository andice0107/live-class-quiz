// 畫面主題：護眼（深色）、馬卡龍、淡雅鵝黃
export const THEMES = {
  dark: '護眼模式',
  macaron: '馬卡龍',
  cream: '淡雅鵝黃',
};
const KEY = 'lcq-theme';

export function applyTheme(name) {
  if (!THEMES[name]) name = 'dark';
  document.documentElement.dataset.theme = name;
  return name;
}

export function savedTheme() {
  try { return localStorage.getItem(KEY) || 'dark'; } catch { return 'dark'; }
}

export function saveTheme(name) {
  try { localStorage.setItem(KEY, name); } catch { /* 無痕模式等情況存不了也沒關係 */ }
}
