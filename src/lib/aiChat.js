/**
 * AI Chat — multi-provider API layer with tool use (function calling).
 *
 * Supports: Anthropic Claude, OpenAI, Google Gemini, OpenAI Compatible
 *   (Ollama, LM Studio, LocalAI, vLLM, llama.cpp's server, DeepSeek, Groq,
 *    Together AI, Mistral La Plateforme — anything that exposes a
 *    /v1/chat/completions endpoint).
 *
 * All direct calls are client-side using the user's own API key (or no
 * key for unauthenticated local endpoints). Env-locked installs go
 * through callAIProxy which runs the same multi-round loop server-side-
 * assisted (server holds the API key, client still executes tools).
 *
 * Tool use flow:
 *   1. Send messages + tool definitions to the model
 *   2. If the model responds with tool_use, execute via `onToolCall`
 *      and feed results back
 *   3. Repeat up to MAX_ROUNDS, then return final text
 *
 * `onToolCall` is the executor — an async fn `(name, args) => result`.
 * `onToolResult` is an optional notification `(name, args, result)`.
 * When `tools` is omitted the loop still runs but exits on the first
 * response (no tool schemas ever sent), keeping behaviour identical
 * for legacy callers.
 */
import { get } from 'svelte/store';
import { _ } from 'svelte-i18n';
import { getOpenAIChatParams, openAIBase } from './openai-chat-params.js';
import { createToolSupportMemory, sendWithToolFallback } from './tool-support.js';
import { REPLY_MAX_TOKENS, sendWithLengthFallback, stoppedShort, stoppedShortError } from './trace-reply.js';

// A reply that stopped short, said in the app's language (trace-reply.js).
function _inLanguage(e) {
  if (!/^trace_(stopped_|timed_out$)/.test(e?.code || '')) return e;
  try {
    const t = get(_);
    const said = typeof t === 'function' ? t(`trace_reply.${e.code.slice('trace_'.length)}`) : null;
    if (said && !said.startsWith('trace_reply.')) e.message = said;
  } catch { /* i18n not ready: the English line */ }
  return e;
}
const _stoppedShort = (why) => _inLanguage(stoppedShortError(why));

// onToolsUnsupported runs when the model can't use tools and answered
// without them (TraceApps/nutritrace#259).
/**
 * fetch() to a provider from this browser. Its "Failed to fetch" says
 * nothing: the browser gives it when the address can't be reached, and when
 * the answer doesn't allow this site to read it (CORS), which is what a proxy
 * that adds CORS headers only to successful answers does to every error,
 * such as a model refusing tools (TraceApps/notetrace#18). Say what to check.
 */
export async function fetchProvider(url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    // Only a network failure is reworded (Chrome: "Failed to fetch", Firefox:
    // "NetworkError when attempting to fetch resource.", Safari: "Load
    // failed"). A cancelled request, or one fetch refused to send (a header
    // it can't carry, say), stays as it was.
    if (!(err instanceof TypeError) || !/failed to fetch|networkerror|load failed/i.test(err.message || '')) throw err;
    let host = '';
    try { host = new URL(url).host; } catch { /* not a URL */ }
    host = host || String(url);
    const page = typeof location !== 'undefined' ? location : null;
    const official = /(^|\.)(openai\.com|anthropic\.com|googleapis\.com)$/i.test(host);
    // An https page can't call a plain-http address (localhost aside). The
    // Android app can (allowMixedContent), so there it's the usual advice.
    const native = !!globalThis.Capacitor?.isNativePlatform?.();
    const insecure = !native && page?.protocol === 'https:' && /^http:/i.test(String(url)) && !/^(localhost|127\.|\[::1\])/i.test(host);
    const key = official ? 'unreachable_official' : insecure ? 'unreachable_insecure' : 'unreachable';
    let message = `Couldn't get an answer from ${host}.`;
    try {
      const t = get(_);
      if (typeof t === 'function') message = t(`trace_ai.${key}`, { values: { host, origin: page?.origin || 'this site' } });
    } catch { /* i18n not ready: the plain line above */ }
    const e = new Error(message);
    e.cause = err;
    // Not "you're offline": this says what it is.
    e.offline = false;
    throw e;
  }
}

