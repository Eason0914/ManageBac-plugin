// 界面小工具（面板与设置页共用）

/** h('div', {class:'x', onclick}, child, ...) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

let toastTimer;
export function toast(msg, { error = false, ms = 3500 } = {}) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('error', error);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/** 科目 → 稳定的颜色 */
export function subjectHue(s) {
  let x = 0;
  for (const ch of String(s || '')) x = (x * 31 + ch.codePointAt(0)) >>> 0;
  return x % 360;
}

export function stripHtml(s) {
  // DOMParser 生成的是惰性文档，不会加载图片或执行任何内容
  const html = String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}
