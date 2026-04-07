// Wikipedia REST API provider — zero API key required
// Uses the MediaWiki action API for full-text search

const API_BASE = 'https://{lang}.wikipedia.org/w/api.php';

// Map locale to Wikipedia language subdomain
function langCode(locale) {
  const map = {
    'it-IT': 'it', 'en-US': 'en', 'es-ES': 'es',
    'fr-FR': 'fr', 'de-DE': 'de', 'pt-PT': 'pt',
    'ru-RU': 'ru', 'zh-CN': 'zh', 'ja-JP': 'ja',
  };
  return map[locale] || 'en';
}

function stripHtmlBasic(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function search({ query, lang = 'en-US', page = 1, timeoutMs = 12000 }) {
  const lc = langCode(lang);
  const endpoint = API_BASE.replace('{lang}', lc);
  const offset = (Number(page) - 1) * 5;

  const params = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: query,
    srlimit: '6',
    sroffset: String(offset),
    srprop: 'snippet|titlesnippet|sectiontitle',
    format: 'json',
    origin: '*',
  });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${endpoint}?${params.toString()}`, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'TermSearch/1.0 (personal search engine; https://github.com/DioNanos/termsearch)',
      },
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return [];

    const data = await r.json();
    const items = data?.query?.search || [];
    return items.map((item) => ({
      title: stripHtmlBasic(item.title || ''),
      url: `https://${lc}.wikipedia.org/wiki/${encodeURIComponent((item.title || '').replace(/ /g, '_'))}`,
      snippet: stripHtmlBasic(item.snippet || ''),
      engine: 'wikipedia',
      score: 1.0,
      publishedDate: null,
    }));
  } catch {
    clearTimeout(timer);
    return [];
  }
}