export async function callAI({ provider, apiKey, model, messages, systemPrompt, tools, onToolCall, onToolResult, onToolsUnsupported, baseUrl }) {
  // The 'oai-compat' provider points at any /v1/chat/completions endpoint.
  // Local endpoints (Ollama default) don't need an API key; cloud ones do.
  // Other providers still require a key.
  if (!apiKey && provider !== 'oai-compat') {
    throw new Error('No API key configured. Add one in Settings → AI Assistant.');
  }
  const cb = { onToolCall, onToolResult, onToolsUnsupported };
  switch (provider) {
    case 'claude':     return _callClaudeWithTools(apiKey, model, messages, systemPrompt, tools, cb);
    case 'openai':     return _callOpenAIWithTools(apiKey, renamedModel(model), messages, systemPrompt, tools, cb, 'https://api.openai.com');
    case 'gemini':     return _callGeminiWithTools(apiKey, model, messages, systemPrompt, tools, cb);
    case 'oai-compat': {
      const base = openAIBase(baseUrl);
      if (!base)  throw new Error('OpenAI Compatible provider needs a Base URL. Set one in Settings → AI Assistant.');
      if (!model) throw new Error('OpenAI Compatible provider needs a model name. Set one in Settings → AI Assistant.');
      return _callOpenAIWithTools(apiKey || 'no-key', model, messages, systemPrompt, tools, cb, base);
    }
    default: throw new Error(`Unknown AI provider: ${provider}`);
  }
}

/**
 * Server-side proxy call — used when AI config is env-locked.
 *
 * The API key stays on the server; only messages + systemPrompt + tool
 * schemas are sent. Wire format is OpenAI-shape (the server adapts to
 * Claude / Gemini at the proxy boundary), so messages going in must use
 * `image_url` for images and `tool_calls` / `role:'tool'` for tool use.
 *
 * Tool execution stays client-side — tools touch local UI/state the
 * server doesn't have. This function runs the multi-round loop: send
 * messages → if proxy returns toolCalls, execute them locally, append
 * the assistant message + tool result messages, loop. Up to 5 rounds,
 * matching the direct-call cap.
 *
 * Auth: PWA uses cookies; native server mode uses a Bearer token
 * (cookies don't survive Android WebView reloads). Without the Bearer
 * header, env-locked AI calls from Android return 401.
 */
export async function callAIProxy({ messages, systemPrompt, tools, onToolCall, onToolResult, onToolsUnsupported }) {
  const { apiUrl, isNative, getServerUrl, getAuthToken } = await import('./platform.js');

  // Server proxy expects OpenAI wire shape regardless of the env-locked
  // provider (the server maps to Claude / Gemini at the boundary). Our
  // internal shape stores images as `{type:'image', dataUrl}`; forwarding
  // that verbatim would blow up on oai-compat endpoints (LiteLLM et al.)
  // that strictly validate the OpenAI schema. Normalise here once, then
  // append normalised assistant / tool messages verbatim inside the loop.
  let currentMessages = messages.map(m => (
    typeof m.content === 'string' ? m : { role: m.role, content: _toOpenAIContent(m.content) }
  ));

  const MAX_ROUNDS = 5;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const headers = { 'Content-Type': 'application/json' };
    if (isNative && getServerUrl()) {
      const token = getAuthToken();
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }
    const res = await fetch(apiUrl('/api/ai/chat'), {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({ messages: currentMessages, systemPrompt, tools }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401) throw new Error('Not signed in. Sign in again to use AI features.');
      throw _inLanguage(Object.assign(new Error(data.error || `AI proxy error ${res.status}`), { code: data.code }));
    }

    // No tools fired — final reply, return it.
    // The server's model can't use tools and answered without them.
    if (data.toolsUnsupported) onToolsUnsupported?.({ routed: !!data.toolsRouted });
    if (!data.toolCalls || data.toolCalls.length === 0) {
      return data.text || '';
    }

    // Tools fired: append assistant message verbatim, execute each tool
    // locally, append tool result messages, loop for next round.
    currentMessages.push(data.assistantMessage);
    for (const tc of data.toolCalls) {
      const args = tc.args || {};
      const result = onToolCall
        ? await _safeExec(onToolCall, tc.name, args)
        : { error: 'Tool handler not registered' };
      if (onToolResult) { try { onToolResult(tc.name, args, result); } catch {} }
      currentMessages.push({
        role: 'tool',
        tool_call_id: tc.id,
        // Gemini's adapter needs the original tool name to construct a
        // functionResponse part; OpenAI + Claude ignore the name field.
        name: tc.name,
        content: JSON.stringify(result),
      });
    }
  }

  throw new Error('Too many tool call rounds');
}

