import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, uid } from '../middleware/auth.js';
import { getAiConfig, isAiEnvLocked } from '../ai.js';

const router = Router();
router.use(requireAuth);

const AI_DEFAULT_MODELS = {
  claude: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.5-flash',
};

// Models Google has shut down (404) or scheduled for shutdown.
// Saved env-locked configs pointing at any of these are remapped to the
// current default so the proxy doesn't 404 against a dead endpoint.
const GEMINI_RETIRED = new Set([
  'gemini-1.5-flash', 'gemini-1.5-pro',
  'gemini-2.0-flash', 'gemini-2.0-flash-lite',
]);

// GET /api/ai/history — chat history
router.get('/history', wrap((req, res) => {
  const userId = uid(req);
  const rows = userId != null
    ? db.prepare('SELECT * FROM ai_chat_history WHERE user_id = ? ORDER BY created_at ASC LIMIT 100').all(userId)
    : db.prepare('SELECT * FROM ai_chat_history WHERE user_id IS NULL ORDER BY created_at ASC LIMIT 100').all();
  res.json(rows);
}));

// POST /api/ai/history — save a message
router.post('/history', wrap((req, res) => {
  const { role, content } = req.body;
  if (!role || !content) return res.status(400).json({ error: 'role and content required' });
  db.prepare('INSERT INTO ai_chat_history (user_id, role, content) VALUES (?, ?, ?)').run(uid(req), role, content);
  res.json({ ok: true });
}));

// DELETE /api/ai/history — clear chat
router.delete('/history', wrap((req, res) => {
  const userId = uid(req);
  if (userId != null) db.prepare('DELETE FROM ai_chat_history WHERE user_id = ?').run(userId);
  else db.prepare('DELETE FROM ai_chat_history WHERE user_id IS NULL').run();
  res.json({ ok: true });
}));

// ── Rate limit ──────────────────────────────────────────────────────────────
// Multi-round tool use amplifies request count (one user "send" can fire
// several proxy round-trips), so budget for that. Mirrors NutriTrace's
// 30 requests / 60s. Cheap in-memory bucket keyed by user then IP,
// same shape as the login rate limiter in server/routes/auth.js.
const _AI_LIMIT_WINDOW_MS = 60_000;
const _AI_LIMIT_MAX       = 30;
const _aiBuckets = new Map();
function _aiRateLimit(req, res, next) {
  const key = 'u:' + (uid(req) ?? ('ip:' + (req.ip || req.socket?.remoteAddress || 'unknown')));
  const now = Date.now();
  let entry = _aiBuckets.get(key);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + _AI_LIMIT_WINDOW_MS };
    _aiBuckets.set(key, entry);
  }
  entry.count++;
  if (entry.count > _AI_LIMIT_MAX) {
    const retryMs = entry.resetAt - now;
    res.set('Retry-After', Math.ceil(retryMs / 1000));
    return res.status(429).json({ error: 'AI request rate limit hit. Try again in a moment.' });
  }
  next();
}
// Sweep stale buckets every 30 min.
setInterval(() => {
  const now = Date.now();
  for (const [k, entry] of _aiBuckets) if (now > entry.resetAt) _aiBuckets.delete(k);
}, 30 * 60 * 1000);

// Normalise any image content part on an incoming message to the OpenAI
// wire shape `{type:'image_url', image_url:{url:'data:...'}}` so the
// oai-compat forward path never sees Anthropic-shape or LT's internal
// shape (which strict schema proxies like LiteLLM reject).
// Idempotent; non-array content untouched. Defense-in-depth for
// NT #114-class client drift.
function _normaliseImagePartsToOpenAI(msg) {
  if (!msg || !Array.isArray(msg.content)) return msg;
  const normalised = msg.content.map(part => {
    if (!part || typeof part !== 'object') return part;
    if (part.type === 'image' && part.source?.type === 'base64' && part.source.media_type && part.source.data) {
      return {
        type: 'image_url',
        image_url: { url: `data:${part.source.media_type};base64,${part.source.data}` },
      };
    }
    if (part.type === 'image' && typeof part.dataUrl === 'string') {
      return { type: 'image_url', image_url: { url: part.dataUrl } };
    }
    return part;
  });
  return { ...msg, content: normalised };
}

