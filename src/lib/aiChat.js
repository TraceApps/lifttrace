/**
 * AI Chat — multi-provider API layer
 * Supports: Anthropic Claude, OpenAI, Google Gemini, OpenAI Compatible
 *   (Ollama, LM Studio, LocalAI, vLLM, llama.cpp's server, DeepSeek, Groq,
 *    Together AI, Mistral La Plateforme — anything that exposes a
 *    /v1/chat/completions endpoint).
 * All calls made client-side using the user's own API key (or no key for
 * unauthenticated local endpoints).
 */

export async function callAI({ provider, apiKey, model, messages, systemPrompt, baseUrl }) {
  // The 'oai-compat' provider points at any /v1/chat/completions endpoint.
  // Local endpoints (Ollama default) don't need an API key; cloud ones do.
  // Other providers still require a key.
  if (!apiKey && provider !== 'oai-compat') {
    throw new Error('No API key configured. Add one in Settings → AI Assistant.');
  }
  switch (provider) {
    case 'claude':     return _callClaude(apiKey, model, messages, systemPrompt);
    case 'openai':     return _callOpenAI(apiKey, model, messages, systemPrompt, 'https://api.openai.com');
    case 'gemini':     return _callGemini(apiKey, model, messages, systemPrompt);
    case 'oai-compat': {
      if (!baseUrl) throw new Error('OpenAI Compatible provider needs a Base URL. Set one in Settings → AI Assistant.');
      if (!model)   throw new Error('OpenAI Compatible provider needs a model name. Set one in Settings → AI Assistant.');
      return _callOpenAI(apiKey || 'no-key', model, messages, systemPrompt, baseUrl.replace(/\/+$/, ''));
    }
    default: throw new Error(`Unknown AI provider: ${provider}`);
  }
}

/**
 * Server-side proxy call — used when AI config is env-locked.
 * The API key stays on the server; only messages + systemPrompt are sent.
 *
 * Auth: PWA uses cookies; native server mode uses a Bearer token (cookies
 * don't survive Android WebView reloads). Without the Bearer header,
 * env-locked AI calls from the Android app return 401.
 */