// ── Default models per provider ───────────────────────────────────────────────
export const AI_PROVIDERS = [
  { value: 'claude',     label: 'Anthropic Claude' },
  { value: 'openai',     label: 'OpenAI'           },
  { value: 'gemini',     label: 'Google Gemini'    },
  { value: 'oai-compat', label: 'OpenAI Compatible' },
];

// Checked against the vendors' model and deprecation pages on 2026-10-09
// (platform.claude.com, developers.openai.com, ai.google.dev), the same
// lists as NutriTrace. Labels compare list prices within each provider. A
// saved model that is no longer listed (Gemini 2.5 is open to existing users
// only) keeps working: the picker shows it as a custom model.
export const AI_MODELS = {
  claude: [
    { value: 'claude-haiku-5-5',  label: 'Claude Haiku 5.5 (fast, cheapest)'  },
    { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (balanced)'       },
    { value: 'claude-opus-5-5',   label: 'Claude Opus 5.5 (smarter)'          },
    { value: 'claude-fable-5-1',  label: 'Claude Fable 5.1 (most capable)'    },
    { value: 'claude-sonnet-5',   label: 'Claude Sonnet 5 (previous)'         },
    { value: 'claude-opus-5',     label: 'Claude Opus 5 (previous)'           },
    { value: 'claude-fable-5',    label: 'Claude Fable 5 (previous)'          },
    { value: 'claude-opus-4-8',   label: 'Claude Opus 4.8 (previous)'         },
    { value: '__custom__',        label: 'Custom…'                            },
  ],
  // GPT-6.1 Sol and GPT-6 Astra are left out: Trace calls tools through
  // Chat Completions, which those two don't support (only the Responses
  // API does, per their model pages).
  openai: [
    { value: 'gpt-6-luna',    label: 'GPT-6 Luna (fast, cheapest)'   },
    { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra (balanced)'      },
    { value: 'gpt-5.6-sol',   label: 'GPT-5.6 Sol (most capable)'    },
    { value: 'gpt-5.6-luna',  label: 'GPT-5.6 Luna (previous)'       },
    { value: 'gpt-4o-mini',   label: 'GPT-4o mini (previous)'        },
    { value: 'gpt-4o',        label: 'GPT-4o (previous)'             },
    { value: '__custom__',    label: 'Custom…'                       },
  ],
  gemini: [
    { value: 'gemini-3.1-flash-lite',  label: 'Gemini 3.1 Flash Lite (cheapest)'      },
    { value: 'gemini-3.5-flash-lite',  label: 'Gemini 3.5 Flash Lite (cheap)'         },
    { value: 'gemini-3.8-flash',       label: 'Gemini 3.8 Flash (fast)'               },
    { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview (most capable)' },
    { value: 'gemini-3.6-flash',       label: 'Gemini 3.6 Flash (previous)'           },
    { value: '__custom__',             label: 'Custom…'                               },
  ],
};

// Used when no model is chosen. Someone who picked a model keeps it.
export const AI_DEFAULT_MODELS = {
  claude: 'claude-haiku-5-5',
  openai: 'gpt-5.6-luna',
  gemini: 'gemini-3.8-flash',
};

// Model IDs that changed name: a saved old name is sent as the new one.
// gemini-3.1-pro never existed (only the preview does), and Google points
// the shut-down gemini-3-pro-preview at it. gpt-5.6 is the alias of
// gpt-5.6-sol, which the picker now names.
export const AI_MODEL_RENAMES = {
  'gemini-3.1-pro': 'gemini-3.1-pro-preview',
  'gemini-3-pro-preview': 'gemini-3.1-pro-preview',
  'gpt-5.6': 'gpt-5.6-sol',
};
export const renamedModel = (model) => AI_MODEL_RENAMES[model] || model;

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

// ── Anthropic Claude (with tool use) ─────────────────────────────────────────
async function _callClaudeWithTools(apiKey, model, messages, systemPrompt, tools, cb) {
  const { onToolCall, onToolResult } = cb || {};
  const claudeTools = (tools || []).map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));

  // Translate the internal message shape (string | [{type:text|image}])
  // into Claude's message shape once, then append raw Claude blocks in
  // the tool-use loop below.
  let currentMessages = messages.map(m => ({ role: m.role, content: _toClaudeContent(m.content) }));
  const MAX_ROUNDS = 5;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const body = {
      model: model || AI_DEFAULT_MODELS.claude,
      max_tokens: REPLY_MAX_TOKENS,
      system: systemPrompt,
      messages: currentMessages,
    };
    if (claudeTools.length) body.tools = claudeTools;

    // A model that can't write that many is asked again as before (trace-reply.js).
    const res = await sendWithLengthFallback(body, async (b) => {
      const r = await fetchProvider('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(b),
      });
      return { ok: r.ok, status: r.status, data: await r.json() };
    });
    const data = res.data;
    if (!res.ok) throw new Error(data.error?.message || `Claude API error ${res.status}`);
    const short = stoppedShort('claude', data);
    if (short) throw _stoppedShort(short);

    const toolUses   = (data.content || []).filter(b => b.type === 'tool_use');
    const textBlocks = (data.content || []).filter(b => b.type === 'text');
    if (toolUses.length === 0 || data.stop_reason !== 'tool_use') {
      return textBlocks.map(b => b.text).join('\n') || '';
    }

    currentMessages.push({ role: 'assistant', content: data.content });
    const toolResults = [];
    for (const tu of toolUses) {
      const args = tu.input || {};
      const result = onToolCall
        ? await _safeExec(onToolCall, tu.name, args)
        : { error: 'Tool handler not registered' };
      if (onToolResult) { try { onToolResult(tu.name, args, result); } catch {} }
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
    }
    currentMessages.push({ role: 'user', content: toolResults });
  }

  throw new Error('Too many tool call rounds');
}

