// URL fetcher + HTML to readable text extraction
// Used by AI summary to fetch page content

import { assertPublicUrl } from './ssrf-guard.js';

const FETCH_MAX_BYTES = 180_000;

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function stripHtml(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    // Preserve external links as "text [url]" for AI URL extraction
    .replace(/<a\s[^>]*\bhref="(https?:\/\/[^"#?]{4,})"[^>]*>([\s\S]*?)<\/a>/gi, (_, url, inner) => {
      const text = inner.replace(/<[^>]+>/g, '').trim();
      return text ? `${text} [${url}]` : `[${url}]`;
    })
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function getMetaContent(html, attr, value) {
  const re = new RegExp(`<meta\\s+[^>]*${attr}="${escapeRegExp(value)}"[^>]*content="([^"]+)"[^>]*>`, 'i');
  return html.match(re)?.[1]?.trim() || '';
}

export function truncateSmart(text, limit = 12000) {
  const clean = String(text || '').trim();
  if (clean.length <= limit) return clean;
  const headLen = Math.max(500, Math.floor(limit * 0.62));
  const tailLen = Math.max(400, limit - headLen - 8);
  return `${clean.slice(0, headLen)} … ${clean.slice(-tailLen)}`.trim();
}

export function extractTitle(html, fallbackUrl) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]) return stripHtml(titleMatch[1]).slice(0, 160);
  return fallbackUrl;
}

function extractGithubReadable(parsedUrl, html) {
  if (parsedUrl.hostname !== 'github.com') return null;
  const seg = parsedUrl.pathname.split('/').filter(Boolean);
  if (seg.length === 0) return null;

  const title = extractTitle(html, parsedUrl.toString());
  const metaDesc = getMetaContent(html, 'name', 'description') || getMetaContent(html, 'property', 'og:description');
  const lines = [`GitHub page: ${parsedUrl.toString()}`, `Title: ${title}`];
  if (metaDesc) lines.push(`Summary: ${stripHtml(metaDesc)}`);

  if (seg.length === 1) {
    const username = seg[0];
    const repoRe = /<a\s+href="\/([^/"?#]+\/[^/"?#]+)"[^>]*itemprop="name codeRepository"[^>]*>([\s\S]*?)<\/a>/gi;
    const repos = [];
    let match;
    while ((match = repoRe.exec(html)) !== null && repos.length < 12) {
      const ownerRepo = String(match[1] || '').trim();
      if (!ownerRepo.toLowerCase().startsWith(`${username.toLowerCase()}/`)) continue;
      const repoName = stripHtml(match[2] || '').trim();
      if (!repoName) continue;
      const chunk = html.slice(match.index, match.index + 2200);
      const descHtml = chunk.match(/itemprop="description"[^>]*>([\s\S]*?)<\/p>/i)?.[1] || '';
      const starsChunk = chunk.match(new RegExp(`href="/${escapeRegExp(ownerRepo)}/stargazers"[\\s\\S]{0,180}<\\/a>`, 'i'))?.[0] || '';
      const forksChunk = chunk.match(new RegExp(`href="/${escapeRegExp(ownerRepo)}/forks"[\\s\\S]{0,180}<\\/a>`, 'i'))?.[0] || '';
      const stars = stripHtml(starsChunk).match(/(\d[\d.,kK]*)/)?.[1] || '';
      const forks = stripHtml(forksChunk).match(/(\d[\d.,kK]*)/)?.[1] || '';
      const desc = stripHtml(descHtml).slice(0, 180);
      repos.push({ repo: repoName, url: `https://github.com/${ownerRepo}`, desc, stars, forks });
    }
    if (repos.length > 0) {
      lines.push(`Repositories found: ${repos.length}`);
      for (const r of repos) {
        const meta = [r.stars ? `stars=${r.stars}` : '', r.forks ? `forks=${r.forks}` : ''].filter(Boolean).join(', ');
        lines.push(`- ${r.repo}${r.desc ? ` — ${r.desc}` : ''}${meta ? ` (${meta})` : ''} [${r.url}]`);
      }
    }
  }

  if (seg.length >= 2) {
    const ownerRepo = `${seg[0]}/${seg[1]}`;
    const repoDesc = getMetaContent(html, 'property', 'og:description') || getMetaContent(html, 'name', 'description');
    lines.push(`Repository: ${ownerRepo} [https://github.com/${ownerRepo}]`);
    if (repoDesc) lines.push(`Repository summary: ${stripHtml(repoDesc)}`);
  }

  const content = truncateSmart(lines.join('\n'), 12000);
  return content.length >= 80 ? content : null;
}

