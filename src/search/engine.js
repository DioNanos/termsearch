// Search orchestrator — fan-out to enabled providers, merge, rank, cache

import path from 'path';
import { makeTieredCache, searchCacheKey } from './cache.js';
import { mergeSearchResultSets, rankResultsBySourceDiversity } from './ranking.js';
import * as ddg from './providers/duckduckgo.js';
import * as wikipedia from './providers/wikipedia.js';
import * as brave from './providers/brave.js';
import * as mojeek from './providers/mojeek.js';
import * as searxng from './providers/searxng.js';
import * as github from './providers/github.js';
import * as yandex from './providers/yandex.js';
import * as ahmia from './providers/ahmia.js';
import * as marginalia from './providers/marginalia.js';
import * as startpage from './providers/startpage.js';
import * as qwant from './providers/qwant.js';
import * as ecosia from './providers/ecosia.js';

let _searchCache = null;
let _docCache = null;

const ENGINE_HEALTH_HISTORY_LIMIT = 16;
const ENGINE_HEALTH_STORE = new Map();
const INFLIGHT_SEARCH_STORE = new Map();

export const ALLOWED_ENGINES = new Set([
  'brave',
  'duckduckgo',
  'startpage',
  'qwant',
  'mojeek',
  'google',
  'bing',
  'yahoo',
  'gigablast',
  'yacy',
  'wikipedia',
  'wikidata',
  'reddit',
  'github',
  'youtube',
  'hackernews',
  'mastodon users',
  'mastodon hashtags',
  'tootfinder',
  'lemmy communities',
  'lemmy users',
  'lemmy posts',
  'lemmy comments',
  'lobste.rs',
  'sepiasearch',
  'crossref',
  'openalex',
  'openlibrary',
  '1337x',
  'piratebay',
  'nyaa',
  'yts',
  'eztv',
  'tgx',
  // native scrapers
  'qwant',
  'ecosia',
  // uncensored / alternative index engines
  'yandex',
  'ahmia',
  'marginalia',
  // local aliases for direct providers
  'ddg',
  'wiki',
  'searxng',
  'searx',
  'github-api',
]);

const CURATED_WEB_ENGINES = ['bing', 'startpage', 'yahoo', 'mojeek', 'github', 'reddit', 'youtube', 'hackernews'];

const PROVIDER_REGISTRY = {
  duckduckgo: {
    aliases: new Set(['duckduckgo', 'ddg']),
    enabled: (_cfg) => true,
    run: ddg.search,
    defaultProvider: true,
  },
  wikipedia: {
    aliases: new Set(['wikipedia', 'wiki']),
    enabled: (_cfg) => true,
    run: wikipedia.search,
    defaultProvider: true,
  },
  brave: {
    aliases: new Set(['brave']),
    enabled: (cfg) => Boolean(cfg.brave?.enabled && cfg.brave?.api_key),
    run: brave.search,
    defaultProvider: true,
  },
  mojeek: {
    aliases: new Set(['mojeek']),
    enabled: (cfg) => Boolean(cfg.mojeek?.enabled && cfg.mojeek?.api_key),
    run: mojeek.search,
    defaultProvider: true,
  },
  searxng: {
    aliases: new Set(['searxng', 'searx']),
    enabled: (cfg) => Boolean(cfg.searxng?.enabled && cfg.searxng?.url),
    run: searxng.search,
    defaultProvider: true,
  },
  startpage: {
    aliases: new Set(['startpage']),
    enabled: (cfg) => cfg?.startpage?.enabled !== false,
    run: startpage.search,
    defaultProvider: true,
  },
  qwant: {
    aliases: new Set(['qwant']),
    enabled: (cfg) => cfg?.qwant?.enabled !== false,
    run: qwant.search,
    defaultProvider: true,
  },
  ecosia: {
    aliases: new Set(['ecosia']),
    enabled: (cfg) => cfg?.ecosia?.enabled !== false,
    run: ecosia.search,
    defaultProvider: true,
  },
  github: {
    aliases: new Set(['github', 'github-api']),
    enabled: (_cfg) => true,
    run: github.search,
    defaultProvider: false,
  },
  yandex: {
    aliases: new Set(['yandex']),
    enabled: (cfg) => cfg?.yandex?.enabled !== false,
    run: yandex.search,
    defaultProvider: true,
  },
  ahmia: {
    aliases: new Set(['ahmia']),
    enabled: (cfg) => cfg?.ahmia?.enabled !== false,
    run: ahmia.search,
    defaultProvider: true,
  },
  marginalia: {
    aliases: new Set(['marginalia']),
    enabled: (cfg) => cfg?.marginalia?.enabled !== false,
    run: marginalia.search,
    defaultProvider: true,
  },
};