// ── OpenAI / OpenAI-compatible (with function calling) ──────────────────────
// `baseUrl` defaults to api.openai.com but can be any /v1/chat/completions
// endpoint (Ollama, LM Studio, DeepSeek, Groq, etc.) — see callAI's
// 'oai-compat' branch.
// Models found unable to use tools, by base URL and model (TraceApps/nutritrace#259).
const toolSupport = createToolSupportMemory();

async function _callOpenAIWithTools(apiKey, model, messages, systemPrompt, tools, cb, baseUrl = 'https://api.openai.com') {
  const { onToolCall, onToolResult, onToolsUnsupported } = cb || {};
  const openaiTools = (tools || []).map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  let currentMessages = [
    { role: 'system', content: systemPrompt },
    ...messages.map(m => ({ role: m.role, content: _toOpenAIContent(m.content) })),
  ];
  const MAX_ROUNDS = 5;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const selectedModel = model || AI_DEFAULT_MODELS.openai;
    const body = {
      model: selectedModel,
      messages: currentMessages,
      ...getOpenAIChatParams({
        baseUrl,
        model: selectedModel,
        hasTools: openaiTools.length > 0,
        maxTokens: REPLY_MAX_TOKENS,
      }),
    };
    if (openaiTools.length) body.tools = openaiTools;

    // Some self-hosted endpoints (Ollama in particular) reject the
    // Authorization header when it carries a placeholder key. Only send
    // it when we have a real one.
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (apiKey && apiKey !== 'no-key') headers['Authorization'] = `Bearer ${apiKey}`;

    // A server that won't take the longer reply is asked again as before.
    const send = (body) => sendWithLengthFallback(body, async (b) => {
      const res = await fetchProvider(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(b),
      });
      return { ok: res.ok, status: res.status, data: await res.json() };
    });
    // A model that can't use tools gets the request again without them.
    const { ok, status, data, toolsDropped, toolsRouted } = await sendWithToolFallback(body, send, { memory: toolSupport, baseUrl, model: selectedModel });
    if (!ok) throw new Error(data.error?.message || `AI API error ${status}`);
    if (toolsDropped) onToolsUnsupported?.({ routed: toolsRouted });
    // Cut off, an answer would be half of one and a tool call half its arguments.
    const short = stoppedShort('openai', data);
    if (short) throw _stoppedShort(short);

    const msg = data.choices?.[0]?.message || {};
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return msg.content || '';
    }

    currentMessages.push(msg);
    for (const tc of msg.tool_calls) {
      const args = _safeJsonParse(tc.function?.arguments, {});
      const result = onToolCall
        ? await _safeExec(onToolCall, tc.function?.name, args)
        : { error: 'Tool handler not registered' };
      if (onToolResult) { try { onToolResult(tc.function?.name, args, result); } catch {} }
      currentMessages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }

  throw new Error('Too many tool call rounds');
}

