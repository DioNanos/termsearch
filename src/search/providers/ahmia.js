// Ahmia.fi — clearnet index of Tor hidden services (.onion)
// No API key required — results include .onion URLs (accessible via Tor Browser)

const AHMIA_ENDPOINT = 'https://ahmia.fi/search/';
const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';

function parseAhmia(html) {
  const results = [];
  // Each result: <h4><a href="...">Title</a></h4> followed by <p>snippet</p>
  const blockRe = /<h4[^>]*>([\s\S]*?)<\/h4>([\s\S]*?)(?=<h4|<\/ol|$)/gi;
  let m;
  while ((m = blockRe.exec(html)) !== null && results.length < 15) {
    const titleBlock = m[1];
    const afterBlock = m[2];

    const aMatch = titleBlock.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!aMatch) continue;

    const url = aMatch[1];
    if (!url.startsWith('http') || url.includes('ahmia.fi')) continue;

    const title = aMatch[2].replace(/<[^>]+>/g, '').trim();
    if (!title) continue;

    const pMatch = afterBlock.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = pMatch
      ? pMatch[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim().slice(0, 300)
      : '';

    results.push({ title, url, snippet, engine: 'ahmia', score: 0 });
  }
  return results;
}

export async function search({ query, page = 1, timeoutMs = 12000 }) {
  const params = new URLSearchParams({ q: query });
  if (page > 1) params.set('page', String(page - 1));

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${AHMIA_ENDPOINT}?${params}`, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return { results: [], _meta: { error: `ahmia_http_${r.status}` } };
    const html = await r.text();
    if (html.length < 500) return { results: [], _meta: { error: 'ahmia_unexpected_html' } };
    const results = parseAhmia(html);
    if (results.length === 0) return { results: [], _meta: { empty: true, skipHealth: true } };
    return { results, _meta: {} };
  } catch {
    clearTimeout(timer);
    return { results: [], _meta: { error: 'ahmia_unreachable' } };
  }
}
