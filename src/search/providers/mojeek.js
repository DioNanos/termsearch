// Mojeek Search API provider — requires API key (configured via web UI)

function localeToIso639(locale) {
  const map = {
    'it-IT': 'it', 'en-US': 'en', 'es-ES': 'es',
    'fr-FR': 'fr', 'de-DE': 'de', 'pt-PT': 'pt',
    'ru-RU': 'ru', 'zh-CN': 'zh', 'ja-JP': 'ja',
  };
  return map[locale] || '';
}

export async function search({ query, lang = 'en-US', page = 1, config, timeoutMs = 12000 }) {
  const apiKey = config?.mojeek?.api_key;
  const apiBase = (config?.mojeek?.api_base || 'https://api.mojeek.com').replace(/\/$/, '');
  if (!apiKey) return [];

  const isoLang = localeToIso639(lang);
  const resultCount = config?.search?.result_count || 10;
  const params = new URLSearchParams({
    api_key: apiKey,
    q: query,
    t: String(resultCount),
    s: String(((Number(page) - 1) * resultCount) + 1),
    fmt: 'json',
  });
  if (isoLang) {
    params.set('lb', isoLang.toUpperCase());
    params.set('lbb', '100');
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${apiBase}/search?${params.toString()}`, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'TermSearch/1.0',
      },
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return [];
    const data = await r.json();
    return (data?.response?.results || []).map((item) => ({
      title: item.title || '',
      url: item.url || '',
      snippet: item.desc || '',
      engine: 'mojeek-api',
      score: Number(item.score || 0),
      publishedDate: item.date || null,
    }));
  } catch {
    clearTimeout(timer);
    return [];
  }
}
