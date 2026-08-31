// Gemini API をブラウザから直接叩く。SDKもサーバーも挟まない。
// 耳で待てる速さを最優先し、SSEで受け取って文が閉じた端から読み上げる。

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

const KEY_STORE = 'bk.apikey.v1';
const MODEL_STORE = 'bk.model.v1';
export const DEFAULT_MODEL = 'gemini-2.5-flash';

export function getApiKey() { try { return localStorage.getItem(KEY_STORE) || ''; } catch { return ''; } }
export function setApiKey(v) { try { localStorage.setItem(KEY_STORE, v.trim()); } catch {} }
export function getModel() { try { return localStorage.getItem(MODEL_STORE) || DEFAULT_MODEL; } catch { return DEFAULT_MODEL; } }
export function setModel(v) { try { localStorage.setItem(MODEL_STORE, (v || '').trim() || DEFAULT_MODEL); } catch {} }

function body({ system, prompt, temperature, maxTokens, noThinking }) {
  const b = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature, maxOutputTokens: maxTokens, candidateCount: 1 },
    safetySettings: [],
  };
  if (system) b.systemInstruction = { parts: [{ text: system }] };
  // 応答が遅いとこの体験は壊れるので、既定では思考を挟ませない
  if (noThinking) b.generationConfig.thinkingConfig = { thinkingBudget: 0 };
  return b;
}

async function errorMessage(res) {
  let detail = '';
  try {
    const j = await res.json();
    detail = j?.error?.message || '';
  } catch { /* JSONでないこともある */ }
  if (res.status === 400 && /api key/i.test(detail)) return 'APIキーが正しくありません';
  if (res.status === 403) return 'APIキーが拒否されました。制限設定を確認してください';
  if (res.status === 429) return 'レート制限に達しました。少し待ってください';
  if (res.status >= 500) return 'Gemini側のエラーです。もう一度試してください';
  return detail || `通信エラー (${res.status})`;
}

async function post(model, payload, signal) {
  const url = `${ENDPOINT}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(getApiKey())}`;
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
}

/**
 * SSEで受け取り、テキストの差分を onDelta に渡す。返り値は全文。
 */
export async function streamGenerate({
  system, prompt, signal, onDelta,
  temperature = 0.8, maxTokens = 1024, noThinking = true,
}) {
  if (!getApiKey()) throw new Error('APIキーが未設定です。設定を開いて入力してください');

  const model = getModel();
  let res = await post(model, body({ system, prompt, temperature, maxTokens, noThinking }), signal);

  // thinkingConfig を受け付けないモデルもあるので、その場合だけ外して1回だけ再試行する
  if (!res.ok && res.status === 400 && noThinking) {
    const clone = res.clone();
    let msg = '';
    try { msg = (await clone.json())?.error?.message || ''; } catch {}
    if (/thinking/i.test(msg)) {
      res = await post(model, body({ system, prompt, temperature, maxTokens, noThinking: false }), signal);
    }
  }

  if (!res.ok) throw new Error(await errorMessage(res));
  if (!res.body) throw new Error('ストリーミング応答を取得できませんでした');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let carry = '';
  let full = '';

  const handleLine = (line) => {
    if (!line.startsWith('data:')) return;
    const raw = line.slice(5).trim();
    if (!raw || raw === '[DONE]') return;
    let json;
    try { json = JSON.parse(raw); } catch { return; }
    if (json.error) throw new Error(json.error.message || 'Gemini エラー');
    const parts = json?.candidates?.[0]?.content?.parts || [];
    for (const p of parts) {
      if (typeof p.text === 'string' && p.text) {
        full += p.text;
        onDelta?.(p.text);
      }
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    carry += decoder.decode(value, { stream: true });
    const lines = carry.split('\n');
    carry = lines.pop() ?? '';
    for (const line of lines) handleLine(line.trim());
  }
  if (carry.trim()) handleLine(carry.trim());

  if (!full.trim()) throw new Error('回答が空でした');
  return full;
}