async function fetchGithubApiSummary(username, timeoutMs) {
  const handle = String(username || '').trim();
  if (!handle) return '';
  const headers = { 'User-Agent': 'TermSearch/1.0', Accept: 'application/vnd.github+json' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.min(timeoutMs, 9000));
  try {
    const [userRes, reposRes] = await Promise.all([
      fetch(`https://api.github.com/users/${encodeURIComponent(handle)}`, { headers, signal: ac.signal }),
      fetch(`https://api.github.com/users/${encodeURIComponent(handle)}/repos?sort=updated&per_page=12`, { headers, signal: ac.signal }),
    ]);
    let user = null;
    let repos = [];
    if (userRes.ok) user = await userRes.json();
    if (reposRes.ok) { const d = await reposRes.json(); repos = Array.isArray(d) ? d : []; }
    if (!user && repos.length === 0) return '';
    const lines = ['GitHub API snapshot:'];
    if (user) {
      lines.push(`Profile: ${user.html_url || `https://github.com/${handle}`}`);
      if (user.name) lines.push(`Name: ${user.name}`);
      if (user.bio) lines.push(`Bio: ${String(user.bio).slice(0, 220)}`);
      if (Number.isFinite(user.public_repos)) lines.push(`Public repos: ${user.public_repos}`);
    }
    if (repos.length > 0) {
      lines.push(`Repositories (latest ${repos.length}):`);
      for (const repo of repos) {
        const parts = [];
        if (repo.language) parts.push(`lang=${repo.language}`);
        if (Number.isFinite(repo.stargazers_count)) parts.push(`stars=${repo.stargazers_count}`);
        lines.push(`- ${repo.name}${repo.description ? ` — ${String(repo.description).slice(0, 180)}` : ''}${parts.length ? ` (${parts.join(', ')})` : ''} [${repo.html_url}]`);
      }
    }
    return lines.join('\n');
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

// Fetch a URL and return readable text content
// docCache: optional cache instance to use (injected from engine.js)
export async function fetchReadableDocument(rawUrl, { timeoutMs = 12000, docCache } = {}) {
  const cacheKey = String(rawUrl || '').trim();
  if (docCache) {
    const cached = docCache.get(cacheKey);
    if (cached) return cached;
  }

  const parsed = await assertPublicUrl(rawUrl);
  // Note: AbortSignal.timeout() is broken with HTTPS in Node 24 — use manual AbortController
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(parsed.toString(), {
      headers: {
        'User-Agent': 'TermSearchFetch/1.0',
        Accept: 'text/html, text/plain;q=0.9,*/*;q=0.5',
      },
      signal: ac.signal,
      redirect: 'follow',
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);

  const contentType = response.headers.get('content-type') || '';
  if (!/text\/html|text\/plain|application\/xhtml\+xml/i.test(contentType)) {
    throw new Error(`Unsupported content-type: ${contentType || 'unknown'}`);
  }

  const buffer = await response.arrayBuffer();
  const bytes = Buffer.from(buffer).subarray(0, FETCH_MAX_BYTES);
  const html = bytes.toString('utf8');
  const githubContent = extractGithubReadable(parsed, html);
  let content = githubContent || truncateSmart(stripHtml(html), 12000);

  if (parsed.hostname === 'github.com') {
    const seg = parsed.pathname.split('/').filter(Boolean);
    if (seg.length === 1) {
      const apiSummary = await fetchGithubApiSummary(seg[0], timeoutMs);
      if (apiSummary) content = truncateSmart(`${content}\n\n${apiSummary}`.trim(), 12000);
    }
  }

  if (!content) throw new Error('No readable content extracted.');

  const result = { url: parsed.toString(), title: extractTitle(html, parsed.toString()), content, status: 'ok' };
  if (docCache) docCache.set(cacheKey, result, 45 * 60 * 1000);
  return result;
}

// Batch fetch multiple URLs in parallel
export async function batchFetch(urls, { timeoutMs = 12000, docCache } = {}) {
  return Promise.all(
    urls.map((url) =>
      fetchReadableDocument(url, { timeoutMs, docCache })
        .then((doc) => ({ ...doc, url }))
        .catch((e) => ({ url, status: 'error', error: e.message, content: '', title: url }))
    )
  );
}

// Scan a site homepage + a few relevant internal pages by query keywords
export async function scanSitePages(baseUrl, query, maxPages = 4, { timeoutMs = 12000, docCache } = {}) {
  const clampedMax = Math.min(Number(maxPages) || 4, 8);
  let base;
  try {
    base = await assertPublicUrl(baseUrl);
  } catch {
    return [];
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let html = '';
  try {
    const response = await fetch(base.toString(), {
      headers: {
        'User-Agent': 'TermSearchFetch/1.0',
        Accept: 'text/html,*/*;q=0.5',
      },
      signal: ac.signal,
      redirect: 'follow',
    });
    if (!response.ok) return [];
    const buffer = await response.arrayBuffer();
    html = Buffer.from(buffer).subarray(0, FETCH_MAX_BYTES).toString('utf8');
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }

  const homepageDoc = {
    url: base.toString(),
    title: extractTitle(html, base.toString()),
    content: truncateSmart(stripHtml(html), 12000),
    status: 'ok',
  };

  const seen = new Set([base.toString().replace(/\/+$/, '')]);
  const candidateUrls = [];
  const linkRe = /href="(\/[^"#?]{2,}|https?:\/\/[^"#?]+)"/gi;
  let match;
  while ((match = linkRe.exec(html)) !== null && candidateUrls.length < 40) {
    try {
      const full = new URL(match[1], base.toString());
      if (full.hostname !== base.hostname) continue;
      if (/(login|signin|logout|register|account|cart|checkout|\.pdf|\.zip|\.exe|\.jpg|\.jpeg|\.png|\.gif|\.css|\.js)/i.test(full.pathname)) continue;
      const normalized = `${full.origin}${full.pathname}`.replace(/\/+$/, '');
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      candidateUrls.push(normalized);
    } catch {
      // ignore invalid links
    }
  }

  const queryWords = String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);

  const toFetch = candidateUrls
    .map((url) => {
      let score = 0;
      try {
        const parsed = new URL(url);
        score = queryWords.filter((w) => parsed.pathname.toLowerCase().includes(w)).length;
      } catch {
        // ignore parse failures
      }
      return { url, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, clampedMax - 1))
    .map((entry) => entry.url);

  const settled = await Promise.allSettled(
    toFetch.map(async (url) => {
      try {
        const doc = await fetchReadableDocument(url, { timeoutMs, docCache });
        return doc?.status === 'ok' && String(doc.content || '').length > 100 ? doc : null;
      } catch {
        return null;
      }
    })
  );

  const docs = settled
    .filter((result) => result.status === 'fulfilled' && result.value)
    .map((result) => result.value);

  return [homepageDoc, ...docs];
}