export function initCaches(dataDir, cfg) {
  const sc = cfg.search;
  _searchCache = makeTieredCache(
    sc.cache_l1_max_search,
    path.join(dataDir, 'cache', 'search'),
    sc.disk_max_search_entries,
    sc.disk_max_search_bytes,
  );
  _docCache = makeTieredCache(
    sc.cache_l1_max_docs,
    path.join(dataDir, 'cache', 'docs'),
    sc.disk_max_doc_entries,
    sc.disk_max_doc_bytes,
  );
}

export function getDocCache() {
  return _docCache;
}

function normalizeEngineName(engine) {
  return String(engine || '').trim().toLowerCase();
}

function normalizeRequestedEngines(input) {
  if (!Array.isArray(input)) return [];
  return [...new Set(
    input
      .map((item) => normalizeEngineName(item))
      .filter(Boolean)
  )];
}

function resolveProviderPlan(cfg, requestedEngines = [], category = 'web') {
  const requested = normalizeRequestedEngines(requestedEngines);
  const enabledProviders = Object.keys(PROVIDER_REGISTRY).filter((name) => PROVIDER_REGISTRY[name].enabled(cfg));

  const defaultProviders = enabledProviders.filter((name) => PROVIDER_REGISTRY[name].defaultProvider !== false);

  if (requested.length === 0) {
    return {
      providers: defaultProviders,
      searxEngines: category === 'web' && defaultProviders.includes('searxng') ? CURATED_WEB_ENGINES.slice() : [],
    };
  }

  const explicitProviders = new Set();
  const searxEngines = [];

  for (const engine of requested) {
    const mapped = enabledProviders.find((provider) => PROVIDER_REGISTRY[provider].aliases.has(engine));
    if (mapped) {
      explicitProviders.add(mapped);
    } else {
      searxEngines.push(engine);
    }
  }

  if (searxEngines.length > 0 && enabledProviders.includes('searxng')) {
    explicitProviders.add('searxng');
  }

  const providers = [...explicitProviders].filter((name) => enabledProviders.includes(name));
  if (providers.length === 0) {
    return { providers: [], searxEngines: [] };
  }

  return { providers, searxEngines };
}

function classifyEngineFailure(reason) {
  const raw = String(reason || '').toLowerCase();
  if (!raw) return null;
  if (raw.includes('captcha')) return 'captcha';
  if (raw.includes('429') || raw.includes('too many')) return 'too_many_requests';
  if (raw.includes('403') || raw.includes('access denied')) return 'access_denied';
  if (raw.includes('timeout') || raw.includes('aborted')) return 'timeout';
  if (raw.includes('unreachable') || raw.includes('network')) return 'network';
  return 'other';
}

function recordEngineOutcome(engine, ok, reason = null) {
  const key = normalizeEngineName(engine);
  if (!key) return;

  const entry = ENGINE_HEALTH_STORE.get(key) || {
    history: [],
    failureKinds: {},
    lastFailure: null,
    updatedAt: 0,
  };

  entry.history.push(ok ? 1 : 0);
  if (entry.history.length > ENGINE_HEALTH_HISTORY_LIMIT) entry.history.shift();

  if (!ok && reason) {
    const kind = classifyEngineFailure(reason) || 'other';
    entry.failureKinds[kind] = Number(entry.failureKinds[kind] || 0) + 1;
    entry.lastFailure = kind;
  }

  entry.updatedAt = Date.now();
  ENGINE_HEALTH_STORE.set(key, entry);
}

