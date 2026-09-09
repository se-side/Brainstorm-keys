// 音は全てここで合成する。音源ファイルは持たない。
// - キー音は「入力が通った」唯一の確認手段なので、最短経路で鳴らす。
// - 状態音（送信・考え中・完了）は画面の代わりに状態を伝える。

let ctx = null;
let master, gKey, gUi, gAmb;
let noiseBuf = null;
let silentEl = null;
let voices = 0; // 同時発音数。連打で音が濁るのを防ぐ

const MAX_VOICES = 14;

export const volumes = { key: 0.5, ui: 0.6, ambient: 0.5 };

function silentWavUrl(seconds = 2) {
  // 消音スイッチ対策。無音を再生し続けてオーディオセッションを playback に寄せる。
  const rate = 8000, n = rate * seconds, bytes = 44 + n * 2;
  const buf = new ArrayBuffer(bytes), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, bytes - 8, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

export function isReady() { return !!ctx && ctx.state === 'running'; }

export async function unlock() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('Web Audio API が使えません');
    ctx = new AC();

    master = ctx.createGain(); master.gain.value = 1; master.connect(ctx.destination);
    gKey = ctx.createGain(); gKey.gain.value = volumes.key; gKey.connect(master);
    gUi = ctx.createGain(); gUi.gain.value = volumes.ui; gUi.connect(master);
    gAmb = ctx.createGain(); gAmb.gain.value = 0; gAmb.connect(master);

    const n = ctx.sampleRate;
    noiseBuf = ctx.createBuffer(1, n, n);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state !== 'running') await ctx.resume();

  if (!silentEl) {
    silentEl = new Audio(silentWavUrl());
    silentEl.loop = true;
    silentEl.volume = 0.001;
    silentEl.setAttribute('playsinline', '');
  }
  try { await silentEl.play(); } catch { /* 消音対策は失敗しても本体は動かす */ }
}

export function setVolume(name, value) {
  volumes[name] = value;
  if (!ctx) return;
  if (name === 'key') gKey.gain.value = value;
  if (name === 'ui') gUi.gain.value = value;
  if (name === 'ambient' && ambient) gAmb.gain.setTargetAtTime(value * 0.09, ctx.currentTime, 0.2);
}

// --- 部品 -----------------------------------------------------------------

