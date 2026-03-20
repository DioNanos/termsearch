// All API route handlers

import express from 'express';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { search, searchStream, getEnabledProviders, getDocCache, ALLOWED_ENGINES } from '../search/engine.js';
import { batchFetch, fetchReadableDocument } from '../fetch/document.js';
import { generateSummary, testConnection } from '../ai/orchestrator.js';
import { refineQuery } from '../ai/query.js';
import { sendJson, sendRateLimited, applySecurityHeaders } from './middleware.js';
import { getStatus as autostartStatus, setEnabled as autostartSetEnabled } from '../autostart/manager.js';
import { detectProfileTarget, scanProfile, PROFILER_PLATFORMS } from '../profiler/scanner.js';
import { fetchBlueskyPosts, fetchBlueskyActors, fetchGdeltArticles } from '../social/search.js';
import { scrapeTPB, scrape1337x, extractMagnetFromUrl } from '../torrent/scrapers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_VERSION = (() => {
  try {
    const pkgPath = path.join(__dirname, '../../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return String(pkg.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
})();
const ALLOWED_CATEGORIES = new Set(['web', 'images', 'news']);
const ALLOWED_LANGS = new Set(['auto', 'it-IT', 'en-US', 'es-ES', 'fr-FR', 'de-DE', 'pt-PT', 'ru-RU', 'zh-CN', 'ja-JP']);

function parseCategory(raw) {
  const category = String(raw || 'web').trim().toLowerCase();
  return ALLOWED_CATEGORIES.has(category) ? category : 'web';
}

function parseEngines(raw) {
  if (!raw) return [];
  const source = Array.isArray(raw) ? raw.join(',') : String(raw);
  const parsed = [...new Set(
    source
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 12)
  )];
  if (!parsed.every((engine) => ALLOWED_ENGINES.has(engine))) return null;
  return parsed;
}

function normalizeLang(raw) {
  const input = String(raw || '').trim();
  if (!input) return null;
  const lower = input.toLowerCase();
  const exact = [...ALLOWED_LANGS].find((lang) => lang.toLowerCase() === lower);
  if (exact) return exact;
  const shortMap = {
    it: 'it-IT',
    en: 'en-US',
    es: 'es-ES',
    fr: 'fr-FR',
    de: 'de-DE',
    pt: 'pt-PT',
    ru: 'ru-RU',
    zh: 'zh-CN',
    ja: 'ja-JP',
  };
  return shortMap[lower] || null;
}

function resolveLang(rawLang, acceptLanguageHeader = '') {
  const normalized = normalizeLang(rawLang || 'auto');
  if (normalized && normalized !== 'auto') return normalized;
  const first = String(acceptLanguageHeader || '')
    .split(',')
    .map((part) => part.trim().split(';')[0])
    .find(Boolean);
  const fromHeader = normalizeLang(first || '');
  return fromHeader || 'en-US';
}

function normalizeBase(rawBase) {
  const raw = String(rawBase || '').trim();
  if (!raw) return '';
  return raw.replace(/\/$/, '');
}

function detectModelProvider(base, preset = '') {
  const p = String(preset || '').trim().toLowerCase();
  if (p === 'openroute') return 'openrouter';
  if (p && p !== 'custom') return p;
  const b = String(base || '').toLowerCase();
  if (b.includes('anthropic.com')) return 'anthropic';
  if (b.includes('openrouter.ai')) return 'openrouter';
  if (b.includes('openai.com')) return 'openai';
  if (b.includes('chutes.ai')) return 'chutes';
  if (b.includes(':11434')) return 'ollama';
  if (b.includes(':1234')) return 'lmstudio';
  if (b.includes(':8080')) return 'llamacpp';
  return 'openai_compat';
}