function getEngineHealth(engine) {
  const key = normalizeEngineName(engine);
  const entry = ENGINE_HEALTH_STORE.get(key);
  if (!entry || entry.history.length === 0) {
    return { status: 'unknown', samples: 0, successRate: null, penalty: 0, lastFailure: null, failureKinds: {} };
  }

  const samples = entry.history.length;
  const successes = entry.history.reduce((sum, v) => sum + v, 0);
  const successRate = successes / samples;

  if (samples >= 2 && successRate < 0.5) {
    return {
      status: 'poor',
      samples,
      successRate: Number(successRate.toFixed(2)),
      penalty: 1.2,
      lastFailure: entry.lastFailure,
      failureKinds: entry.failureKinds,
    };
  }

  if (successRate < 0.75) {
    return {
      status: 'unstable',
      samples,
      successRate: Number(successRate.toFixed(2)),
      penalty: 0.55,
      lastFailure: entry.lastFailure,
      failureKinds: entry.failureKinds,
    };
  }

  return {
    status: 'healthy',
    samples,
    successRate: Number(successRate.toFixed(2)),
    penalty: 0,
    lastFailure: entry.lastFailure,
    failureKinds: entry.failureKinds,
  };
}

function getEngineHealthSummary(engines = []) {
  const out = {};
  for (const engine of engines) {
    const key = normalizeEngineName(engine);
    if (!key || out[key]) continue;
    out[key] = getEngineHealth(key);
  }
  return out;
}

function withInflightSearch(key, factory) {
  if (INFLIGHT_SEARCH_STORE.has(key)) return INFLIGHT_SEARCH_STORE.get(key);
  const promise = Promise.resolve()
    .then(factory)
    .finally(() => {
      if (INFLIGHT_SEARCH_STORE.get(key) === promise) INFLIGHT_SEARCH_STORE.delete(key);
    });
  INFLIGHT_SEARCH_STORE.set(key, promise);
  return promise;
}

function normalizeProviderPayload(payload) {
  if (Array.isArray(payload)) return { results: payload, meta: {} };
  if (payload && typeof payload === 'object') {
    return {
      results: Array.isArray(payload.results) ? payload.results : [],
      meta: payload._meta || {},
    };
  }
  return { results: [], meta: { error: 'provider_invalid_payload' } };
}

async function runProviderDetailed(name, args) {
  const provider = PROVIDER_REGISTRY[name];
  if (!provider) {
    return {
      name,
      results: [],
      respondedEngines: [],
      failedEngines: [name],
      failedDetails: [{ engine: name, reason: 'provider_not_found' }],
    };
  }

  try {
    const payload = normalizeProviderPayload(await provider.run(args));
    const results = payload.results;
    const meta = payload.meta || {};

    const responded = new Set();
    const failed = new Set();
    const failedDetails = [];
    const skipHealth = new Set();

    if (name === 'searxng') {
      const unresponsive = Array.isArray(meta.unresponsive) ? meta.unresponsive.map((engine) => normalizeEngineName(engine)).filter(Boolean) : [];
      const unresponsiveDetails = Array.isArray(meta.unresponsiveDetails) ? meta.unresponsiveDetails : [];

      for (const item of results) {
        const eng = normalizeEngineName(item?.engine);
        if (!eng || unresponsive.includes(eng)) continue;
        responded.add(eng);
      }

      for (const engine of unresponsive) {
        failed.add(engine);
        const detail = unresponsiveDetails.find((entry) => normalizeEngineName(entry?.engine) === engine);
        failedDetails.push({ engine, reason: String(detail?.reason || 'unresponsive') });
      }

      if (meta.error) {
        failed.add('searxng');
        failedDetails.push({ engine: 'searxng', reason: String(meta.error) });
      }
    } else if (meta.error) {
      failed.add(name);
      failedDetails.push({ engine: name, reason: String(meta.error) });
    } else {
      responded.add(name);
      if (results.length === 0 || meta.skipHealth === true || meta.empty === true) {
        skipHealth.add(name);
      }
    }

    for (const engine of responded) {
      if (skipHealth.has(engine)) continue;
      recordEngineOutcome(engine, true);
    }
    for (const detail of failedDetails) recordEngineOutcome(detail.engine, false, detail.reason);

    return {
      name,
      results,
      respondedEngines: [...responded],
      failedEngines: [...failed],
      failedDetails,
    };
  } catch (error) {
    const reason = String(error?.message || 'provider_failed');
    recordEngineOutcome(name, false, reason);
    return {
      name,
      results: [],
      respondedEngines: [],
      failedEngines: [name],
      failedDetails: [{ engine: name, reason }],
    };
  }
}

