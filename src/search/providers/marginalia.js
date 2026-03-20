// Marginalia Search provider (api2, key-based).
// Public key works with shared limits; user key can be configured.

const DEFAULT_API = 'https://api2.marginalia-search.com';

export async function search({ query, page = 1, timeoutMs = 10000, config }) {
  const cfg = config || {};
  const apiBase = String(cfg?.marginalia?.api_base || DEFAULT_API).replace(/\/$/, '');
  const apiKey = String(cfg?.marginalia?.api_key || process.env.TERMSEARCH_MARGINALIA_API_KEY || 'public').trim() || 'public';
  const enabled = cfg?.marginalia?.enabled !== false;
  if (!enabled) return { results: [], _meta: { error: 'marginalia_disabled' } };

  const params = new URLSearchParams({
    query,
    count: '10',
    page: String(Math.max(1, Number(page) || 1)),
  });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${apiBase}/search?${params}`, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'TermSearch/1.0 (personal search)',
        'API-Key': apiKey,
      },
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return { results: [], _meta: { error: `marginalia_http_${r.status}` } };
    const data = await r.json();
    const list = Array.isArray(data.results)
      ? data.results
      : (Array.isArray(data.result) ? data.result : []);
    const results = list.slice(0, 15).map((item) => ({
      title:   String(item.title || item.url || '').trim(),
      url:     String(item.url || '').trim(),
      snippet: String(item.description || item.snippet || '').trim(),
      engine:  'marginalia',
      score:   0,
    })).filter((r) => r.url.startsWith('http'));
    if (results.length === 0) return { results: [], _meta: { empty: true, skipHealth: true } };
    return { results, _meta: {} };
  } catch {
    clearTimeout(timer);
    return { results: [], _meta: { error: 'marginalia_unreachable' } };
  }
}