export async function callAIProxy({ messages, systemPrompt }) {
  const { apiUrl, isNative, getServerUrl, getAuthToken } = await import('./platform.js');
  const headers = { 'Content-Type': 'application/json' };
  if (isNative && getServerUrl()) {
    const token = getAuthToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }
  // Server proxy expects OpenAI wire shape regardless of the env-locked
  // provider (the server maps to Claude / Gemini at the boundary). Our
  // internal shape stores images as `{type:'image', dataUrl}`; forwarding
  // that verbatim would blow up on oai-compat endpoints (LiteLLM et al.)
  // that strictly validate the OpenAI schema. Normalise here.
  const wireMessages = messages.map(m => (
    typeof m.content === 'string' ? m : { role: m.role, content: _toOpenAIContent(m.content) }
  ));
  const res = await fetch(apiUrl('/api/ai/chat'), {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({ messages: wireMessages, systemPrompt }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) throw new Error('Not signed in — sign in again to use AI features.');
    throw new Error(data.error || `AI proxy error ${res.status}`);
  }
  return data.text;
}

// ── Default models per provider ───────────────────────────────────────────────
export const AI_PROVIDERS = [
  { value: 'claude',     label: 'Anthropic Claude' },
  { value: 'openai',     label: 'OpenAI'           },
  { value: 'gemini',     label: 'Google Gemini'    },
  { value: 'oai-compat', label: 'OpenAI Compatible' },
];

export const AI_MODELS = {
  claude: [
    { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku (fast, cheap)' },
    { value: 'claude-sonnet-5',           label: 'Claude Sonnet (smarter)'    },
    { value: 'claude-opus-4-8',           label: 'Claude Opus (smartest)'     },
    { value: '__custom__',                label: 'Custom…'                    },
  ],
  openai: [
    { value: 'gpt-4o-mini',  label: 'GPT-4o mini (fast, cheap)' },
    { value: 'gpt-4o',       label: 'GPT-4o (smarter)'          },
    { value: '__custom__',   label: 'Custom…'                   },
  ],
  gemini: [
    { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite (cheapest)' },
    { value: 'gemini-2.5-flash',      label: 'Gemini 2.5 Flash (fast, cheap)'   },
    { value: 'gemini-2.5-pro',        label: 'Gemini 2.5 Pro (smarter)'         },
    { value: '__custom__',            label: 'Custom…'                          },
  ],
};

export const AI_DEFAULT_MODELS = {
  claude: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.5-flash',
};

// ── Helpers for multimodal content ───────────────────────────────────────────
// Internal message content shape: string | [{type:'text',text}, {type:'image',dataUrl}, ...]
function _splitDataUrl(dataUrl) {
  // data:image/png;base64,XXXX
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || '');
  return m ? { mediaType: m[1], data: m[2] } : null;
}
function _toClaudeContent(content) {
  if (typeof content === 'string') return content;
  return content.map(part => {
    if (part.type === 'image') {
      const s = _splitDataUrl(part.dataUrl);
      return { type: 'image', source: { type: 'base64', media_type: s.mediaType, data: s.data } };
    }
    return { type: 'text', text: part.text };
  });
}
function _toOpenAIContent(content) {
  if (typeof content === 'string') return content;
  return content.map(part =>
    part.type === 'image'
      ? { type: 'image_url', image_url: { url: part.dataUrl } }
      : { type: 'text', text: part.text }
  );
}
function _toGeminiParts(content) {
  if (typeof content === 'string') return [{ text: content }];
  return content.map(part => {
    if (part.type === 'image') {
      const s = _splitDataUrl(part.dataUrl);
      return { inlineData: { mimeType: s.mediaType, data: s.data } };
    }
    return { text: part.text };
  });
}

// ── Anthropic Claude ──────────────────────────────────────────────────────────
async function _callClaude(apiKey, model, messages, systemPrompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: model || AI_DEFAULT_MODELS.claude,
      max_tokens: 1024,
      system: systemPrompt,
      messages: messages.map(m => ({ role: m.role, content: _toClaudeContent(m.content) })),
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Claude API error ${res.status}`);
  return data.content[0].text;
}

// ── OpenAI / OpenAI-compatible ────────────────────────────────────────────────
// `baseUrl` defaults to api.openai.com but can be any /v1/chat/completions
// endpoint (Ollama, LM Studio, DeepSeek, Groq, etc.) — see callAI's
// 'oai-compat' branch.
async function _callOpenAI(apiKey, model, messages, systemPrompt, baseUrl = 'https://api.openai.com') {
  // Some self-hosted endpoints (Ollama in particular) reject the Authorization
  // header when it carries a placeholder key. Only send it when we have a
  // real one.
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey && apiKey !== 'no-key') headers['Authorization'] = `Bearer ${apiKey}`;

  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: model || AI_DEFAULT_MODELS.openai,
      max_tokens: 1024,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages.map(m => ({ role: m.role, content: _toOpenAIContent(m.content) })),
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `AI API error ${res.status}`);
  return data.choices[0].message.content;
}

// ── Google Gemini ─────────────────────────────────────────────────────────────
// Models Google has shut down or scheduled for shutdown. Saved selections
// pointing at any of these are quietly remapped to the current default so
// users who never opened Settings after a bump don't suddenly hit 404s.
const GEMINI_RETIRED = new Set([
  'gemini-1.5-flash', 'gemini-1.5-pro',
  'gemini-2.0-flash', 'gemini-2.0-flash-lite',
]);

async function _callGemini(apiKey, model, messages, systemPrompt) {
  let m = model || AI_DEFAULT_MODELS.gemini;
  if (GEMINI_RETIRED.has(m)) m = AI_DEFAULT_MODELS.gemini;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;
  // Gemini uses "model" instead of "assistant" for AI turns
  const contents = messages.map(msg => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: _toGeminiParts(msg.content),
  }));
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Gemini API error ${res.status}`);
  return data.candidates[0].content.parts[0].text;
}