function cacheEngineList(providerList, searxEngines = []) {
  const searx = searxEngines.map((engine) => `searx:${engine}`);
  return [...providerList, ...searx];
}

function buildEngineStats(respondedEngines = [], failedEngines = [], failedDetails = []) {
  const responded = [...new Set(respondedEngines.map((engine) => normalizeEngineName(engine)).filter(Boolean))];
  const failed = [...new Set(failedEngines.map((engine) => normalizeEngineName(engine)).filter(Boolean))];
  const details = failedDetails
    .map((item) => ({
      engine: normalizeEngineName(item?.engine),
      reason: String(item?.reason || ''),
    }))
    .filter((item) => item.engine);

  const health = getEngineHealthSummary([...responded, ...failed]);
  const unstable = Object.entries(health)
    .filter(([, meta]) => meta.status === 'unstable' || meta.status === 'poor')
    .map(([engine]) => engine)
    .sort();

  return {
    responded,
    failed,
    failedDetails: details,
    degraded: failed.length > 0,
    unstable,
    health,
  };
}

async function runSearchBatch({ query, lang, safe, page, category, engines, cfg }) {
  const plan = resolveProviderPlan(cfg, engines, category);
  const providerList = plan.providers;
  const timeoutMs = cfg.search.timeout_ms;

  if (providerList.length === 0) {
    return {
      results: [],
      providers: [],
      engineStats: buildEngineStats([], [], []),
      category,
    };
  }

  const runs = await Promise.all(providerList.map((providerName) =>
    runProviderDetailed(providerName, {
      query,
      lang,
      safe,
      page,
      category,
      config: cfg,
      timeoutMs,
      engines: providerName === 'searxng' ? plan.searxEngines : [],
    })
  ));

  let merged = [];
  const responded = [];
  const failed = [];
  const failedDetails = [];

  for (const run of runs) {
    merged = mergeSearchResultSets(merged, run.results);
    responded.push(...run.respondedEngines);
    failed.push(...run.failedEngines);
    failedDetails.push(...run.failedDetails);
  }

  return {
    results: rankResultsBySourceDiversity(merged),
    providers: providerList,
    engineStats: buildEngineStats(responded, failed, failedDetails),
    category,
    searxEngines: plan.searxEngines,
  };
}

// Run a search across enabled providers and return merged, ranked results
export async function search({ query, lang = 'en-US', safe = '1', page = 1, category = 'web', engines = [] }, cfg) {
  if (!_searchCache) throw new Error('Caches not initialized — call initCaches() first');

  const plan = resolveProviderPlan(cfg, engines, category);
  const cacheEngines = cacheEngineList(plan.providers, plan.searxEngines);
  const cacheKey = searchCacheKey(query, lang, safe, cacheEngines.length ? cacheEngines : ['none'], 'full', category, page);
  const cached = _searchCache.get(cacheKey);
  if (cached) return cached;

  const response = await withInflightSearch(`search:${cacheKey}`, async () => {
    const fresh = await runSearchBatch({ query, lang, safe, page, category, engines, cfg });
    return {
      results: fresh.results,
      query,
      lang,
      page: Number(page),
      total: fresh.results.length,
      providers: fresh.providers,
      category,
      degraded: fresh.engineStats.degraded,
      engineStats: fresh.engineStats,
    };
  });

  // Don't cache empty results — likely a transient block/CAPTCHA; retry on next request
  if (response.results.length > 0) {
    _searchCache.set(cacheKey, response, cfg.search.cache_ttl_search_ms);
  }
  return response;
}

