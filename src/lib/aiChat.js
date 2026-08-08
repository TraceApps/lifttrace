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
import { getOpenAIChatParams } from './openai-chat-params.js';

export async function callAI({ provider, apiKey, model, messages, systemPrompt, tools, onToolCall, onToolResult, baseUrl }) {
  // The 'oai-compat' provider points at any /v1/chat/completions endpoint.
  // Local endpoints (Ollama default) don't need an API key; cloud ones do.
  // Other providers still require a key.
  if (!apiKey && provider !== 'oai-compat') {
    throw new Error('No API key configured. Add one in Settings → AI Assistant.');
  }
  const cb = { onToolCall, onToolResult };
  switch (provider) {
    case 'claude':     return _callClaudeWithTools(apiKey, model, messages, systemPrompt, tools, cb);
    case 'openai':     return _callOpenAIWithTools(apiKey, model, messages, systemPrompt, tools, cb, 'https://api.openai.com');
    case 'gemini':     return _callGeminiWithTools(apiKey, model, messages, systemPrompt, tools, cb);
    case 'oai-compat': {
      if (!baseUrl) throw new Error('OpenAI Compatible provider needs a Base URL. Set one in Settings → AI Assistant.');
      if (!model)   throw new Error('OpenAI Compatible provider needs a model name. Set one in Settings → AI Assistant.');
      return _callOpenAIWithTools(apiKey || 'no-key', model, messages, systemPrompt, tools, cb, baseUrl.replace(/\/+$/, ''));
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
export async function callAIProxy({ messages, systemPrompt, tools, onToolCall, onToolResult }) {
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
      throw new Error(data.error || `AI proxy error ${res.status}`);
    }

    // No tools fired — final reply, return it.
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

export const AI_MODELS = {
  claude: [
    { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku (fast, cheap)' },
    { value: 'claude-sonnet-5',           label: 'Claude Sonnet 5 (balanced)' },
    { value: 'claude-opus-4-8',           label: 'Claude Opus 4.8'            },
    { value: 'claude-opus-5',             label: 'Claude Opus 5'              },
    { value: 'claude-fable-5',            label: 'Claude Fable 5 (most capable)' },
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
      max_tokens: 4096,
      system: systemPrompt,
      messages: currentMessages,
    };
    if (claudeTools.length) body.tools = claudeTools;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `Claude API error ${res.status}`);

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
async function _callOpenAIWithTools(apiKey, model, messages, systemPrompt, tools, cb, baseUrl = 'https://api.openai.com') {
  const { onToolCall, onToolResult } = cb || {};
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
      }),
    };
    if (openaiTools.length) body.tools = openaiTools;

    // Some self-hosted endpoints (Ollama in particular) reject the
    // Authorization header when it carries a placeholder key. Only send
    // it when we have a real one.
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey && apiKey !== 'no-key') headers['Authorization'] = `Bearer ${apiKey}`;

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `AI API error ${res.status}`);

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
// Models Google has shut down or scheduled for shutdown. Saved selections
// pointing at any of these are quietly remapped to the current default so
// users who never opened Settings after a bump don't suddenly hit 404s.
const GEMINI_RETIRED = new Set([
  'gemini-1.5-flash', 'gemini-1.5-pro',
  'gemini-2.0-flash', 'gemini-2.0-flash-lite',
]);

async function _callGeminiWithTools(apiKey, model, messages, systemPrompt, tools, cb) {
  const { onToolCall, onToolResult } = cb || {};
  let m = model || AI_DEFAULT_MODELS.gemini;
  if (GEMINI_RETIRED.has(m)) m = AI_DEFAULT_MODELS.gemini;
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

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || `Gemini API error ${res.status}`);

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
