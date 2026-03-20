// SearXNG proxy provider — for power users who run their own SearXNG instance

function mapCategory(category) {
  const c = String(category || 'web').toLowerCase();
  if (c === 'images') return 'images';
  if (c === 'news') return 'news';
  return 'general';
}

export async function search({ query, lang = 'en-US', safe = '1', page = 1, category = 'web', engines = [], config, timeoutMs = 15000 }) {
  const searxngUrl = config?.searxng?.url;
  if (!searxngUrl) return { results: [], _meta: { error: 'searxng_not_configured' } };

  const base = searxngUrl.replace(/\/$/, '');
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    language: lang,
    safesearch: safe === '2' ? '2' : safe === '0' ? '0' : '1',
    pageno: String(page),
    categories: mapCategory(category),
  });
  if (Array.isArray(engines) && engines.length > 0) {
    params.set('engines', engines.join(','));
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}/search?${params.toString()}`, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'TermSearch/1.0',
      },
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return { results: [], _meta: { error: `searxng_http_${r.status}` } };
    const data = await r.json();
    const results = (data?.results || []).map((item) => ({
      title: item.title || '',
      url: item.url || '',
      snippet: item.content || '',
      engine: item.engine ? String(item.engine).toLowerCase() : 'searxng',
      score: Number(item.score || 0),
      publishedDate: item.publishedDate || null,
      thumbnail_src: item.thumbnail || null,
    }));
    const unresponsive = Array.isArray(data?.unresponsive_engines)
      ? data.unresponsive_engines.map((entry) => (Array.isArray(entry) ? String(entry[0] || '').toLowerCase() : String(entry || '').toLowerCase())).filter(Boolean)
      : [];
    const unresponsiveDetails = Array.isArray(data?.unresponsive_engines)
      ? data.unresponsive_engines.map((entry) => ({
          engine: Array.isArray(entry) ? String(entry[0] || '').toLowerCase() : String(entry || '').toLowerCase(),
          reason: Array.isArray(entry) ? String(entry[1] || '') : '',
        })).filter((entry) => entry.engine)
      : [];
    return { results, _meta: { unresponsive, unresponsiveDetails } };
  } catch {
    clearTimeout(timer);
    return { results: [], _meta: { error: 'searxng_unreachable' } };
  }
}
