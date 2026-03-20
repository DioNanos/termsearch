// All API route handlers

import express from 'express';
import { search, searchStream, getEnabledProviders, getDocCache } from '../search/engine.js';
import { batchFetch, fetchReadableDocument } from '../fetch/document.js';
import { generateSummary, testConnection } from '../ai/orchestrator.js';
import { refineQuery } from '../ai/query.js';
import { sendJson, sendRateLimited, applySecurityHeaders } from './middleware.js';
import { getStatus as autostartStatus, setEnabled as autostartSetEnabled } from '../autostart/manager.js';
import { detectProfileTarget, scanProfile, PROFILER_PLATFORMS } from '../profiler/scanner.js';
import { fetchBlueskyPosts, fetchBlueskyActors, fetchGdeltArticles } from '../social/search.js';
import { scrapeTPB, scrape1337x, extractMagnetFromUrl } from '../torrent/scrapers.js';

const APP_VERSION = '0.3.0';
const ALLOWED_CATEGORIES = new Set(['web', 'images', 'news']);

function parseCategory(raw) {
  const category = String(raw || 'web').trim().toLowerCase();
  return ALLOWED_CATEGORIES.has(category) ? category : 'web';
}

function parseEngines(raw) {
  if (!raw) return [];
  const source = Array.isArray(raw) ? raw.join(',') : String(raw);
  return [...new Set(
    source
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 12)
  )];
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

    const lang = String(req.query.lang || 'en-US');
    const safe = String(req.query.safe || '1');
    const page = Number(req.query.page || '1');
    const category = parseCategory(req.query.cat);
    const engines = parseEngines(req.query.engines);

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

    const lang = String(req.query.lang || 'en-US');
    const safe = String(req.query.safe || '1');
    const page = Number(req.query.page || '1');
    const category = parseCategory(req.query.cat);
    const engines = parseEngines(req.query.engines);

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
          });
        } else {
          send({
            batch: 'full',
            query: q,
            lang,
            results: chunk.results || [],
            allResults: chunk.results || [],
            providers: chunk.providers || [],
            degraded: false,
            engineStats: { responded: chunk.providers || [], failed: [], unstable: [], health: {} },
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
    const lang = String(req.body?.lang || 'en-US');
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
    const lang = String(req.body?.lang || 'en-US');
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
          onToken: (chunk) => sendEvent('token', { chunk }),
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
    const allowed = ['port', 'host', 'ai', 'brave', 'mojeek', 'searxng', 'search', 'rate_limit'];
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
        results = await searxSearch({ query: testQuery, config: cfg, timeoutMs: 8000 });
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
