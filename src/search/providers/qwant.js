// Qwant JSON API — no API key required, semi-public endpoint
// Independent EU index; privacy-focused; results from own crawler + Bing blend

const QWANT_API = 'https://api.qwant.com/v3/search/web';

const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';

function localeParam(lang) {
  const map = {
    'en-US': 'en_US', 'en-GB': 'en_GB',
    'it-IT': 'it_IT', 'de-DE': 'de_DE', 'fr-FR': 'fr_FR',
    'es-ES': 'es_ES', 'pt-PT': 'pt_PT', 'nl-NL': 'nl_NL',
    'pl-PL': 'pl_PL', 'ru-RU': 'ru_RU', 'ja-JP': 'ja_JP',
  };
  return map[lang] || 'en_US';
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim();
}

export async function search({ query, lang = 'en-US', safe = '1', page = 1, timeoutMs = 10000 }) {
  const offset = (Math.max(1, Number(page)) - 1) * 10;
  const params = new URLSearchParams({
    q:          query,
    count:      '10',
    locale:     localeParam(lang),
    offset:     String(offset),
    safesearch: safe === '0' ? '0' : '1',
    t:          'web',
  });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${QWANT_API}?${params}`, {
      headers: {
        'Accept':          'application/json',
        'User-Agent':      UA,
        'Referer':         'https://www.qwant.com/',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return { results: [], _meta: { error: `qwant_http_${r.status}` } };
    const json = await r.json();
    if (json.status !== 'success') return { results: [], _meta: { error: `qwant_api_${json.status || 'error'}` } };

    // Flatten mainline sections of type "web"
    const mainline = json?.data?.result?.items?.mainline || [];
    const results = [];
    for (const section of mainline) {
      if (section.type !== 'web') continue;
      for (const item of (section.items || [])) {
        const url     = String(item.url || '').trim();
        const title   = stripTags(String(item.title || ''));
        const snippet = stripTags(String(item.desc || item.snippet || '')).slice(0, 300);
        if (!url.startsWith('http') || !title) continue;
        results.push({ title, url, snippet, engine: 'qwant', score: 0 });
        if (results.length >= 10) break;
      }
      if (results.length >= 10) break;
    }

    if (results.length === 0) return { results: [], _meta: { empty: true, skipHealth: true } };
    return { results, _meta: {} };
  } catch {
    clearTimeout(timer);
    return { results: [], _meta: { error: 'qwant_unreachable' } };
  }
}
