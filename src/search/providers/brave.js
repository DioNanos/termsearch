// Brave Search API provider — requires API key (configured via web UI)

function localeToIso639(locale) {
  const map = {
    'it-IT': 'it', 'en-US': 'en', 'es-ES': 'es',
    'fr-FR': 'fr', 'de-DE': 'de', 'pt-PT': 'pt',
    'ru-RU': 'ru', 'zh-CN': 'zh', 'ja-JP': 'ja',
  };
  return map[locale] || '';
}

export async function search({ query, lang = 'en-US', safe = '1', page = 1, config, timeoutMs = 12000 }) {
  const apiKey = config?.brave?.api_key;
  const apiBase = (config?.brave?.api_base || 'https://api.search.brave.com/res/v1').replace(/\/$/, '');
  if (!apiKey) return [];

  const isoLang = localeToIso639(lang);
  const resultCount = config?.search?.result_count || 10;
  const params = new URLSearchParams({
    q: query,
    count: String(resultCount),
    offset: String((Number(page) - 1) * resultCount),
  });
  if (isoLang) params.set('search_lang', isoLang);
  if (safe === '2') params.set('safesearch', 'strict');
  else if (safe === '1') params.set('safesearch', 'moderate');
  else params.set('safesearch', 'off');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${apiBase}/web/search?${params.toString()}`, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': apiKey,
        'User-Agent': 'TermSearch/1.0',
      },
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return [];
    const data = await r.json();
    return (data?.web?.results || []).map((item) => ({
      title: item.title || '',
      url: item.url || '',
      snippet: item.description || '',
      engine: 'brave-api',
      score: 0,
      publishedDate: item.age || null,
      thumbnail_src: item.thumbnail?.src || null,
    }));
  } catch {
    clearTimeout(timer);
    return [];
  }
}
