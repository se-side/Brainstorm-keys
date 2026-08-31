import * as audio from './audio.js';
import * as speech from './speech.js';
import * as buffer from './buffer.js';
import * as gemini from './gemini.js';
import * as keys from './keys.js';
import { log, warn, err, mount as mountLog, captureGlobalErrors } from './log.js';
import { MODES, HELP_TEXT } from './prompts.js';

const $ = (id) => document.getElementById(id);
const SETTINGS_STORE = 'bk.settings.v1';

let started = false;
let inflight = null;      // AbortController
let lastAnswer = '';
let clearArmedAt = 0;     // Ctrl+K の1回目
const CLEAR_WINDOW_MS = 2500;

// --- 状態表示 -------------------------------------------------------------

let state = 'idle';
const STATE_LABEL = {
  idle: '待機', sending: '送信', thinking: '考え中', speaking: '読み上げ中',
};

function setState(next) {
  state = next;
  $('status').textContent = STATE_LABEL[next] || next;
  document.body.dataset.state = next;
}

function renderBuffer(text) {
  $('count').textContent = `${text.length} 字`;
  $('tail').textContent = buffer.tail(240) || '（空）';
}

// --- 設定 -----------------------------------------------------------------

function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SETTINGS_STORE) || '{}'); } catch {}
  if (typeof s.rate === 'number') speech.settings.rate = s.rate;
  for (const k of ['key', 'ui', 'ambient']) {
    if (typeof s[`vol_${k}`] === 'number') audio.volumes[k] = s[`vol_${k}`];
  }
  return s;
}

function saveSettings() {
  const s = {
    rate: speech.settings.rate,
    vol_key: audio.volumes.key,
    vol_ui: audio.volumes.ui,
    vol_ambient: audio.volumes.ambient,
  };
  try { localStorage.setItem(SETTINGS_STORE, JSON.stringify(s)); } catch {}
}

// --- 画面ロック抑止 -------------------------------------------------------

let wakeLock = null;
async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
    log('画面ロックを抑止中');
  } catch (e) { warn('画面ロック抑止に失敗:', e.message); }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (started && !wakeLock) requestWakeLock();
    if (started) audio.unlock().catch(() => {});
  }
});

// --- AI 呼び出し ----------------------------------------------------------

function say(text) { speech.speak(text); }

function fail(message) {
  audio.thinkingStop();
  audio.cue.error();
  setState('idle');
  err(message);
  say(message);
}

async function run(modeName) {
  const mode = MODES[modeName];
  if (!mode) return;

  const text = buffer.get().trim();
  if (!text) {
    audio.cue.error();
    say('まだ何も書いていません');
    return;
  }
  const prompt = mode.prompt(modeName === 'quick' ? buffer.lastSentence() : text);
  if (!prompt.trim()) {
    audio.cue.error();
    say('送るものがありません');
    return;
  }

  // 走っているものがあれば捨てて、新しい思考を優先する
  if (inflight) inflight.abort();
  speech.stop();

  const ctrl = new AbortController();
  inflight = ctrl;

  audio.cue.send();
  setState('sending');
  audio.thinkingStart();
  setState('thinking');
  log(`${mode.label}: ${prompt.length}字を送信`);

  const speaker = mode.speak ? speech.createSentenceSpeaker() : null;
  let firstDelta = true;
  let answer = '';

  try {
    answer = await gemini.streamGenerate({
      system: mode.system,
      prompt,
      temperature: mode.temperature,
      maxTokens: mode.maxTokens,
      signal: ctrl.signal,
      onDelta: (d) => {
        if (firstDelta) {
          firstDelta = false;
          audio.thinkingStop();
          audio.cue.done();
        }
        speaker?.push(d);
      },
    });
    speaker?.finish();

    if (ctrl.signal.aborted) return;

    audio.thinkingStop();
    if (mode.speak) {
      lastAnswer = answer.trim();
      setState('speaking');
    } else {
      // 清書：バッファを置き換える
      buffer.replace(answer.trim());
      audio.cue.restore();
      say('整えました');
      setState('idle');
    }
    log(`${mode.label}: ${answer.length}字を受信`);
  } catch (e) {
    if (e.name === 'AbortError' || ctrl.signal.aborted) { log('中断しました'); return; }
    speaker?.discard();
    fail(e.message || '通信に失敗しました');
  } finally {
    if (inflight === ctrl) {
      inflight = null;
      audio.thinkingStop();
      if (!speech.isSpeaking() && state !== 'idle') setState('idle');
    }
  }
}

function stopEverything() {
  if (inflight) { inflight.abort(); inflight = null; }
  speech.stop();
  audio.thinkingStop();
  audio.cue.stop();
  setState('idle');
  log('停止');
}

// --- コマンド -------------------------------------------------------------