// Streaming search: returns fast results first, then merged full results
export async function* searchStream({ query, lang = 'en-US', safe = '1', page = 1, category = 'web', engines = [] }, cfg) {
  const plan = resolveProviderPlan(cfg, engines, category);
  const providerList = plan.providers;

  if (providerList.length === 0) {
    const emptyStats = buildEngineStats([], [], []);
    yield { tier: 'full', results: [], providers: [], degraded: emptyStats.degraded, engineStats: emptyStats };
    return;
  }

  const timeoutMs = cfg.search.timeout_ms;
  const fastProvider = providerList.includes('duckduckgo')
    ? 'duckduckgo'
    : providerList[0];

  const fastRun = await runProviderDetailed(fastProvider, {
    query,
    lang,
    safe,
    page,
    category,
    config: cfg,
    timeoutMs,
    engines: fastProvider === 'searxng' ? plan.searxEngines : [],
  });

  const fastRanked = rankResultsBySourceDiversity(fastRun.results);
  const fastStats = buildEngineStats(fastRun.respondedEngines, fastRun.failedEngines, fastRun.failedDetails);

  if (fastRanked.length > 0) {
    yield {
      tier: 'fast',
      results: fastRanked,
      providers: [fastProvider],
      degraded: fastStats.degraded,
      engineStats: fastStats,
    };
  }

  const remainingProviders = providerList.filter((name) => name !== fastProvider);
  const additionalRuns = await Promise.all(remainingProviders.map((providerName) =>
    runProviderDetailed(providerName, {
      query,
      lang,
      safe,
      page,
      category,
      config: cfg,
      timeoutMs,
      engines: providerName === 'searxng' ? plan.searxEngines : [],
    })
  ));

  let full = fastRun.results.slice();
  const responded = [...fastRun.respondedEngines];
  const failed = [...fastRun.failedEngines];
  const failedDetails = [...fastRun.failedDetails];

  for (const run of additionalRuns) {
    full = mergeSearchResultSets(full, run.results);
    responded.push(...run.respondedEngines);
    failed.push(...run.failedEngines);
    failedDetails.push(...run.failedDetails);
  }

  const fullRanked = rankResultsBySourceDiversity(full);
  const engineStats = buildEngineStats(responded, failed, failedDetails);

  const cacheEngines = cacheEngineList(providerList, plan.searxEngines);
  const cacheKey = searchCacheKey(query, lang, safe, cacheEngines.length ? cacheEngines : ['none'], 'full', category, page);
  _searchCache?.set(cacheKey, {
    results: fullRanked,
    query,
    lang,
    page: Number(page),
    total: fullRanked.length,
    providers: providerList,
    category,
    degraded: engineStats.degraded,
    engineStats,
  }, cfg.search.cache_ttl_search_ms);

  yield {
    tier: 'full',
    results: fullRanked,
    providers: providerList,
    degraded: engineStats.degraded,
    engineStats,
  };
}

export function getEnabledProviders(cfg) {
  const providers = ['duckduckgo', 'wikipedia'];
  if (cfg?.startpage?.enabled !== false) providers.push('startpage');
  if (cfg?.qwant?.enabled !== false) providers.push('qwant');
  if (cfg?.ecosia?.enabled !== false) providers.push('ecosia');
  if (cfg.brave?.enabled && cfg.brave?.api_key) providers.push('brave');
  if (cfg.mojeek?.enabled && cfg.mojeek?.api_key) providers.push('mojeek');
  if (cfg.searxng?.enabled && cfg.searxng?.url) providers.push('searxng');
  providers.push('github-api');
  if (cfg?.yandex?.enabled !== false) providers.push('yandex');
  if (cfg?.ahmia?.enabled !== false) providers.push('ahmia');
  if (cfg?.marginalia?.enabled !== false) providers.push('marginalia');
  return providers;
}
