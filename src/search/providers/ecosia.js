// Ecosia HTML scraper — Bing-powered, no API key required
// Privacy-focused, plants trees with ad revenue

const ECOSIA_ENDPOINT = 'https://www.ecosia.org/search';

const USER_AGENTS = [
  'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function ent(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, '').trim();
}

function parseEcosia(html) {
  const results = [];

  // Primary: result__body blocks (standard Ecosia layout)
  const blockRe = /class="[^"]*result(?:__body|-body)[^"]*"[^>]*>([\s\S]*?)(?=class="[^"]*result(?:__body|-body)|class="[^"]*pagination|<\/main)/gi;
  let m;
  while ((m = blockRe.exec(html)) !== null && results.length < 15) {
    const block = m[1];
    // Title anchor — skip ecosia.org internal links
    const aMatch = block.match(/<a[^>]+href="(https?:\/\/(?!(?:[^/]*\.)?ecosia\.org)[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!aMatch) continue;
    const url = aMatch[1];
    if (url.length > 500) continue;
    const title = ent(aMatch[2].replace(/<[^>]+>/g, ''));
    if (!title) continue;
    const snipM = block.match(/class="[^"]*(?:result-snippet|result__description|result__body-text|result__content)[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div|span)>/i);
    const snippet = snipM ? ent(snipM[1].replace(/<[^>]+>/g, '')).slice(0, 300) : '';
    results.push({ title, url, snippet, engine: 'ecosia', score: 0 });
  }

  // Fallback: external links that have a heading nearby
  if (results.length === 0) {
    const linkRe = /<a[^>]+href="(https?:\/\/(?!(?:[^/]*\.)?ecosia\.org)[^"]+)"[^>]*>[\s]*<(?:h[1-4]|strong)[^>]*>([\s\S]*?)<\/(?:h[1-4]|strong)>/gi;
    while ((m = linkRe.exec(html)) !== null && results.length < 15) {
      const url = m[1];
      const title = ent(m[2].replace(/<[^>]+>/g, ''));
      if (!title || url.length > 500) continue;
      results.push({ title, url, snippet: '', engine: 'ecosia', score: 0 });
    }
  }

  return results;
}

export async function search({ query, lang = 'en-US', safe = '1', page = 1, timeoutMs = 12000 }) {
  const params = new URLSearchParams({ q: query, c: 'web' });
  if (page > 1) params.set('p', String(page - 1));

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${ECOSIA_ENDPOINT}?${params}`, {
      headers: {
        'User-Agent':     randomUA(),
        'Accept':         'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': lang.slice(0, 2) + ',en;q=0.5',
        'Referer':        'https://www.ecosia.org/',
        'DNT':            '1',
      },
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return { results: [], _meta: { error: `ecosia_http_${r.status}` } };
    const html = await r.text();
    if (html.length < 2000 || html.includes('cf-challenge') || html.includes('captcha')) {
      return { results: [], _meta: { error: 'ecosia_blocked' } };
    }
    const results = parseEcosia(html);
    if (results.length === 0) return { results: [], _meta: { empty: true, skipHealth: true } };
    return { results, _meta: {} };
  } catch {
    clearTimeout(timer);
    return { results: [], _meta: { error: 'ecosia_unreachable' } };
  }
}