// Payload caps to bound a misbehaving (or malicious) client from
// running up the server's API bill. Tool-use rounds pump payload with
// tool-result echoes, so the byte cap is generous. Matches NT audit
// values.
const AI_MAX_MESSAGES = 60;
const AI_MAX_BYTES    = 8_000_000;

/**
 * POST /api/ai/chat
 *
 * Server-side proxy used when AI config is env-locked. The API key
 * never leaves the server; clients send a provider-neutral, OpenAI-
 * shaped request and get an OpenAI-shaped response back.
 *
 * Wire shape (request):
 *   {
 *     messages:     [...openai-style messages...],
 *     systemPrompt: string,
 *     tools?:       [{name, description, parameters}]
 *   }
 *
 * Wire shape (response):
 *   { text: string }                                  — final reply, no tools
 *   { assistantMessage, toolCalls: [{id,name,args}] } — model wants tools
 *
 * The client's callAIProxy runs the multi-round tool loop: when
 * toolCalls are returned, it executes them locally (tools touch the
 * client's local UI/state), appends `{role:'tool', tool_call_id,
 * content}` messages, and re-invokes the proxy. Tool execution
 * intentionally stays client-side.
 *
 * Provider translation happens at the proxy boundary: OpenAI passes
 * through; Claude and Gemini get message + response adapters so env-
 * locked deployments support the full tool set regardless of which
 * provider the admin chose.
 */
router.post('/chat', _aiRateLimit, wrap(async (req, res) => {
  const cfg = getAiConfig();
  const { messages: rawMessages, systemPrompt, tools } = req.body;
  if (!Array.isArray(rawMessages)) return res.status(400).json({ error: 'messages array required' });
  const messages = rawMessages.map(_normaliseImagePartsToOpenAI);
  if (messages.length > AI_MAX_MESSAGES) {
    return res.status(413).json({ error: `Too many messages (max ${AI_MAX_MESSAGES})` });
  }
  const payloadBytes = JSON.stringify(messages).length
                     + (typeof systemPrompt === 'string' ? systemPrompt.length : 0)
                     + (Array.isArray(tools) ? JSON.stringify(tools).length : 0);
  if (payloadBytes > AI_MAX_BYTES) {
    return res.status(413).json({ error: `Payload too large (${payloadBytes} bytes; max ${AI_MAX_BYTES})` });
  }

  const provider = cfg.ai_provider || 'claude';
  const model    = cfg.ai_model    || AI_DEFAULT_MODELS[provider] || '';
  const apiKey   = cfg.ai_api_key;
  const baseUrl  = cfg.ai_base_url;
  const toolsArr = Array.isArray(tools) ? tools : [];

  // API key required for cloud providers; oai-compat local endpoints (Ollama,
  // LM Studio, etc.) often don't need one — mirror the client-side callAI().
  if (!apiKey && provider !== 'oai-compat') {
    return res.status(400).json({ error: 'AI API key not configured' });
  }
  if (provider === 'oai-compat') {
    if (!baseUrl) return res.status(400).json({ error: 'AI_PROVIDER=oai-compat requires AI_BASE_URL in environment.' });
    if (!model)   return res.status(400).json({ error: 'AI_PROVIDER=oai-compat requires AI_MODEL in environment.' });
  }

  let result;
  switch (provider) {
    case 'claude':     result = await _callClaude(apiKey, model, messages, systemPrompt, toolsArr); break;
    case 'openai':     result = await _callOpenAI(apiKey, model, messages, systemPrompt, toolsArr, 'https://api.openai.com'); break;
    case 'gemini':     result = await _callGemini(apiKey, model, messages, systemPrompt, toolsArr); break;
    case 'oai-compat': result = await _callOpenAI(apiKey || 'no-key', model, messages, systemPrompt, toolsArr, baseUrl.replace(/\/+$/, '')); break;
    default: return res.status(400).json({ error: `Unknown provider: ${provider}` });
  }
  res.json(result);
}));

