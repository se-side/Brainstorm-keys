// テキストバッファ。打鍵ごとに localStorage へ保存し、落ちても失わない。

const KEY = 'bk.buffer.v1';
const UNDO_LIMIT = 20;

let text = '';
let undoStack = [];
let saveTimer = null;
let listeners = [];

export function load() {
  try { text = localStorage.getItem(KEY) || ''; } catch { text = ''; }
  emit();
  return text;
}

function emit() { for (const fn of listeners) fn(text); }
export function onChange(fn) { listeners.push(fn); fn(text); }

function save(immediate = false) {
  const write = () => { try { localStorage.setItem(KEY, text); } catch {} };
  clearTimeout(saveTimer);
  if (immediate) write(); else saveTimer = setTimeout(write, 250);
}

function snapshot() {
  undoStack.push(text);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}

export function get() { return text; }
export function length() { return text.length; }
export function isEmpty() { return text.trim().length === 0; }

export function append(ch) { text += ch; save(); emit(); }

export function backspace() {
  if (!text) return false;
  // サロゲートペア・結合文字をまとめて1文字として消す
  const chars = Array.from(text);
  chars.pop();
  text = chars.join('');
  save(); emit();
  return true;
}

// 破壊的な操作（消去・清書）だけ Undo の対象にする
export function replace(next) { snapshot(); text = String(next); save(true); emit(); }
export function clear() { snapshot(); text = ''; save(true); emit(); }

export function canUndo() { return undoStack.length > 0; }
export function undo() {
  if (!undoStack.length) return false;
  text = undoStack.pop();
  save(true); emit();
  return true;
}

// 「今どこまで書いたか」の確認用に、末尾の一文を返す
export function lastSentence() {
  const t = text.trim();
  if (!t) return '';
  // ローマ字でブラインド入力するので、文末は ASCII の "." になることが多い。
  // ただし小数などで切らないよう、"." は後ろに空白が続くときだけ区切りとみなす。
  const parts = t.split(/(?<=[。．！？!?\n])|(?<=\.)(?=\s)/).map(s => s.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : t;
}

export function tail(n = 240) {
  return text.length > n ? '…' + text.slice(-n) : text;
}