function parseModelPayload(payload) {
  if (Array.isArray(payload)) {
    return payload.map((item) => typeof item === 'string' ? item.trim() : String(item?.id || item?.name || '').trim()).filter(Boolean);
  }
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.data)) {
    return payload.data.map((item) => String(item?.id || '').trim()).filter(Boolean);
  }
  if (Array.isArray(payload.models)) {
    return payload.models.map((item) => typeof item === 'string' ? item.trim() : String(item?.id || item?.name || '').trim()).filter(Boolean);
  }
  if (Array.isArray(payload?.result?.models)) {
    return payload.result.models.map((item) => typeof item === 'string' ? item.trim() : String(item?.id || item?.name || '').trim()).filter(Boolean);
  }
  return [];
}

function buildModelAuthVariants(provider, apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) return [{ Accept: 'application/json' }];
  if (provider === 'chutes') {
    return [
      { Accept: 'application/json', Authorization: `Bearer ${key}` },
      { Accept: 'application/json', 'x-api-key': key },
      { Accept: 'application/json', Authorization: `Bearer ${key}`, 'x-api-key': key },
    ];
  }
  return [{ Accept: 'application/json', Authorization: `Bearer ${key}` }];
}

async function fetchOpenAiCompatibleModels(base, apiKey, provider = 'openai_compat', timeoutMs = 10000) {
  const variants = buildModelAuthVariants(provider, apiKey);
  for (const headers of variants) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const response = await fetch(`${base}/models`, { headers, signal: ac.signal });
      if (!response.ok) continue;
      const payload = await response.json();
      const parsed = parseModelPayload(payload);
      if (parsed.length > 0) return parsed;
    } catch {
      // try next variant
    } finally {
      clearTimeout(timer);
    }
  }
  return [];
}