// ── Google Gemini (with function calling) ────────────────────────────────────
// Models Google has shut down. Saved selections pointing at any of these
// are quietly remapped to the current default so users who never opened
// Settings after a bump don't suddenly hit 404s.
// Shut down per ai.google.dev/gemini-api/docs/deprecations (2026-10-09).
export const GEMINI_RETIRED = new Set([
  'gemini-1.5-flash', 'gemini-1.5-pro',
  'gemini-2.0-flash', 'gemini-2.0-flash-001', 'gemini-2.0-flash-lite', 'gemini-2.0-flash-lite-001',
  'gemini-2.0-flash-lite-preview', 'gemini-2.0-flash-lite-preview-02-05',
  'gemini-2.5-pro-preview-03-25', 'gemini-2.5-pro-preview-05-06', 'gemini-2.5-pro-preview-06-05',
  'gemini-2.5-flash-preview-05-20', 'gemini-2.5-flash-preview-09-25', 'gemini-2.5-flash-lite-preview-09-2025',
  'gemini-3.1-flash-lite-preview',
]);
/** The Gemini model to call for a saved one: renamed ones by their new name, shut-down ones by the default. */
export function geminiModelFor(model) {
  const m = renamedModel(model || AI_DEFAULT_MODELS.gemini);
  return GEMINI_RETIRED.has(m) ? AI_DEFAULT_MODELS.gemini : m;
}

async function _callGeminiWithTools(apiKey, model, messages, systemPrompt, tools, cb) {
  const { onToolCall, onToolResult } = cb || {};
  const m = geminiModelFor(model);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;

  const geminiTools = (tools || []).length ? [{
    functionDeclarations: tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  }] : undefined;

  // Gemini uses "model" instead of "assistant" for AI turns.
  let contents = messages.map(msg => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: _toGeminiParts(msg.content),
  }));

  const MAX_ROUNDS = 5;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const body = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
    };
    if (geminiTools) body.tools = geminiTools;

    const res = await fetchProvider(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `Gemini API error ${res.status}`);
    const short = stoppedShort('gemini', data);
    if (short) throw _stoppedShort(short);

    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const functionCalls = parts.filter(p => p.functionCall);
    const textParts     = parts.filter(p => p.text);

    if (functionCalls.length === 0) {
      return textParts.map(p => p.text).join('\n') || '';
    }

    contents.push({ role: 'model', parts });
    const responseParts = [];
    for (const fc of functionCalls) {
      const args = fc.functionCall.args || {};
      const result = onToolCall
        ? await _safeExec(onToolCall, fc.functionCall.name, args)
        : { error: 'Tool handler not registered' };
      if (onToolResult) { try { onToolResult(fc.functionCall.name, args, result); } catch {} }
      responseParts.push({ functionResponse: { name: fc.functionCall.name, response: result } });
    }
    contents.push({ role: 'user', parts: responseParts });
  }

  throw new Error('Too many tool call rounds');
}

// ── Small helpers ────────────────────────────────────────────────────────────
async function _safeExec(fn, name, args) {
  try {
    const r = await fn(name, args);
    return r === undefined ? { ok: true } : r;
  } catch (e) {
    return { error: e?.message || 'Tool execution failed' };
  }
}

function _safeJsonParse(s, fallback) {
  if (typeof s !== 'string') return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}