function env(node, t, { attack = 0.002, decay = 0.08, peak = 1 }) {
  const g = node.gain;
  g.setValueAtTime(0.0001, t);
  g.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
  g.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

function track(stopAt) {
  voices++;
  const ms = Math.max(0, (stopAt - ctx.currentTime) * 1000) + 60;
  setTimeout(() => { voices--; }, ms);
}

function tone({ dest = gUi, type = 'sine', f0, f1, at = 0, attack = 0.004, decay = 0.12, peak = 0.5 }) {
  const t = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(f0, t);
  if (f1 && f1 !== f0) osc.frequency.exponentialRampToValueAtTime(f1, t + attack + decay);
  env(g, t, { attack, decay, peak });
  osc.connect(g).connect(dest);
  osc.start(t); osc.stop(t + attack + decay + 0.02);
  track(t + attack + decay);
}

function noise({ dest = gUi, at = 0, freq = 1800, q = 1.2, attack = 0.001, decay = 0.03, peak = 0.4, freqTo = null }) {
  const t = ctx.currentTime + at;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.Q.value = q;
  bp.frequency.setValueAtTime(freq, t);
  if (freqTo) bp.frequency.exponentialRampToValueAtTime(freqTo, t + attack + decay);
  const g = ctx.createGain();
  env(g, t, { attack, decay, peak });
  src.connect(bp).connect(g).connect(dest);
  src.start(t, Math.random() * 0.5); src.stop(t + attack + decay + 0.02);
  track(t + attack + decay);
}

// --- 打鍵音 ---------------------------------------------------------------

const KEY_SOUNDS = {
  // 通常キーはピッチをわずかに揺らして、機械的な連打感を消す
  normal:    () => { const r = 0.94 + Math.random() * 0.12;
                     noise({ dest: gKey, freq: 1900 * r, decay: 0.026, peak: 0.30 });
                     tone({ dest: gKey, type: 'triangle', f0: 210 * r, decay: 0.035, peak: 0.16 }); },
  space:     () => { noise({ dest: gKey, freq: 950, q: 0.9, decay: 0.045, peak: 0.28 });
                     tone({ dest: gKey, type: 'sine', f0: 140, decay: 0.07, peak: 0.22 }); },
  enter:     () => { tone({ dest: gKey, type: 'sine', f0: 620, decay: 0.06, peak: 0.22 });
                     tone({ dest: gKey, type: 'sine', f0: 930, at: 0.055, decay: 0.10, peak: 0.20 }); },
  backspace: () => { noise({ dest: gKey, freq: 1200, freqTo: 500, decay: 0.05, peak: 0.22 });
                     tone({ dest: gKey, type: 'triangle', f0: 300, f1: 190, decay: 0.06, peak: 0.16 }); },
  punct:     () => { noise({ dest: gKey, freq: 2600, q: 2.5, decay: 0.02, peak: 0.18 });
                     tone({ dest: gKey, type: 'sine', f0: 520, decay: 0.03, peak: 0.10 }); },
};

export function key(kind = 'normal') {
  if (!isReady() || voices > MAX_VOICES) return;
  (KEY_SOUNDS[kind] || KEY_SOUNDS.normal)();
}

// --- 状態音 ---------------------------------------------------------------

export const cue = {
  // 送信：上向きのスワイプ。「飛んでいった」感
  send() { if (!isReady()) return;
    tone({ type: 'sine', f0: 320, f1: 1250, attack: 0.01, decay: 0.20, peak: 0.34 });
    noise({ freq: 700, freqTo: 4200, q: 0.7, attack: 0.01, decay: 0.20, peak: 0.16 }); },

  // 回答到着：柔らかいベル
  done() { if (!isReady()) return;
    tone({ type: 'sine', f0: 880, attack: 0.005, decay: 0.75, peak: 0.26 });
    tone({ type: 'sine', f0: 1320, attack: 0.005, decay: 0.45, peak: 0.11 });
    tone({ type: 'sine', f0: 2640, attack: 0.004, decay: 0.20, peak: 0.04 }); },

  // エラー：低い2連音
  error() { if (!isReady()) return;
    tone({ type: 'square', f0: 165, decay: 0.16, peak: 0.16 });
    tone({ type: 'square', f0: 130, at: 0.19, decay: 0.24, peak: 0.16 }); },

  // 消去：下向きのスワイプ
  clear() { if (!isReady()) return;
    tone({ type: 'sine', f0: 900, f1: 180, attack: 0.008, decay: 0.28, peak: 0.30 });
    noise({ freq: 3600, freqTo: 500, q: 0.7, attack: 0.008, decay: 0.28, peak: 0.14 }); },

  // 消去の1回目：まだ実行していない、という含みのある中立な2連ティック
  confirm() { if (!isReady()) return;
    tone({ type: 'triangle', f0: 700, decay: 0.05, peak: 0.22 });
    tone({ type: 'triangle', f0: 700, at: 0.11, decay: 0.05, peak: 0.22 }); },

  // 停止：短い減衰音
  stop() { if (!isReady()) return;
    tone({ type: 'sine', f0: 400, f1: 260, attack: 0.004, decay: 0.10, peak: 0.24 }); },

  // 復帰（Undo・清書完了）：上向きの2音
  restore() { if (!isReady()) return;
    tone({ type: 'triangle', f0: 520, decay: 0.09, peak: 0.20 });
    tone({ type: 'triangle', f0: 780, at: 0.09, decay: 0.16, peak: 0.20 }); },
};

// --- 考え中のアンビエント -------------------------------------------------
// 鳴り止まないこと自体が「まだ待っている」の合図になるので、
// 長時間聴いても疲れない音量・音色にする。

let ambient = null;

export function thinkingStart() {
  if (!isReady() || ambient) return;
  const t = ctx.currentTime;

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 420; lp.Q.value = 0.6;
  lp.connect(gAmb);

  const oscs = [
    { type: 'triangle', f: 110.0, g: 0.5 },
    { type: 'triangle', f: 110.7, g: 0.5 },  // わずかにデチューンして揺らぎを作る
    { type: 'sine', f: 220.0, g: 0.18 },
    { type: 'sine', f: 165.0, g: 0.12 },
  ].map(({ type, f, g }) => {
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = f;
    const vg = ctx.createGain(); vg.gain.value = g;
    o.connect(vg).connect(lp); o.start(t);
    return o;
  });

  // ごく微かな息づかい
  const nz = ctx.createBufferSource(); nz.buffer = noiseBuf; nz.loop = true;
  const nzg = ctx.createGain(); nzg.gain.value = 0.05;
  nz.connect(nzg).connect(lp); nz.start(t);

  // ゆっくりした脈動
  const lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.22;
  const lfoGain = ctx.createGain(); lfoGain.gain.value = 0.35;
  lfo.connect(lfoGain).connect(gAmb.gain); lfo.start(t);

  // 音色もゆっくり動かす（同じ音がずっと鳴っている感じを避ける）
  const flfo = ctx.createOscillator(); flfo.type = 'sine'; flfo.frequency.value = 0.09;
  const flfoGain = ctx.createGain(); flfoGain.gain.value = 150;
  flfo.connect(flfoGain).connect(lp.frequency); flfo.start(t);

  gAmb.gain.cancelScheduledValues(t);
  gAmb.gain.setValueAtTime(0.0001, t);
  gAmb.gain.linearRampToValueAtTime(volumes.ambient * 0.09, t + 0.7);

  ambient = { nodes: [...oscs, nz, lfo, flfo] };
}

export function thinkingStop() {
  if (!ctx || !ambient) return;
  const t = ctx.currentTime;
  const a = ambient;
  ambient = null;
  gAmb.gain.cancelScheduledValues(t);
  gAmb.gain.setValueAtTime(Math.max(gAmb.gain.value, 0.0001), t);
  gAmb.gain.linearRampToValueAtTime(0.0001, t + 0.5);
  setTimeout(() => { for (const n of a.nodes) { try { n.stop(); } catch {} } }, 700);
}
