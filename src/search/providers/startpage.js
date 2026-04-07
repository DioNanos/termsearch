// Startpage HTML scraper — proxies Google index, privacy-first, no API key required
// Uses /sp/search POST form (maintained for non-JS clients)

const SP_ENDPOINT = 'https://www.startpage.com/sp/search';

const USER_AGENTS = [
  'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function langParam(lang) {
  const map = {
    'en-US': 'english', 'en-GB': 'english',
    'it-IT': 'italian', 'de-DE': 'german', 'fr-FR': 'french',
    'es-ES': 'spanish', 'pt-PT': 'portuguese', 'ru-RU': 'russian',
    'nl-NL': 'dutch',   'pl-PL': 'polish',
  };
  return map[lang] || 'english';
}

function ent(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, '').trim();
}

function parseStartpage(html) {
  const results = [];

  // Primary pattern: w-gl__result blocks (classic Startpage layout)
  const blockRe = /<(?:article|section|div)[^>]+class="[^"]*w-gl__result[^"]*"[^>]*>([\s\S]*?)(?=<(?:article|section|div)[^>]+class="[^"]*w-gl__result|<\/section|id="pagination|id="new-feature-banner)/gi;
  let m;
  while ((m = blockRe.exec(html)) !== null && results.length < 15) {
    const block = m[1];
    const aMatch = block.match(/<a[^>]+class="[^"]*(?:w-gl__result-title-anchor|result-title)[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!aMatch) continue;
    const url = aMatch[1];
    if (!url.startsWith('http') || url.includes('startpage.com')) continue;
    const title = ent(aMatch[2].replace(/<[^>]+>/g, ''));
    if (!title) continue;
    const snipM = block.match(/class="[^"]*(?:w-gl__result-description|result-desc)[^"]*"[^>]*>([\s\S]*?)<\/[a-z]+>/i);
    const snippet = snipM ? ent(snipM[1].replace(/<[^>]+>/g, '')).slice(0, 300) : '';
    results.push({ title, url, snippet, engine: 'startpage', score: 0 });
  }

  // Fallback: any external link preceded by a heading tag
  if (results.length === 0) {
    const linkRe = /<a[^>]+href="(https?:\/\/(?!(?:[^/]*\.)?startpage\.com)[^"]+)"[^>]*>[\s\S]*?<(?:h[1-4]|strong)[^>]*>([\s\S]*?)<\/(?:h[1-4]|strong)>/gi;
    while ((m = linkRe.exec(html)) !== null && results.length < 15) {
      const url = m[1];
      const title = ent(m[2].replace(/<[^>]+>/g, ''));
      if (!title || url.length > 500) continue;
      results.push({ title, url, snippet: '', engine: 'startpage', score: 0 });
    }
  }

  return results;
}

export async function search({ query, lang = 'en-US', safe = '1', page = 1, timeoutMs = 12000 }) {
  const startat = (Math.max(1, Number(page)) - 1) * 10;
  const body = new URLSearchParams({
    query,
    language:  langParam(lang),
    startat:   String(startat),
    cat:       'web',
    cmd:       'process_search',
    nj:        '1',
    abp:       '1',
    t:         'device',
    with_date: '',
  });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(SP_ENDPOINT, {
      method: 'POST',
      headers: {
        'User-Agent':     randomUA(),
        'Content-Type':   'application/x-www-form-urlencoded',
        'Accept':         'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language':'en-US,en;q=0.5',
        'Origin':         'https://www.startpage.com',
        'Referer':        'https://www.startpage.com/',
      },
      body: body.toString(),
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return { results: [], _meta: { error: `startpage_http_${r.status}` } };
    const html = await r.text();
    if (html.length < 2000 || html.includes('captcha') || html.includes('robot-check')) {
      return { results: [], _meta: { error: 'startpage_blocked' } };
    }
    const results = parseStartpage(html);
    if (results.length === 0) return { results: [], _meta: { empty: true, skipHealth: true } };
    return { results, _meta: {} };
  } catch {
    clearTimeout(timer);
    return { results: [], _meta: { error: 'startpage_unreachable' } };
  }
}
