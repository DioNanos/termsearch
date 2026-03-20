// Yandex HTML scraper — no API key required
// Different political/content filtering than US engines; Russian/global index

const YANDEX_ENDPOINT = 'https://yandex.com/search/';
const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';

function parseYandex(html) {
  const results = [];

  // Primary: OrganicTitle-Link class (standard desktop layout)
  const titleRe = /<a[^>]+class="[^"]*OrganicTitle-Link[^"]*"[^>]+href="([^"#]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = titleRe.exec(html)) !== null && results.length < 15) {
    const url = m[1];
    if (!url.startsWith('http') || url.includes('yandex.') || url.includes('ya.ru')) continue;
    const title = m[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim();
    if (!title) continue;

    // Look for snippet in the 3KB after the title match
    const chunk = html.slice(m.index, m.index + 3000);
    const snipM = chunk.match(/class="[^"]*(?:OrganicText|TextContainer|Organic-Text|organic__text)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span|p)>/i);
    const snippet = snipM
      ? snipM[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim().slice(0, 300)
      : '';

    results.push({ title, url, snippet, engine: 'yandex', score: 0 });
  }

  return results;
}

export async function search({ query, lang = 'en-US', page = 1, timeoutMs = 12000 }) {
  const params = new URLSearchParams({
    text:    query,
    p:       String(Math.max(0, Number(page) - 1)),
    numdoc:  '10',
    lr:      '10417', // world region
  });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${YANDEX_ENDPOINT}?${params}`, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return { results: [], _meta: { error: `yandex_http_${r.status}` } };
    const html = await r.text();
    // Explicit detection: Yandex can serve anti-bot pages.
    if (html.includes('showcaptcha') || html.includes('robot-captcha')) {
      return { results: [], _meta: { error: 'yandex_captcha' } };
    }
    if (html.length < 2000) {
      return { results: [], _meta: { error: 'yandex_unexpected_html' } };
    }
    const results = parseYandex(html);
    if (results.length === 0) return { results: [], _meta: { empty: true, skipHealth: true } };
    return { results, _meta: {} };
  } catch {
    clearTimeout(timer);
    return { results: [], _meta: { error: 'yandex_unreachable' } };
  }
}