const COMMANDS = {
  ask: () => run('ask'),
  summarize: () => run('summarize'),
  quick: () => run('quick'),
  fix: () => run('fix'),

  repeat: () => {
    if (!lastAnswer) { audio.cue.error(); say('まだ答えはありません'); return; }
    speech.stop(); say(lastAnswer); setState('speaking');
  },

  tail: () => {
    const s = buffer.lastSentence();
    if (!s) { audio.cue.error(); say('まだ何も書いていません'); return; }
    speech.stop(); say(s); setState('speaking');
  },

  stop: stopEverything,

  clear: () => {
    const now = Date.now();
    if (now - clearArmedAt < CLEAR_WINDOW_MS) {
      clearArmedAt = 0;
      buffer.clear();
      audio.cue.clear();
      log('バッファを消去');
    } else {
      clearArmedAt = now;
      audio.cue.confirm();   // 1回目はまだ消していない
    }
  },

  undo: () => {
    if (buffer.undo()) { audio.cue.restore(); log('取り消し'); }
    else { audio.cue.error(); say('取り消せるものがありません'); }
  },

  help: () => { speech.stop(); say(HELP_TEXT); setState('speaking'); },
};

// --- 起動 -----------------------------------------------------------------

async function start() {
  if (started) return;
  started = true;
  $('overlay').hidden = true;

  try {
    await audio.unlock();
    log('オーディオ解錠');
  } catch (e) {
    err('オーディオを開始できません:', e.message);
  }

  speech.loadVoices();
  setTimeout(() => { $('voice').textContent = speech.voiceName(); }, 400);

  requestWakeLock();
  say('準備できました');
  audio.cue.restore();
  setState('idle');
}

function init() {
  mountLog($('log'));
  captureGlobalErrors((m) => { audio.cue.error(); });

  loadSettings();
  buffer.load();
  buffer.onChange(renderBuffer);

  speech.onState((isSpeaking) => {
    if (isSpeaking) setState('speaking');
    else if (!inflight && state === 'speaking') setState('idle');
  });

  if (!speech.available()) warn('この環境では読み上げが使えません');

  keys.attach({
    onFirstKey: () => { if (!started) start(); },
    onChar: (ch, kind) => { buffer.append(ch); audio.key(kind); },
    onBackspace: () => { if (buffer.backspace()) audio.key('backspace'); else audio.key('punct'); },
    onNewline: () => { buffer.append('\n'); audio.key('enter'); },
    onCommand: (name) => {
      // 打鍵を始めたら読み上げは止める、の例外：読み上げ系コマンド自身は止めない
      if (!['repeat', 'tail', 'help', 'stop'].includes(name)) speech.stop();
      COMMANDS[name]?.();
    },
    onIgnored: (e) => { if (e.key.length === 1 || e.key === 'Enter') log('無視:', e.key); },
  });

  // 打鍵以外の何かで触られたときも解錠を試す（オーバーレイのタップ含む）
  $('overlay').addEventListener('pointerdown', start);
  document.addEventListener('pointerdown', () => { if (started) audio.unlock().catch(() => {}); });

  wireSettings();
  setState('idle');
  log('起動しました。画面をタップするかキーを押してください');
}

// --- 設定パネル -----------------------------------------------------------

function wireSettings() {
  const panel = $('settings');
  $('settings-toggle').addEventListener('click', (e) => {
    panel.hidden = !panel.hidden;
    e.currentTarget.blur();   // フォーカスを残さない
  });

  const apikey = $('apikey');
  apikey.value = gemini.getApiKey();
  apikey.addEventListener('change', () => { gemini.setApiKey(apikey.value); log('APIキーを保存'); });

  const model = $('model');
  model.value = gemini.getModel();
  model.placeholder = gemini.DEFAULT_MODEL;
  model.addEventListener('change', () => { gemini.setModel(model.value); log('モデル:', gemini.getModel()); });

  const bind = (id, get, set, fmt) => {
    const input = $(id), out = $(`${id}-out`);
    input.value = get();
    out.textContent = fmt(get());
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      set(v); out.textContent = fmt(v); saveSettings();
    });
    // スライダーにフォーカスが残ると打鍵が吸われるので、離したら外す
    input.addEventListener('change', () => input.blur());
  };

  bind('rate', () => speech.settings.rate, (v) => { speech.settings.rate = v; }, (v) => `${v.toFixed(2)}x`);
  bind('vol-key', () => audio.volumes.key, (v) => audio.setVolume('key', v), (v) => `${Math.round(v * 100)}%`);
  bind('vol-ui', () => audio.volumes.ui, (v) => audio.setVolume('ui', v), (v) => `${Math.round(v * 100)}%`);
  bind('vol-amb', () => audio.volumes.ambient, (v) => audio.setVolume('ambient', v), (v) => `${Math.round(v * 100)}%`);

  $('test-voice').addEventListener('click', () => {
    speech.stop();
    say('テストです。この速さで読み上げます。');
    $('voice').textContent = speech.voiceName();
  });

  $('export').addEventListener('click', async () => {
    const text = buffer.get();
    if (!text) { audio.cue.error(); return; }
    try {
      await navigator.clipboard.writeText(text);
      log('クリップボードにコピーしました');
      say('コピーしました');
    } catch (e) { err('コピーできません:', e.message); }
  });
}

init();
