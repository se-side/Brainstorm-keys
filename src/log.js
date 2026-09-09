// Macが無いとSafariのインスペクタが使えないので、画面内をコンソール代わりにする。

const MAX_LINES = 200;
let el = null;
const lines = [];

export function mount(node) {
  el = node;
  render();
}

function render() {
  if (!el) return;
  el.textContent = lines.join('\n');
  el.scrollTop = el.scrollHeight;
}

function push(level, args) {
  const t = new Date().toTimeString().slice(0, 8);
  const msg = args.map(a => {
    if (a instanceof Error) return a.message;
    if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
    return String(a);
  }).join(' ');
  lines.push(`${t} ${level} ${msg}`);
  if (lines.length > MAX_LINES) lines.shift();
  render();
}

export const log  = (...a) => push('·', a);
export const warn = (...a) => push('!', a);
export const err  = (...a) => push('×', a);

// 拾えなかった例外も画面に出す
export function captureGlobalErrors(onFatal) {
  window.addEventListener('error', (e) => {
    err(e.message || 'エラー');
    onFatal?.(e.message || 'エラーが起きました');
  });
  window.addEventListener('unhandledrejection', (e) => {
    const m = e.reason?.message || String(e.reason || '');
    err('未処理:', m);
    onFatal?.(m || 'エラーが起きました');
  });
}