export default router;

// ── Provider implementations (server-side) ──────────────────────────────────
//
// Each adapter takes OpenAI-shape inputs and returns one of:
//   { text: string }                                — final assistant reply
//   { assistantMessage, toolCalls: [{id,name,args}] } — model wants tools
//
// assistantMessage is OpenAI-shape (role:'assistant', content, tool_calls)
// so the client can append it verbatim to its message history before
// dispatching tool results back through the proxy.

async function _callClaude(apiKey, model, messages, systemPrompt, tools) {
  const claudeMessages = _openaiToClaudeMessages(messages);
  const claudeTools    = (tools || []).map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));

  const body = {
    model: model || AI_DEFAULT_MODELS.claude,
    max_tokens: 4096,
    system: systemPrompt,
    messages: claudeMessages,
  };
  if (claudeTools.length) body.tools = claudeTools;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || `Claude API ${r.status}`);

  const blocks    = data.content || [];
  const toolUses  = blocks.filter(b => b.type === 'tool_use');
  const textParts = blocks.filter(b => b.type === 'text').map(b => b.text);

  if (toolUses.length === 0 || data.stop_reason !== 'tool_use') {
    return { text: textParts.join('\n') || '' };
  }
  const assistantMessage = {
    role: 'assistant',
    content: textParts.join('\n') || null,
    tool_calls: toolUses.map(tu => ({
      id: tu.id,
      type: 'function',
      function: { name: tu.name, arguments: JSON.stringify(tu.input || {}) },
    })),
  };
  const toolCalls = toolUses.map(tu => ({ id: tu.id, name: tu.name, args: tu.input || {} }));
  return { assistantMessage, toolCalls };
}

async function _callOpenAI(apiKey, model, messages, systemPrompt, tools, baseUrl = 'https://api.openai.com') {
  const openaiTools = (tools || []).map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const body = {
    model: model || AI_DEFAULT_MODELS.openai,
    max_tokens: 4096,
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
  };
  if (openaiTools.length) body.tools = openaiTools;

  const r = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || `OpenAI API ${r.status}`);

  const msg = data.choices?.[0]?.message || {};
  if (!msg.tool_calls || msg.tool_calls.length === 0) {
    return { text: msg.content || '' };
  }
  const toolCalls = msg.tool_calls.map(tc => ({
    id:   tc.id,
    name: tc.function?.name,
    args: _safeJsonParse(tc.function?.arguments, {}),
  }));
  return { assistantMessage: msg, toolCalls };
}

async function _callGemini(apiKey, model, messages, systemPrompt, tools) {
  const m = GEMINI_RETIRED.has(model) ? AI_DEFAULT_MODELS.gemini : (model || AI_DEFAULT_MODELS.gemini);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;

  const contents = _openaiToGeminiContents(messages);
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents,
  };
  if ((tools || []).length) {
    body.tools = [{
      functionDeclarations: tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    }];
  }

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || `Gemini API ${r.status}`);

  const parts    = data.candidates?.[0]?.content?.parts || [];
  const fnCalls  = parts.filter(p => p.functionCall);
  const textParts = parts.filter(p => p.text).map(p => p.text);

  if (fnCalls.length === 0) {
    return { text: textParts.join('\n') || '' };
  }
  // Gemini's functionCall has no ID. Mint stable synthetic IDs so the
  // OpenAI-shape tool_call_id round-trips correctly through the client.
  const assistantMessage = {
    role: 'assistant',
    content: textParts.join('\n') || null,
    tool_calls: fnCalls.map((p, i) => ({
      id: `gem_${Date.now()}_${i}`,
      type: 'function',
      function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) },
    })),
  };
  const toolCalls = fnCalls.map((p, i) => ({
    id:   `gem_${Date.now()}_${i}`,
    name: p.functionCall.name,
    args: p.functionCall.args || {},
  }));
  return { assistantMessage, toolCalls };
}

