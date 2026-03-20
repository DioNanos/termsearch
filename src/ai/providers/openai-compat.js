// Generic OpenAI-compatible API client
// Works with: Ollama, llama.cpp, LM Studio, OpenAI, Groq, Chutes.ai, any compatible endpoint

const RATE_LIMIT_RETRY_DELAYS_MS = [3000, 6000];
const TRANSIENT_RETRY_DELAYS_MS = [1500, 3000];

const THINKING_START_RE = /^(?:Thinking Process:|Let me (?:analyze|think)|I (?:need to|will|should)|The user (?:is|wants|asked)|Looking at (?:the|these)|Analyzing (?:the|this))/i;

function stripThinkingPrefix(text) {
  if (!THINKING_START_RE.test(text)) return text;
  const answerStart = text.search(/\n\n(?=##|###|\*\*[A-Z]|[A-Z][a-zÀ-ÿ])/);
  if (answerStart !== -1) return text.slice(answerStart).trim();
  const parts = text.split(/\n\n+/);
  const firstReal = parts.findIndex((p, i) => i > 0 && !/^\d+\.|^Let me|^I |^The user|^Thinking|^Analyzing/i.test(p.trim()));
  if (firstReal > 0) return parts.slice(firstReal).join('\n\n').trim();
  return text;
}

function extractThinking(raw) {
  const thinkMatch = raw.match(/^\s*<think>([\s\S]*?)<\/think>\s*/);
  if (thinkMatch) {
    return { reasoning: thinkMatch[1].trim(), content: raw.slice(thinkMatch[0].length).trim() };
  }
  const blockMatch = raw.match(/^(?:Thinking Process:|Let me|I need to|The user|Looking at)[\s\S]*?(\{[\s\S]*\})\s*$/);
  if (blockMatch) {
    return { reasoning: raw.slice(0, raw.lastIndexOf(blockMatch[1])).trim(), content: blockMatch[1].trim() };
  }
  return { reasoning: '', content: raw };
}

function buildAiError(code, message) {
  const error = new Error(message);
  error.aiCode = code;
  return error;
}

export function classifyAiError(error) {
  const explicit = String(error?.aiCode || '').trim();
  if (explicit) return explicit;
  const raw = String(error?.message || error || '').trim().toLowerCase();
  if (!raw) return 'ai_unavailable';
  if (raw.includes(' 401') || raw.includes(' 403') || raw.includes('authentication failed') || raw.includes('invalid token')) return 'ai_provider_auth';
  if (raw.includes(' 429') || raw.includes('rate limit') || raw.includes('too many requests')) return 'ai_rate_limited_provider';
  if (raw.includes('aborted') || raw.includes('timeout') || raw.includes('timed out')) return 'ai_timeout_provider';
  if (raw.includes('fetch failed') || raw.includes('networkerror') || raw.includes('network error')) return 'ai_provider_unreachable';
  if (raw.includes(' 500') || raw.includes(' 502') || raw.includes(' 503') || raw.includes(' 504')) return 'ai_provider_unavailable';
  return 'ai_unavailable';
}

function shouldRetry(error) {
  const code = classifyAiError(error);
  return code === 'ai_rate_limited_provider' || code === 'ai_timeout_provider' || code === 'ai_provider_unreachable' || code === 'ai_provider_unavailable';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Single non-streaming call with retry logic
// Returns { content, reasoning, model } or throws
export async function call(prompt, {
  apiBase,
  apiKey,
  model,
  maxTokens = 1200,
  timeoutMs = 90_000,
  systemPrompt = null,
  jsonMode = false,
  temperature = 0.3,
} = {}) {
  const base = String(apiBase || '').replace(/\/$/, '');
  if (!base || !model) throw buildAiError('ai_unavailable', 'AI not configured');

  const messages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }]
    : [{ role: 'user', content: prompt }];
  const bodyBase = { messages, max_tokens: maxTokens, temperature };
  if (jsonMode) bodyBase.response_format = { type: 'json_object' };

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  let rateLimitAttempt = 0;
  let transientAttempt = 0;

  while (true) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const response = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...bodyBase, model }),
        signal: ac.signal,
      });

      if (response.status === 401 || response.status === 403) {
        throw buildAiError('ai_provider_auth', `ai ${response.status}: authentication failed`);
      }
      if (response.status === 429) {
        if (rateLimitAttempt < RATE_LIMIT_RETRY_DELAYS_MS.length) {
          const retryAfter = Number(response.headers.get('retry-after') || 0);
          const delay = retryAfter > 0 ? retryAfter * 1000 : RATE_LIMIT_RETRY_DELAYS_MS[rateLimitAttempt++];
          console.warn(`[AI] rate limited, retrying in ${delay}ms`);
          await sleep(delay);
          continue;
        }
        throw buildAiError('ai_rate_limited_provider', 'ai 429: rate limit exceeded');
      }
      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        const err = new Error(`ai ${response.status}: ${errBody.slice(0, 220)}`);
        if (shouldRetry(err) && classifyAiError(err) !== 'ai_rate_limited_provider' && transientAttempt < TRANSIENT_RETRY_DELAYS_MS.length) {
          const delay = TRANSIENT_RETRY_DELAYS_MS[transientAttempt++];
          await sleep(delay);
          continue;
        }
        throw err;
      }

      const data = await response.json();
      const msg = data.choices?.[0]?.message || {};
      const rawContent = stripThinkingPrefix((msg.content || '').trim());
      const { reasoning, content } = extractThinking(rawContent);
      return {
        content,
        reasoning: (msg.reasoning_content || reasoning || '').trim(),
        model: data.model || model,
      };
    } catch (error) {
      clearTimeout(timer);
      if (shouldRetry(error) && classifyAiError(error) !== 'ai_rate_limited_provider' && transientAttempt < TRANSIENT_RETRY_DELAYS_MS.length) {
        const delay = TRANSIENT_RETRY_DELAYS_MS[transientAttempt++];
        console.warn(`[AI] transient error, retrying in ${delay}ms:`, error.message);
        await sleep(delay);
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

// Streaming call — emits tokens via onToken(chunk, fullContent) callback
// Returns { content, reasoning, model } when done
export async function stream(prompt, onToken, {
  apiBase,
  apiKey,
  model,
  maxTokens = 1200,
  timeoutMs = 90_000,
  systemPrompt = 'You are a search assistant. Write your answer directly. Do not include reasoning or thinking.',
  temperature = 0.3,
} = {}) {
  const base = String(apiBase || '').replace(/\/$/, '');
  if (!base || !model) throw buildAiError('ai_unavailable', 'AI not configured');

  const messages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }]
    : [{ role: 'user', content: prompt }];
  const body = JSON.stringify({ messages, max_tokens: maxTokens, temperature, model, stream: true });

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  let rateLimitAttempt = 0;
  let transientAttempt = 0;

  while (true) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let emittedAny = false;
    try {
      const response = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers,
        body,
        signal: ac.signal,
      });

      if (response.status === 401 || response.status === 403) {
        throw buildAiError('ai_provider_auth', `ai ${response.status}: authentication failed`);
      }
      if (response.status === 429) {
        if (rateLimitAttempt < RATE_LIMIT_RETRY_DELAYS_MS.length) {
          const retryAfter = Number(response.headers.get('retry-after') || 0);
          const delay = retryAfter > 0 ? retryAfter * 1000 : RATE_LIMIT_RETRY_DELAYS_MS[rateLimitAttempt++];
          await sleep(delay);
          continue;
        }
        return { content: '', reasoning: '', model };
      }
      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        const err = new Error(`ai ${response.status}: ${errBody.slice(0, 220)}`);
        if (shouldRetry(err) && !emittedAny && transientAttempt < TRANSIENT_RETRY_DELAYS_MS.length) {
          await sleep(TRANSIENT_RETRY_DELAYS_MS[transientAttempt++]);
          continue;
        }
        throw err;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullContent = '';
      let fullReasoning = '';
      let buffer = '';
      let inThinking = false;
      let streamModel = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            if (!streamModel && parsed.model) streamModel = parsed.model;
            const delta = parsed.choices?.[0]?.delta || {};
            if (delta.reasoning_content) fullReasoning += delta.reasoning_content;
            if (delta.content) {
              let chunk = delta.content;
              if (inThinking) {
                const end = chunk.indexOf('</think>');
                if (end !== -1) { fullReasoning += chunk.slice(0, end); chunk = chunk.slice(end + 8); inThinking = false; }
                else { fullReasoning += chunk; continue; }
              } else if (chunk.includes('<think>')) {
                const start = chunk.indexOf('<think>');
                const end = chunk.indexOf('</think>');
                if (end !== -1) { fullReasoning += chunk.slice(start + 7, end); chunk = chunk.slice(0, start) + chunk.slice(end + 8); }
                else { inThinking = true; fullReasoning += chunk.slice(start + 7); chunk = chunk.slice(0, start); }
              }
              if (chunk) { emittedAny = true; fullContent += chunk; onToken(chunk, fullContent); }
            }
          } catch { /* ignore SSE parse errors */ }
        }
      }
      clearTimeout(timer);
      return { content: stripThinkingPrefix(fullContent.trim()), reasoning: fullReasoning.trim(), model: streamModel || model };
    } catch (error) {
      clearTimeout(timer);
      if (!emittedAny && shouldRetry(error) && classifyAiError(error) !== 'ai_rate_limited_provider' && transientAttempt < TRANSIENT_RETRY_DELAYS_MS.length) {
        await sleep(TRANSIENT_RETRY_DELAYS_MS[transientAttempt++]);
        continue;
      }
      throw error;
    }
  }
}
