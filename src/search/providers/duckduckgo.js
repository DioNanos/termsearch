// DuckDuckGo HTML scraper — zero API key required
// Uses html.duckduckgo.com/html/ (maintained for non-JS clients / accessibility)

const DDG_ENDPOINT = 'https://html.duckduckgo.com/html/';
const DDG_FALLBACK = 'https://lite.duckduckgo.com/lite/';

const USER_AGENTS = [
  'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// DDG safe search parameter
function safeParam(safe) {
  if (safe === '2') return '-1'; // strict
  if (safe === '0') return '-2'; // off
  return '-1';                   // moderate → strict (default)
}

// DDG language/region parameter
function langParam(lang) {
  const map = {
    'it-IT': 'it-it', 'en-US': 'us-en', 'es-ES': 'es-es',
    'fr-FR': 'fr-fr', 'de-DE': 'de-de', 'pt-PT': 'pt-pt',
    'ru-RU': 'ru-ru', 'zh-CN': 'cn-zh', 'ja-JP': 'jp-ja',
  };
  return map[lang] || 'wt-wt';
}

// Parse DDG HTML result — returns { title, url, snippet } or null
function parseResult(html, startIdx) {
  // Extract result URL from <a class="result__a" href="...">
  const aMatch = html.slice(startIdx).match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
  if (!aMatch) return null;

  let url = aMatch[1];
  // DDG wraps URLs in redirect — extract real URL
  if (url.startsWith('//duckduckgo.com/l/?')) {
    try {
      const uddg = new URL('https:' + url).searchParams.get('uddg') || '';
      if (uddg) url = decodeURIComponent(uddg);
    } catch { /* keep raw */ }
  }
  if (!url.startsWith('http')) return null;

  const title = aMatch[2].replace(/<[^>]+>/g, '').trim();
  if (!title || !url) return null;

  // Snippet: next <a class="result__snippet"> after the title link
  const snippetChunk = html.slice(startIdx, startIdx + 3000);
  const snippetMatch = snippetChunk.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
  const snippet = snippetMatch
    ? snippetMatch[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim()
    : '';

  return { title, url, snippet };
}

// Parse DDG lite HTML — simpler table-based format
function parseLiteHtml(html) {
  const results = [];
  const linkRe = /<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;
  const links = [...html.matchAll(linkRe)];
  const snippets = [...html.matchAll(snippetRe)];
  for (let i = 0; i < links.length && results.length < 15; i++) {
    let url = links[i][1];
    if (url.includes('duckduckgo.com/l/?')) {
      try { url = decodeURIComponent(new URL('https://x.com' + url.replace(/^https?:\/\/[^/]+/, '')).searchParams.get('uddg') || url); } catch { /* ok */ }
    }
    if (!url.startsWith('http')) continue;
    const title = links[i][2].replace(/<[^>]+>/g, '').trim();
    const snippet = snippets[i]
      ? snippets[i][1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim()
      : '';
    if (title && url) results.push({ title, url, snippet, engine: 'duckduckgo', score: 0 });
  }
  return results;
}

async function fetchDDG(endpoint, formData, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'User-Agent': randomUA(),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Origin': 'https://duckduckgo.com',
        'Referer': 'https://duckduckgo.com/',
      },
      body: formData,
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    const html = await r.text();
    // Detect captcha/block page
    if (html.includes('challenge-form') || html.includes('Sorry, you have been blocked')) return null;
    return html;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

export async function search({ query, lang = 'en-US', safe = '1', page = 1, timeoutMs = 12000 }) {
  const kp = safeParam(safe);
  const kl = langParam(lang);
  const offset = (Number(page) - 1) * 10;

  const params = new URLSearchParams({
    q: query,
    kp,
    kl,
    kf: '-1', // site icons off (faster)
    s: String(offset),
  });
  const formData = params.toString();

  let html = await fetchDDG(DDG_ENDPOINT, formData, timeoutMs);

  // Fallback to lite endpoint
  if (!html) {
    const liteParams = new URLSearchParams({ q: query, s: String(offset) });
    html = await fetchDDG(DDG_FALLBACK, liteParams.toString(), timeoutMs);
    if (!html) return [];
    return parseLiteHtml(html);
  }

  // Parse main HTML endpoint
  const results = [];
  const resultRe = /class="results_links|class="result results_links/gi;
  let match;
  while ((match = resultRe.exec(html)) !== null && results.length < 15) {
    const r = parseResult(html, match.index);
    if (r) results.push({ ...r, engine: 'duckduckgo', score: 0 });
  }

  return results;
}
