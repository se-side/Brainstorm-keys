// 読み上げ。回答は「耳で聴くもの」なので、文が閉じた端から喋り始める。

let voice = null;
let voicesLoaded = false;

export const settings = { rate: 1.15, pitch: 1.0, volume: 1.0 };

let onStateChange = () => {};
export function onState(fn) { onStateChange = fn; }

let speaking = 0; // 発話中のutterance数

export function available() { return 'speechSynthesis' in window; }
export function isSpeaking() { return speaking > 0; }

function pickVoice() {
  const all = speechSynthesis.getVoices();
  if (!all.length) return null;
  const ja = all.filter(v => /^ja(-|_|$)/i.test(v.lang));
  // Kyoko（iOS標準の日本語音声）を優先。無ければ最初の日本語音声。
  return ja.find(v => /kyoko/i.test(v.name)) || ja[0] || null;
}

export function loadVoices() {
  if (!available()) return;
  voice = pickVoice();
  voicesLoaded = !!voice;
  // iOSでは voices が非同期に来るので、変化したら取り直す
  speechSynthesis.onvoiceschanged = () => {
    voice = pickVoice();
    voicesLoaded = !!voice;
  };
}

export function voiceName() { return voice ? `${voice.name} (${voice.lang})` : '未取得'; }

export function speak(text) {
  if (!available()) return;
  const t = String(text || '').trim();
  if (!t) return;
  if (!voicesLoaded) loadVoices();

  const u = new SpeechSynthesisUtterance(t);
  if (voice) u.voice = voice;
  u.lang = voice ? voice.lang : 'ja-JP';
  u.rate = settings.rate;
  u.pitch = settings.pitch;
  u.volume = settings.volume;

  u.onstart = () => { speaking++; onStateChange(true); };
  const end = () => { speaking = Math.max(0, speaking - 1); if (!speaking) onStateChange(false); };
  u.onend = end;
  u.onerror = end;

  speechSynthesis.speak(u);
}

export function stop() {
  if (!available()) return;
  speechSynthesis.cancel();
  speaking = 0;
  onStateChange(false);
}

// ストリーミング用。文が閉じた分だけ順に読み上げていく。
export function createSentenceSpeaker() {
  let pending = '';
  const BREAK = /[。．！？!?\n]/;

  const flushClosed = () => {
    // 句点等で切れる位置まで取り出す
    for (;;) {
      const m = pending.match(BREAK);
      if (!m) break;
      const at = m.index + m[0].length;
      const sentence = pending.slice(0, at).trim();
      pending = pending.slice(at);
      if (sentence) speak(sentence);
    }
  };

  return {
    push(delta) { pending += delta; flushClosed(); },
    finish() { const rest = pending.trim(); pending = ''; if (rest) speak(rest); },
    discard() { pending = ''; },
  };
}
