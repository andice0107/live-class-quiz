// 讀取依「Word 題庫範本」格式寫成的 .docx
//
// 格式：
//   #寫國字            ← 「#」加題型，開始新的一題
//   題目：……           ← 題目文字（可以接好幾段，圖片直接貼在題目裡）
//   A. ……             ← 選擇題的選項（A～H）
//   答案：……
//   詳解：……           ← 可省略（也可寫「解析：」）
//   時間：30           ← 可省略，秒數
//   格數：2            ← 可省略，田字格數
//
//   #題組 閱讀測驗：小狗回家   ← 題組，後面可寫標題
//   文章：……
//   ##選擇題           ← 題組裡的小題用「##」
//   題目：……
//   #題組結束          ← 可省略，遇到下一個「#」也會自動結束

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const JSZIP = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml' };

function loadJsZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = JSZIP;
    s.onload = () => res(window.JSZip);
    s.onerror = () => rej(new Error('讀取 Word 的元件載入失敗，請確認網路後再試一次。'));
    document.head.append(s);
  });
}

async function toDataUrl(zip, path) {
  const ext = path.split('.').pop().toLowerCase();
  const mime = MIME[ext];
  if (!mime) return null;
  const b64 = await zip.file(path).async('base64');
  return `data:${mime};base64,${b64}`;
}

// 依文件順序取出每一段的文字與圖片
async function readParagraphs(file) {
  const JSZip = await loadJsZip();
  const zip = await JSZip.loadAsync(file);
  const docXml = await zip.file('word/document.xml')?.async('string');
  if (!docXml) throw new Error(`「${file.name}」打不開，請確認是 Word 的 .docx 檔。`);
  const relsXml = (await zip.file('word/_rels/document.xml.rels')?.async('string')) || '';
  const rels = {};
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0])?.[1];
    const target = /Target="([^"]+)"/.exec(m[0])?.[1];
    if (id && target) rels[id] = target.startsWith('/') ? target.slice(1) : 'word/' + target.replace(/^\.\//, '');
  }
  const doc = new DOMParser().parseFromString(docXml, 'application/xml');
  const paras = [];
  const skipped = [];
  for (const p of doc.getElementsByTagNameNS(W, 'p')) {
    let text = '';
    const images = [];
    const walk = async node => {
      for (const n of node.childNodes) {
        if (n.nodeType !== 1) continue;
        const ln = n.localName;
        if (ln === 't' && n.namespaceURI === W) text += n.textContent;
        else if (ln === 'tab' && n.namespaceURI === W) text += ' ';
        else if ((ln === 'br' || ln === 'cr') && n.namespaceURI === W) text += '\n';
        else if (ln === 'blip' || ln === 'imagedata') {
          const id = n.getAttributeNS(R, 'embed') || n.getAttributeNS(R, 'id');
          const path = rels[id];
          if (path && zip.file(path)) {
            const url = await toDataUrl(zip, path);
            if (url) images.push(url); else skipped.push(path.split('/').pop());
          }
        } else if (ln !== 'p') await walk(n);
      }
    };
    await walk(p);
    paras.push({ text: text.replace(/ /g, ' ').trim(), images });
  }
  return { paras, skipped };
}

const FIELD = /^(題目|問題|答案|解答|詳解|解析|時間|秒數|格數|文章|短文|標題)\s*[:：]\s*/;
const OPTION = /^([A-HＡ-Ｈ])\s*[.．、)）]\s*/;
const FIELD_KEY = { 題目: 'prompt', 問題: 'prompt', 答案: 'answer', 解答: 'answer', 詳解: 'explanation', 解析: 'explanation', 時間: 'time', 秒數: 'time', 格數: 'cells', 文章: 'passage', 短文: 'passage', 標題: 'title' };

export async function readDocxBank(file) {
  const { paras, skipped } = await readParagraphs(file);
  const items = [];
  const errors = [];
  let group = null;   // 目前的題組
  let cur = null;     // 目前在填的題目（單題或小題）
  let field = null;   // 目前在填哪個欄位（接續的段落會加到這裡）
  const target = () => cur || group;
  const append = (obj, key, text) => {
    if (!text) return;
    obj[key] = obj[key] ? `${obj[key]}\n${text}` : text;
  };

  for (const { text, images } of paras) {
    const head = /^(##|＃＃|#|＃)\s*(.*)$/.exec(text);
    if (head) {
      const isSub = head[1].length === 2;
      const name = head[2].trim();
      if (!isSub) {
        group = null;
        cur = null;
        field = null;
        if (/^題組結束/.test(name)) continue;
        if (/^(題組|閱讀測驗)/.test(name)) {
          group = { type: '題組', title: name.replace(/^(題組|閱讀測驗)\s*/, ''), passage: '', images: [], questions: [] };
          items.push(group);
          field = 'passage';
          continue;
        }
        cur = { type: name, prompt: '', images: [], options: [] };
        items.push(cur);
        field = 'prompt';
      } else {
        if (!group) { errors.push(`「${text}」前面沒有「#題組」，已當成一般題目。`); }
        cur = { type: name, prompt: '', images: [], options: [] };
        (group ? group.questions : items).push(cur);
        field = 'prompt';
      }
      continue;
    }
    const t = target();
    if (!t) {
      if (images.length || text) { /* 第一個「#」之前的內容（例如考卷標題）略過 */ }
      continue;
    }
    const f = FIELD.exec(text);
    if (f) {
      field = FIELD_KEY[f[1]];
      const rest = text.slice(f[0].length);
      if (field === 'passage' || field === 'title') { if (group && !cur) append(group, field, rest); else append(t, 'prompt', rest); }
      else if (field === 'time' || field === 'cells') { t[field] = Number(rest.replace(/[^\d]/g, '')) || undefined; field = null; }
      else append(t, field, rest);
      if (images.length) (field === 'passage' && group && !cur ? group.images : t.images).push(...images);
      continue;
    }
    const o = cur && OPTION.exec(text);
    if (o) {
      cur.options.push({ text: text.slice(o[0].length), image: images[0] || null });
      field = 'option';
      continue;
    }
    // 沒有標籤的段落：接到目前的欄位
    if (field === 'option' && cur.options.length) {
      const last = cur.options[cur.options.length - 1];
      if (text) last.text = last.text ? `${last.text}\n${text}` : text;
      if (images.length && !last.image) last.image = images[0];
      continue;
    }
    if (field === 'passage' && group && !cur) {
      append(group, 'passage', text);
      group.images.push(...images);
      continue;
    }
    if (field && field !== 'option') append(t, field, text);
    if (images.length) t.images.push(...images);
  }

  for (const it of items) {
    for (const q of it.questions || [it]) {
      if (!q.options || !q.options.length) delete q.options;
      if (q.images && !q.images.length) delete q.images;
    }
  }
  if (skipped.length) errors.push(`有 ${skipped.length} 張圖片是瀏覽器不能顯示的格式（${[...new Set(skipped)].join('、')}），請在 Word 裡把圖片另存成 PNG 或 JPG 後再貼回去。`);
  if (!items.length) errors.push('沒有找到題目。每一題的第一行要用「#」加題型開頭，例如「#寫國字」。');
  return { title: file.name.replace(/\.[^.]+$/, ''), items, errors };
}
