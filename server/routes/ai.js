import { Router } from 'express';
import db from '../db.js';
import { wrap } from '../logger.js';
import { requireAuth, uid } from '../middleware/auth.js';
import { getAiConfig, isAiEnvLocked } from '../ai.js';

const router = Router();
router.use(requireAuth);

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

// POST /api/ai/chat — server-side proxy for AI calls (when env-locked)
router.post('/chat', wrap(async (req, res) => {
  const cfg = getAiConfig();
  const { messages, systemPrompt } = req.body;
  // Budget guard — bound per-request payload + history depth to prevent a
  // misbehaving (or malicious) client from running up Anthropic / OpenAI
  // bills on the server's API key. Caps mirror NutriTrace's audit values.
  if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages array required' });
  if (messages.length > 60) return res.status(413).json({ error: 'Conversation too long — clear chat and try again.' });
  const _approxBytes = JSON.stringify({ messages, systemPrompt }).length;
  if (_approxBytes > 200_000) return res.status(413).json({ error: 'Payload too large — clear chat or shorten the message.' });
  const provider = cfg.ai_provider || 'claude';
  const model = cfg.ai_model;
  const apiKey = cfg.ai_api_key;
  const baseUrl = cfg.ai_base_url;

  // API key required for cloud providers; oai-compat local endpoints (Ollama,
  // LM Studio, etc.) often don't need one — mirror the client-side callAI().
  if (!apiKey && provider !== 'oai-compat') {
    return res.status(400).json({ error: 'AI API key not configured' });
  }
  if (provider === 'oai-compat') {
    if (!baseUrl) return res.status(400).json({ error: 'AI_PROVIDER=oai-compat requires AI_BASE_URL in environment.' });
    if (!model)   return res.status(400).json({ error: 'AI_PROVIDER=oai-compat requires AI_MODEL in environment.' });
  }

  let text;
  if (provider === 'claude') {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: model || 'claude-haiku-4-5-20251001', max_tokens: 1024, system: systemPrompt, messages }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || `Claude API ${r.status}`);
    text = data.content[0].text;
  } else if (provider === 'openai' || provider === 'oai-compat') {
    // oai-compat forwards to any /v1/chat/completions endpoint (Ollama,
    // LM Studio, LocalAI, vLLM, etc). Base URL is required for oai-compat,
    // defaults to the public OpenAI endpoint for the openai provider.
    const endpoint = provider === 'oai-compat'
      ? `${baseUrl.replace(/\/+$/, '')}/v1/chat/completions`
      : 'https://api.openai.com/v1/chat/completions';
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey || 'no-key'}` },
      body: JSON.stringify({ model: model || 'gpt-4o-mini', max_tokens: 1024, messages: [{ role: 'system', content: systemPrompt }, ...messages] }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || `OpenAI API ${r.status}`);
    text = data.choices[0].message.content;
  } else if (provider === 'gemini') {
    const m = model || 'gemini-1.5-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${apiKey}`;
    const contents = messages.map(msg => ({ role: msg.role === 'assistant' ? 'model' : 'user', parts: [{ text: msg.content }] }));
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: systemPrompt }] }, contents }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || `Gemini API ${r.status}`);
    text = data.candidates[0].content.parts[0].text;
  }

  res.json({ text });
}));

export default router;