async function fetchOpenRouterModels(base, apiKey, timeoutMs = 10000) {
  const endpoint = base.includes('/api/v1') ? `${base}/models` : `${base}/api/v1/models`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const headers = { Accept: 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await fetch(endpoint, { headers, signal: ac.signal });
    if (!response.ok) return [];
    const payload = await response.json();
    return parseModelPayload(payload);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAnthropicModels(base, apiKey, timeoutMs = 10000) {
  if (!apiKey) return [];
  const endpoint = base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      headers: {
        Accept: 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: ac.signal,
    });
    if (!response.ok) return [];
    const payload = await response.json();
    return parseModelPayload(payload);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOllamaModels(base, timeoutMs = 10000) {
  const origin = (() => {
    try {
      const u = new URL(base);
      return `${u.protocol}//${u.host}`;
    } catch {
      return base;
    }
  })();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const response = await fetch(`${origin}/api/tags`, { headers: { Accept: 'application/json' }, signal: ac.signal });
    if (!response.ok) return [];
    const payload = await response.json();
    return (payload?.models || [])
      .map((item) => String(item?.name || '').trim())
      .filter(Boolean);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export function createRouter(config, rateLimiters) {
  const router = express.Router();

  // ─── Health ──────────────────────────────────────────────────────────────
  router.get('/api/health', (req, res) => {
    const cfg = config.getConfig();
    sendJson(res, 200, {
      status: 'ok',
      version: APP_VERSION,
      providers: getEnabledProviders(cfg),
      ai_enabled: Boolean(cfg.ai?.enabled && cfg.ai?.api_base && cfg.ai?.model),
      ai_model: cfg.ai?.model || null,
    });
  });

  // ─── OpenSearch (dynamic — adapts to host/port) ─────────────────────────
  router.get('/opensearch.xml', (req, res) => {
    const proto = req.protocol;
    const host = req.get('host') || `${req.hostname}:${req.socket.localPort}`;
    const origin = `${proto}://${host}`;
    res.setHeader('Content-Type', 'application/opensearchdescription+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>TermSearch</ShortName>
  <Description>TermSearch — personal search engine</Description>
  <InputEncoding>UTF-8</InputEncoding>
  <Image height="64" width="64" type="image/svg+xml">${origin}/icon.svg</Image>
  <Url type="text/html" method="get" template="${origin}/#/?q={searchTerms}"/>
</OpenSearchDescription>`);
  });

  // ─── OpenAPI ─────────────────────────────────────────────────────────────
  router.get('/api/openapi.json', (_req, res) => {
    applySecurityHeaders(res);
    res.json({
      openapi: '3.1.0',
      info: {
        title: 'TermSearch API',
        version: APP_VERSION,
      },
      paths: {
        '/api/health': { get: { summary: 'Service health' } },
        '/api/search': { get: { summary: 'Search results (JSON)' } },
        '/api/search-stream': { get: { summary: 'Progressive search (SSE)' } },
        '/api/fetch': { post: { summary: 'Fetch readable documents' } },
        '/api/ai-summary': { post: { summary: 'AI summary (SSE/JSON)' } },
        '/api/ai-query': { post: { summary: 'AI query refinement' } },
        '/api/social-search': { get: { summary: 'Bluesky + GDELT search' } },
        '/api/profiler': { get: { summary: 'Social profile scanner' } },
        '/api/torrent-search': { post: { summary: 'Torrent direct scraping' } },
        '/api/magnet': { post: { summary: 'Extract magnet from page URL' } },
        '/api/scan': { post: { summary: 'Scan site pages by query' } },
        '/api/config': { get: { summary: 'Read config (masked)' }, post: { summary: 'Update config' } },
        '/api/config/models': { post: { summary: 'List AI models from selected provider endpoint' } },
      },
    });
  });

  // ─── Search (single response) ─────────────────────────────────────────────
  router.get('/api/search', async (req, res) => {
    const ip = req.clientIp;
    if (!rateLimiters.checkSearch(ip)) {
      return sendRateLimited(res, { windowMs: rateLimiters.windowMs });
    }

    const cfg = config.getConfig();
    const q = String(req.query.q || '').trim();
    if (!q) return sendJson(res, 400, { error: 'missing_query', message: 'q parameter required' });
    if (q.length > cfg.search.max_query_length) return sendJson(res, 400, { error: 'query_too_long' });

    const lang = resolveLang(req.query.lang, req.headers['accept-language']);
    const safe = String(req.query.safe || '1');
    const page = Number(req.query.page || '1');
    const category = parseCategory(req.query.cat);
    const engines = parseEngines(req.query.engines);
    if (engines === null) return sendJson(res, 400, { error: 'invalid_engines', message: 'engines must be a comma-separated allowlisted set.' });

    try {
      const result = await search({ query: q, lang, safe, page, category, engines }, cfg);
      applySecurityHeaders(res);
      res.json(result);
    } catch (error) {
      sendJson(res, 500, { error: 'search_failed', message: error.message });
    }
  });

  // ─── Search stream (SSE) ──────────────────────────────────────────────────
  router.get('/api/search-stream', async (req, res) => {
    const ip = req.clientIp;
    if (!rateLimiters.checkSearch(ip)) {
      return sendRateLimited(res, { windowMs: rateLimiters.windowMs });
    }

    const cfg = config.getConfig();
    const q = String(req.query.q || '').trim();
    if (!q) return sendJson(res, 400, { error: 'missing_query' });
    if (q.length > cfg.search.max_query_length) return sendJson(res, 400, { error: 'query_too_long' });

    const lang = resolveLang(req.query.lang, req.headers['accept-language']);
    const safe = String(req.query.safe || '1');
    const page = Number(req.query.page || '1');
    const category = parseCategory(req.query.cat);
    const engines = parseEngines(req.query.engines);
    if (engines === null) return sendJson(res, 400, { error: 'invalid_engines', message: 'engines must be a comma-separated allowlisted set.' });

    applySecurityHeaders(res);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    try {
      for await (const chunk of searchStream({ query: q, lang, safe, page, category, engines }, cfg)) {
        if (chunk.tier === 'fast') {
          send({
            batch: 'fast',
            query: q,
            lang,
            results: chunk.results || [],
            providers: chunk.providers || [],
            degraded: chunk.degraded === true,
            engineStats: chunk.engineStats || { responded: chunk.providers || [], failed: [], unstable: [], health: {} },
          });
        } else {
          send({
            batch: 'full',
            query: q,
            lang,
            results: chunk.results || [],
            allResults: chunk.results || [],
            providers: chunk.providers || [],
            degraded: chunk.degraded === true,
            engineStats: chunk.engineStats || { responded: chunk.providers || [], failed: [], unstable: [], health: {} },
          });
        }
      }
      send({ done: true, providers: getEnabledProviders(cfg) });
    } catch (error) {
      send({ error: 'search_failed', message: error.message });
    } finally {
      res.end();
    }
  });

  // ─── Fetch document(s) ────────────────────────────────────────────────────
  router.post('/api/fetch', express.json({ limit: '32kb' }), async (req, res) => {
    const ip = req.clientIp;
    if (!rateLimiters.checkGeneral(ip)) {
      return sendRateLimited(res, { windowMs: rateLimiters.windowMs });
    }

    const cfg = config.getConfig();
    const urls = req.body?.urls;
    if (!Array.isArray(urls) || urls.length === 0) {
      return sendJson(res, 400, { error: 'missing_urls' });
    }
    if (urls.length > 10) return sendJson(res, 400, { error: 'too_many_urls', max: 10 });

    const results = await batchFetch(urls.slice(0, 10), {
      timeoutMs: cfg.search.timeout_ms,
      docCache: getDocCache(),
    });
    applySecurityHeaders(res);
    res.json({ results });
  });

  // ─── AI query refinement ──────────────────────────────────────────────────
  router.post('/api/ai-query', express.json({ limit: '16kb' }), async (req, res) => {
    const ip = req.clientIp;
    if (!rateLimiters.checkAi(ip)) {
      return sendRateLimited(res, { windowMs: rateLimiters.aiWindowMs });
    }

    const cfg = config.getConfig();
    if (!cfg.ai?.enabled) return sendJson(res, 200, { refined_query: req.body?.query, intent: 'other', also_search: [] });

    const query = String(req.body?.query || '').trim();
    const lang = resolveLang(req.body?.lang, req.headers['accept-language']);
    if (!query) return sendJson(res, 400, { error: 'missing_query' });

    const result = await refineQuery({ query, lang }, cfg.ai);
    applySecurityHeaders(res);
    res.json(result || { refined_query: query, intent: 'other', also_search: [] });
  });

  // ─── AI summary (SSE streaming) ────────────────────────────────────────────
  router.post('/api/ai-summary', express.json({ limit: '256kb' }), async (req, res) => {
    const ip = req.clientIp;
    if (!rateLimiters.checkAi(ip)) {
      return sendRateLimited(res, { windowMs: rateLimiters.aiWindowMs });
    }

    const cfg = config.getConfig();
    if (!cfg.ai?.enabled || !cfg.ai?.api_base || !cfg.ai?.model) {
      return sendJson(res, 200, {
        error: 'ai_not_configured',
        message: 'AI not configured. Go to Settings to add your endpoint.',
      });
    }

    const query = String(req.body?.query || '').trim();
    const lang = resolveLang(req.body?.lang, req.headers['accept-language']);
    const results = Array.isArray(req.body?.results) ? req.body.results : [];
    const session = Array.isArray(req.body?.session) ? req.body.session.slice(-4) : [];
    const streamMode = req.body?.stream !== false;

    if (!query) return sendJson(res, 400, { error: 'missing_query' });

    if (streamMode) {
      applySecurityHeaders(res);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      const sendEvent = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      const result = await generateSummary(
        {
          query, lang, results, session,
          onToken:    (chunk) => sendEvent('token',    { chunk }),
          onProgress: (p)     => sendEvent('progress', { progress: p }),
          onStep:     (text)  => sendEvent('step',     { step: text }),
          docCache: getDocCache(),
        },
        cfg.ai
      );

      if (result.error) {
        sendEvent('error', { error: result.error, message: result.message });
      } else {
        sendEvent('done', {
          sites: result.sites,
          fetchedCount: result.fetchedCount,
          scoredResults: result.scoredResults,
          model: result.model,
        });
      }
      return res.end();
    }

    // Non-streaming mode
    const result = await generateSummary({ query, lang, results, session, docCache: getDocCache() }, cfg.ai);
    if (result.error) {
      return sendJson(res, result.status || 502, { error: result.error, message: result.message });
    }
    applySecurityHeaders(res);
    res.json(result);
  });

  // ─── Config (public — keys masked) ────────────────────────────────────────
  router.get('/api/config', (req, res) => {
    applySecurityHeaders(res);
    res.json(config.getPublicConfig());
  });

  // ─── Config update ─────────────────────────────────────────────────────────
  router.post('/api/config', express.json({ limit: '16kb' }), (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object') {
      return sendJson(res, 400, { error: 'invalid_body' });
    }
    // Whitelist accepted config keys to prevent unexpected writes
    const allowed = ['port', 'host', 'ai', 'brave', 'mojeek', 'yandex', 'ahmia', 'marginalia', 'searxng', 'search', 'rate_limit'];
    const filtered = {};
    for (const key of allowed) {
      if (key in body) filtered[key] = body[key];
    }
    try {
      config.update(filtered);
      applySecurityHeaders(res);
      res.json({ ok: true, config: config.getPublicConfig() });
    } catch (error) {
      sendJson(res, 500, { error: 'config_save_failed', message: error.message });
    }
  });

  // ─── Test AI connection ────────────────────────────────────────────────────
  router.post('/api/config/test-ai', express.json({ limit: '8kb' }), async (req, res) => {
    const cfg = config.getConfig();
    const body = req.body || {};
    const testCfg = {
      api_base: String(body.api_base || cfg.ai?.api_base || ''),
      api_key: String(body.api_key || cfg.ai?.api_key || ''),
      model: String(body.model || cfg.ai?.model || ''),
    };
    const result = await testConnection(testCfg);
    applySecurityHeaders(res);
    res.json(result);
  });

  router.get('/api/config/test-ai', (_req, res) => {
    sendJson(res, 405, { error: 'method_not_allowed', message: 'Use POST /api/config/test-ai' });
  });

  // ─── Fetch provider model list ───────────────────────────────────────────
  router.post('/api/config/models', express.json({ limit: '8kb' }), async (req, res) => {
    const ip = req.clientIp;
    if (!rateLimiters.checkGeneral(ip)) {
      return sendRateLimited(res, { windowMs: rateLimiters.windowMs });
    }
    const cfg = config.getConfig();
    const base = normalizeBase(req.body?.api_base || cfg.ai?.api_base || '');
    const apiKey = String(req.body?.api_key || cfg.ai?.api_key || '');
    const preset = String(req.body?.preset || '').trim().toLowerCase();
    if (!base) return sendJson(res, 400, { ok: false, error: 'missing_api_base' });

    const provider = detectModelProvider(base, preset);
    let models = [];
    if (provider === 'anthropic') {
      models = await fetchAnthropicModels(base, apiKey);
    } else if (provider === 'openrouter') {
      models = await fetchOpenRouterModels(base, apiKey);
    } else if (provider === 'ollama') {
      models = await fetchOllamaModels(base);
      if (models.length === 0) {
        models = await fetchOpenAiCompatibleModels(base, apiKey, provider);
      }
    } else {
      models = await fetchOpenAiCompatibleModels(base, apiKey, provider);
    }

    models = [...new Set(models)].slice(0, 80);
    applySecurityHeaders(res);
    res.json({ ok: true, provider, models });
  });

  // ─── Test search provider ─────────────────────────────────────────────────
  router.get('/api/config/test-provider/:name', async (req, res) => {
    const cfg = config.getConfig();
    const name = String(req.params.name || '');
    const testQuery = 'test';

    try {
      let results = [];
      if (name === 'duckduckgo') {
        const { search: ddgSearch } = await import('../search/providers/duckduckgo.js');
        results = await ddgSearch({ query: testQuery, timeoutMs: 8000 });
      } else if (name === 'wikipedia') {
        const { search: wikiSearch } = await import('../search/providers/wikipedia.js');
        results = await wikiSearch({ query: testQuery, timeoutMs: 8000 });
      } else if (name === 'brave') {
        const { search: braveSearch } = await import('../search/providers/brave.js');
        results = await braveSearch({ query: testQuery, config: cfg, timeoutMs: 8000 });
      } else if (name === 'mojeek') {
        const { search: mojeekSearch } = await import('../search/providers/mojeek.js');
        results = await mojeekSearch({ query: testQuery, config: cfg, timeoutMs: 8000 });
      } else if (name === 'searxng') {
        const { search: searxSearch } = await import('../search/providers/searxng.js');
        const response = await searxSearch({ query: testQuery, config: cfg, timeoutMs: 8000 });
        results = Array.isArray(response) ? response : (response?.results || []);
      } else if (name === 'github') {
        const { search: githubSearch } = await import('../search/providers/github.js');
        results = await githubSearch({ query: testQuery, config: cfg, timeoutMs: 8000 });
      } else {
        return sendJson(res, 400, { error: 'unknown_provider' });
      }
      applySecurityHeaders(res);
      res.json({ ok: results.length > 0, count: results.length, sample: results.slice(0, 2) });
    } catch (error) {
      sendJson(res, 200, { ok: false, error: error.message });
    }
  });

  // ─── Stats ────────────────────────────────────────────────────────────────
  router.get('/api/stats', (req, res) => {
    applySecurityHeaders(res);
    // TODO: implement persistent stats counter
    res.json({ searches: 0, uptime_ms: process.uptime() * 1000 });
  });

  // ─── Profiler ─────────────────────────────────────────────────────────────────
  router.get('/api/profiler', async (req, res) => {
    const ip  = req.clientIp;
    if (!rateLimiters.checkGeneral(ip)) return sendRateLimited(res, { windowMs: rateLimiters.windowMs });
    const raw = String(req.query.q || '').trim();
    if (!raw) return sendJson(res, 400, { error: 'missing_query', message: 'q required (URL or @handle)' });
    const target = detectProfileTarget(raw);
    if (!target) return sendJson(res, 400, { error: 'not_a_profile', message: 'Could not detect a social profile in query' });
    try {
      applySecurityHeaders(res);
      const result = await scanProfile(target);
      res.json(result);
    } catch (error) {
      sendJson(res, 500, { error: 'profiler_failed', message: error.message });
    }
  });

  // ─── Social search ─────────────────────────────────────────────────────────
  router.get('/api/social-search', async (req, res) => {
    const ip  = req.clientIp;
    if (!rateLimiters.checkGeneral(ip)) return sendRateLimited(res, { windowMs: rateLimiters.windowMs });
    const q       = String(req.query.q || '').trim();
    if (!q) return sendJson(res, 400, { error: 'missing_query' });
    const limit   = Math.min(parseInt(req.query.limit) || 25, 50);
    const sources = String(req.query.sources || 'bluesky,gdelt').split(',').map((s) => s.trim()).filter(Boolean);
    const taskMap = {};
    if (sources.includes('bluesky')) {
      taskMap.bluesky_posts  = fetchBlueskyPosts(q, limit);
      taskMap.bluesky_actors = fetchBlueskyActors(q, Math.min(limit, 20));
    }
    if (sources.includes('gdelt')) taskMap.gdelt = fetchGdeltArticles(q, limit);
    const keys    = Object.keys(taskMap);
    const settled = await Promise.allSettled(Object.values(taskMap));
    const results = {};
    keys.forEach((key, i) => { results[key] = settled[i].status === 'fulfilled' ? settled[i].value : []; });
    const total   = Object.values(results).reduce((s, arr) => s + arr.length, 0);
    applySecurityHeaders(res);
    res.json({ query: q, total, results });
  });

  // ─── Torrent search ─────────────────────────────────────────────────────────
  router.post('/api/torrent-search', express.json(), async (req, res) => {
    const ip = req.clientIp;
    if (!rateLimiters.checkGeneral(ip)) return sendRateLimited(res, { windowMs: rateLimiters.windowMs });
    const query = String(req.body?.q || req.body?.query || '').trim().slice(0, 200);
    if (!query) return sendJson(res, 400, { error: 'missing_query', message: 'q required' });
    try {
      const [tpb, lxx] = await Promise.allSettled([scrapeTPB(query, 8), scrape1337x(query, 7)]);
      const results = [
        ...(tpb.status === 'fulfilled' ? tpb.value : []),
        ...(lxx.status === 'fulfilled' ? lxx.value : []),
      ];
      applySecurityHeaders(res);
      res.json({ results, source: results.length ? 'tpb+1337x' : 'none' });
    } catch (error) {
      sendJson(res, 502, { error: 'scrape_failed', message: error.message });
    }
  });

  router.post('/api/magnet', express.json(), async (req, res) => {
    const ip = req.clientIp;
    if (!rateLimiters.checkGeneral(ip)) return sendRateLimited(res, { windowMs: rateLimiters.windowMs });
    const rawUrl = String(req.body?.url || '').trim();
    if (!rawUrl || !/^https?:\/\//.test(rawUrl)) return sendJson(res, 400, { error: 'invalid_url' });
    try {
      const magnet = await extractMagnetFromUrl(rawUrl);
      applySecurityHeaders(res);
      res.json({ magnet });
    } catch (error) {
      sendJson(res, error.message.includes('SSRF') ? 400 : 502, { error: 'fetch_failed', message: error.message });
    }
  });

  // ─── Site scan ──────────────────────────────────────────────────────────────
  router.post('/api/scan', express.json(), async (req, res) => {
    const ip = req.clientIp;
    if (!rateLimiters.checkGeneral(ip)) return sendRateLimited(res, { windowMs: rateLimiters.windowMs });
    const rawUrl   = String(req.body?.url || '').trim();
    const query    = String(req.body?.query || '').trim().slice(0, 200);
    const maxPages = Math.min(Number(req.body?.max_pages) || 4, 8);
    if (!rawUrl || !query) return sendJson(res, 400, { error: 'invalid_input', message: 'url and query required' });
    try {
      const { scanSitePages } = await import('../fetch/document.js');
      const pages = await scanSitePages(rawUrl, query, maxPages);
      applySecurityHeaders(res);
      res.json({ pages: pages.map((p) => ({ url: p.url, title: p.title, content: p.content.slice(0, 3000) })) });
    } catch (error) {
      sendJson(res, 502, { error: 'scan_failed', message: error.message });
    }
  });

  // ─── Autostart ────────────────────────────────────────────────────────────
  router.get('/api/autostart', (req, res) => {
    applySecurityHeaders(res);
    try {
      res.json(autostartStatus());
    } catch (error) {
      sendJson(res, 500, { error: 'autostart_check_failed', message: error.message });
    }
  });

  router.post('/api/autostart', express.json(), (req, res) => {
    applySecurityHeaders(res);
    const enable = Boolean(req.body?.enabled);
    try {
      const status = autostartSetEnabled(enable);
      res.json({ ok: true, ...status });
    } catch (error) {
      sendJson(res, 500, { error: 'autostart_failed', message: error.message });
    }
  });

  return router;
}
