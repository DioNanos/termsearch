// Search orchestrator — fan-out to all enabled providers, merge, rank, cache

import path from 'path';
import { makeTieredCache, searchCacheKey } from './cache.js';
import { mergeSearchResultSets, rankResultsBySourceDiversity } from './ranking.js';
import * as ddg from './providers/duckduckgo.js';
import * as wikipedia from './providers/wikipedia.js';
import * as brave from './providers/brave.js';
import * as mojeek from './providers/mojeek.js';
import * as searxng from './providers/searxng.js';

let _searchCache = null;
let _docCache = null;
let _dataDir = null;

export function initCaches(dataDir, cfg) {
  _dataDir = dataDir;
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

const PROVIDER_REGISTRY = {
  duckduckgo: {
    aliases: new Set(['duckduckgo', 'ddg']),
    enabled: (_cfg) => true,
    run: ddg.search,
  },
  wikipedia: {
    aliases: new Set(['wikipedia', 'wiki']),
    enabled: (_cfg) => true,
    run: wikipedia.search,
  },
  brave: {
    aliases: new Set(['brave']),
    enabled: (cfg) => Boolean(cfg.brave?.enabled && cfg.brave?.api_key),
    run: brave.search,
  },
  mojeek: {
    aliases: new Set(['mojeek']),
    enabled: (cfg) => Boolean(cfg.mojeek?.enabled && cfg.mojeek?.api_key),
    run: mojeek.search,
  },
  searxng: {
    aliases: new Set(['searxng', 'searx']),
    enabled: (cfg) => Boolean(cfg.searxng?.enabled && cfg.searxng?.url),
    run: searxng.search,
  },
};

function normalizeRequestedEngines(input) {
  if (!Array.isArray(input)) return [];
  return [...new Set(
    input
      .map((item) => String(item || '').trim().toLowerCase())
      .filter(Boolean)
  )];
}

function resolveProviderPlan(cfg, requestedEngines = []) {
  const requested = normalizeRequestedEngines(requestedEngines);
  const enabledProviders = Object.keys(PROVIDER_REGISTRY).filter((name) => PROVIDER_REGISTRY[name].enabled(cfg));
  if (requested.length === 0) {
    return { providers: enabledProviders, searxEngines: [] };
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
    return { providers: enabledProviders, searxEngines: [] };
  }
  return { providers, searxEngines };
}

async function runProvider(name, args) {
  const provider = PROVIDER_REGISTRY[name];
  if (!provider) return [];
  try {
    return await provider.run(args);
  } catch {
    return [];
  }
}

// Run a search across all enabled providers and return merged, ranked results
export async function search({ query, lang = 'en-US', safe = '1', page = 1, category = 'web', engines = [] }, cfg) {
  if (!_searchCache) throw new Error('Caches not initialized — call initCaches() first');

  const plan = resolveProviderPlan(cfg, engines);
  const providerList = plan.providers;
  const timeoutMs = cfg.search.timeout_ms;
  const cacheEngines = providerList.length ? providerList : ['none'];
  const cacheKey = searchCacheKey(query, lang, safe, cacheEngines, 'full', category, page);
  const cached = _searchCache.get(cacheKey);
  if (cached) return cached;

  const tasks = providerList.map((providerName) =>
    runProvider(providerName, {
      query,
      lang,
      safe,
      page,
      category,
      config: cfg,
      timeoutMs,
      engines: providerName === 'searxng' ? plan.searxEngines : [],
    })
  );

  const allResults = await Promise.all(tasks);

  // Merge all provider results
  let merged = [];
  for (const provResults of allResults) {
    merged = mergeSearchResultSets(merged, provResults);
  }

  // Rank by source diversity
  const ranked = rankResultsBySourceDiversity(merged);

  const response = {
    results: ranked,
    query,
    lang,
    page: Number(page),
    total: ranked.length,
    providers: providerList,
    category,
  };

  _searchCache.set(cacheKey, response, cfg.search.cache_ttl_search_ms);
  return response;
}

// Streaming search: returns fast results first (DDG), then merges full results
export async function* searchStream({ query, lang = 'en-US', safe = '1', page = 1, category = 'web', engines = [] }, cfg) {
  const plan = resolveProviderPlan(cfg, engines);
  const providerList = plan.providers;
  if (providerList.length === 0) {
    yield { tier: 'full', results: [], providers: [] };
    return;
  }

  const timeoutMs = cfg.search.timeout_ms;
  const fastProvider = providerList.includes('duckduckgo')
    ? 'duckduckgo'
    : providerList[0];
  const fastResults = await runProvider(fastProvider, {
    query,
    lang,
    safe,
    page,
    category,
    config: cfg,
    timeoutMs,
    engines: fastProvider === 'searxng' ? plan.searxEngines : [],
  });
  if (fastResults.length > 0) {
    yield { tier: 'fast', results: rankResultsBySourceDiversity(fastResults), providers: [fastProvider] };
  }

  const remainingProviders = providerList.filter((name) => name !== fastProvider);
  const tasks = remainingProviders.map((providerName) =>
    runProvider(providerName, {
      query,
      lang,
      safe,
      page,
      category,
      config: cfg,
      timeoutMs,
      engines: providerName === 'searxng' ? plan.searxEngines : [],
    })
  );

  const additional = await Promise.all(tasks);
  let full = fastResults.slice();
  for (const r of additional) {
    full = mergeSearchResultSets(full, r);
  }
  const fullRanked = rankResultsBySourceDiversity(full);

  // Cache the full result
  const cacheEngines = providerList.length ? providerList : ['none'];
  const cacheKey = searchCacheKey(query, lang, safe, cacheEngines, 'full', category, page);
  _searchCache?.set(cacheKey, {
    results: fullRanked,
    query, lang, page: Number(page), total: fullRanked.length,
    providers: providerList,
    category,
  }, cfg.search.cache_ttl_search_ms);

  yield { tier: 'full', results: fullRanked, providers: providerList };
}

export function getEnabledProviders(cfg) {
  const providers = ['duckduckgo', 'wikipedia'];
  if (cfg.brave?.enabled && cfg.brave?.api_key) providers.push('brave');
  if (cfg.mojeek?.enabled && cfg.mojeek?.api_key) providers.push('mojeek');
  if (cfg.searxng?.enabled && cfg.searxng?.url) providers.push('searxng');
  return providers;
}
