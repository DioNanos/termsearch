// Result ranking and deduplication for TermSearch

// Source quality weights — higher = results from this source ranked first
const SOURCE_ENGINE_WEIGHTS = {
  'wikipedia':    1.8,
  'wikipedia-api': 1.8,
  'brave-api':    1.5,
  'mojeek-api':   1.4,
  'duckduckgo':   1.2,
  'searxng':      1.1,
  // engines from SearXNG
  'startpage':    1.3,
  'qwant':        1.2,
  'bing':         1.1,
  'google':       1.1,
  'yahoo':        1.0,
};

function getSourceWeight(engine) {
  return SOURCE_ENGINE_WEIGHTS[String(engine || '').toLowerCase()] || 1.0;
}

export function safeHostname(url) {
  try {
    return new URL(String(url || '')).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

export function normalizeComparableUrl(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    parsed.hash = '';
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid']
      .forEach((k) => parsed.searchParams.delete(k));
    if ((parsed.protocol === 'https:' && parsed.port === '443') ||
        (parsed.protocol === 'http:' && parsed.port === '80')) parsed.port = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return parsed.toString();
  } catch {
    return '';
  }
}

// Merge two result arrays, deduplicating by normalized URL
export function mergeSearchResultSets(primary, secondary) {
  const seen = new Set(
    primary.map((r) => normalizeComparableUrl(r.url)).filter(Boolean)
  );
  const merged = [...primary];
  for (const r of secondary) {
    const norm = normalizeComparableUrl(r.url);
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      merged.push(r);
    }
  }
  return merged;
}

// Rank results by source diversity, penalizing repeated engines/hosts
export function rankResultsBySourceDiversity(results) {
  const seenEngines = new Map();
  const seenHosts = new Map();
  return (results || [])
    .map((item, index) => {
      const engine = String(item.engine || '').toLowerCase();
      const host = safeHostname(item.url);
      const engineSeen = seenEngines.get(engine) || 0;
      const hostSeen = seenHosts.get(host) || 0;
      seenEngines.set(engine, engineSeen + 1);
      if (host) seenHosts.set(host, hostSeen + 1);

      const sourceWeight = getSourceWeight(engine);
      const baseScore = Number(item.score || 0);
      const engineDiversity = engineSeen === 0 ? 2.0 : Math.max(0.1, 1.2 - (engineSeen * 0.25));
      const hostDiversity = hostSeen === 0 ? 1.4 : Math.max(-1.0, 0.3 - (hostSeen * 0.6));
      const positionPenalty = index * 0.03;
      const diversityScore = (sourceWeight * 2.0) + Math.min(baseScore, 2.0) + engineDiversity + hostDiversity - positionPenalty;
      return { ...item, diversityScore };
    })
    .sort((a, b) => b.diversityScore - a.diversityScore)
    .map(({ diversityScore, ...item }) => item);
}

// Build per-engine fetch plan for AI document fetching
export function buildPerEngineFetchPlan(results, {
  minPerEngine = 3,
  maxTotal = 15,
  maxPerDomain = 2,
} = {}) {
  const perEngine = new Map();
  for (const result of results || []) {
    const url = normalizeComparableUrl(result?.url);
    if (!url || !/^https?:\/\//.test(url) || /(login|signin|\.pdf|\.zip|\.exe)/i.test(url)) continue;
    const engine = String(result?.engine || 'unknown').toLowerCase();
    if (!perEngine.has(engine)) perEngine.set(engine, []);
    perEngine.get(engine).push(url);
  }

  const engineOrder = Array.from(perEngine.keys())
    .sort((a, b) => getSourceWeight(b) - getSourceWeight(a));

  const picked = [];
  const seen = new Set();
  const perEngineCount = new Map();
  const perDomainCount = new Map();
  const nextIndex = new Map(engineOrder.map((e) => [e, 0]));

  let progressed = true;
  while (progressed && picked.length < maxTotal) {
    progressed = false;
    for (const engine of engineOrder) {
      if (picked.length >= maxTotal) break;
      const have = perEngineCount.get(engine) || 0;
      if (have >= minPerEngine) continue;
      const pool = perEngine.get(engine) || [];
      let idx = nextIndex.get(engine) || 0;
      while (idx < pool.length) {
        const candidate = pool[idx++];
        const host = safeHostname(candidate);
        if (seen.has(candidate)) continue;
        if (host && (perDomainCount.get(host) || 0) >= maxPerDomain) continue;
        seen.add(candidate);
        picked.push(candidate);
        perEngineCount.set(engine, have + 1);
        if (host) perDomainCount.set(host, (perDomainCount.get(host) || 0) + 1);
        progressed = true;
        break;
      }
      nextIndex.set(engine, idx);
    }
  }

  // Fill remaining slots from all engines without minPerEngine constraint
  if (picked.length < maxTotal) {
    for (const engine of engineOrder) {
      const pool = perEngine.get(engine) || [];
      let idx = nextIndex.get(engine) || 0;
      while (idx < pool.length && picked.length < maxTotal) {
        const candidate = pool[idx++];
        const host = safeHostname(candidate);
        if (seen.has(candidate)) continue;
        if (host && (perDomainCount.get(host) || 0) >= maxPerDomain) continue;
        seen.add(candidate);
        picked.push(candidate);
        if (host) perDomainCount.set(host, (perDomainCount.get(host) || 0) + 1);
      }
      nextIndex.set(engine, idx);
    }
  }

  return picked;
}
