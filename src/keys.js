// キー入力の解釈。修飾キーは Ctrl に統一する（Cmd系はSafariに奪われやすい）。

const MAP_STORE = 'bk.keymap.v1';

// Ctrl + このキー → コマンド名
export const DEFAULT_MAP = {
  'Enter': 'ask',
  's': 'summarize',
  'f': 'fix',
  'q': 'quick',
  'r': 'repeat',
  'l': 'tail',
  '.': 'stop',
  'k': 'clear',
  'z': 'undo',
  '/': 'help',
};

export function keymap() {
  // UIは未実装。当面は localStorage に上書きを置いて差し替える。
  let override = {};
  try { override = JSON.parse(localStorage.getItem(MAP_STORE) || '{}'); } catch {}
  return { ...DEFAULT_MAP, ...override };
}

const PUNCT = new Set(['.', ',', '!', '?', ';', ':', '。', '、', '！', '？']);

function soundKind(e) {
  if (e.key === ' ') return 'space';
  if (e.key === 'Enter') return 'enter';
  if (e.key === 'Backspace') return 'backspace';
  if (PUNCT.has(e.key)) return 'punct';
  return 'normal';
}

function typingInUI() {
  const a = document.activeElement;
  if (!a) return false;
  const tag = a.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || a.isContentEditable;
}

/**
 * @param {object} h ハンドラ群
 *   h.onFirstKey()          最初の打鍵（音声の解錠に使う）
 *   h.onChar(ch, kind)      文字入力
 *   h.onBackspace()         1文字削除
 *   h.onNewline()           改行
 *   h.onCommand(name)       ショートカット
 *   h.onIgnored(e)          解釈できなかったキー（ログ用）
 */
export function attach(h) {
  let first = true;

  window.addEventListener('keydown', (e) => {
    if (typingInUI()) return;          // 設定パネル入力中は素通しする
    if (e.isComposing || e.keyCode === 229) return; // IMEが動いている間は触らない

    if (first) { first = false; h.onFirstKey?.(); }

    const mod = e.ctrlKey || e.metaKey;

    if (mod) {
      if (e.altKey) return;
      const map = keymap();
      const cmd = map[e.key] ?? map[e.key.toLowerCase()];
      if (cmd) {
        e.preventDefault();
        h.onCommand?.(cmd);
      } else {
        h.onIgnored?.(e);
      }
      return;
    }

    if (e.altKey) return;

    switch (e.key) {
      case 'Backspace':
        e.preventDefault();
        h.onBackspace?.();
        return;
      case 'Enter':
        e.preventDefault();
        h.onNewline?.();
        return;
      case 'Tab':
        e.preventDefault();
        h.onChar?.('\t', 'normal');
        return;
      case ' ':
        e.preventDefault();  // ページのスクロールを止める
        h.onChar?.(' ', 'space');
        return;
    }

    if (e.key.length === 1) {
      h.onChar?.(e.key, soundKind(e));
      return;
    }

    h.onIgnored?.(e);
  }, { capture: true });
}