// ── OpenAI-shape ↔ provider-native translators ──────────────────────────────

function _safeJsonParse(s, fallback) {
  if (typeof s !== 'string') return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

/**
 * OpenAI messages → Claude messages.
 *
 * - system is passed separately by Claude's API; the proxy already
 *   pulls it from systemPrompt, so any stray {role:'system'} is filtered.
 * - user / assistant text passes through.
 * - user content arrays carrying {type:'image_url'} get the data: URL
 *   parsed into Claude's {type:'image', source:{base64}} block.
 * - assistant tool_calls become {type:'tool_use'} blocks.
 * - tool messages become Claude {type:'tool_result'} blocks wrapped in
 *   a user message (Claude's required shape for tool results).
 */
function _openaiToClaudeMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) };
      const last  = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }
    if (m.role === 'assistant') {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: typeof m.content === 'string' ? m.content : String(m.content) });
      for (const tc of (m.tool_calls || [])) {
        blocks.push({
          type: 'tool_use',
          id:   tc.id,
          name: tc.function?.name,
          input: _safeJsonParse(tc.function?.arguments, {}),
        });
      }
      out.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '' }] });
      continue;
    }
    // user
    if (typeof m.content === 'string') {
      out.push({ role: 'user', content: m.content });
    } else if (Array.isArray(m.content)) {
      const blocks = [];
      for (const part of m.content) {
        if (part.type === 'text') {
          blocks.push({ type: 'text', text: part.text || '' });
        } else if (part.type === 'image_url') {
          const url = part.image_url?.url || '';
          const mm  = /^data:([^;]+);base64,(.+)$/.exec(url);
          if (mm) blocks.push({ type: 'image', source: { type: 'base64', media_type: mm[1], data: mm[2] } });
        }
      }
      out.push({ role: 'user', content: blocks });
    }
  }
  return out;
}

/**
 * OpenAI messages → Gemini contents.
 *
 * - system handled by Gemini's systemInstruction; filtered here.
 * - assistant ↔ model role rename.
 * - text content becomes a text part.
 * - image_url content (data:base64 URL) becomes an inlineData part.
 * - assistant tool_calls become functionCall parts.
 * - tool messages become functionResponse parts wrapped in a user-role
 *   content block (Gemini's required shape for tool results).
 */
function _openaiToGeminiContents(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      const responsePart = {
        functionResponse: {
          // Gemini ignores the id but wants a name. The client echoes
          // the original tool name on `role:'tool'` messages for this
          // reason (aiChat.js callAIProxy loop).
          name: m.name || '',
          response: typeof m.content === 'string' ? _safeJsonParse(m.content, { result: m.content }) : (m.content || {}),
        },
      };
      const last = out[out.length - 1];
      if (last && last.role === 'user') {
        last.parts.push(responsePart);
      } else {
        out.push({ role: 'user', parts: [responsePart] });
      }
      continue;
    }
    if (m.role === 'assistant') {
      const parts = [];
      if (m.content) parts.push({ text: typeof m.content === 'string' ? m.content : String(m.content) });
      for (const tc of (m.tool_calls || [])) {
        parts.push({
          functionCall: {
            name: tc.function?.name,
            args: _safeJsonParse(tc.function?.arguments, {}),
          },
        });
      }
      out.push({ role: 'model', parts: parts.length ? parts : [{ text: '' }] });
      continue;
    }
    // user
    if (typeof m.content === 'string') {
      out.push({ role: 'user', parts: [{ text: m.content }] });
    } else if (Array.isArray(m.content)) {
      const parts = [];
      for (const part of m.content) {
        if (part.type === 'text') {
          parts.push({ text: part.text || '' });
        } else if (part.type === 'image_url') {
          const url = part.image_url?.url || '';
          const mm  = /^data:([^;]+);base64,(.+)$/.exec(url);
          if (mm) parts.push({ inlineData: { mimeType: mm[1], data: mm[2] } });
        }
      }
      out.push({ role: 'user', parts });
    }
  }
  return out;
}
