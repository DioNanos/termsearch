// Torrent scrapers — multi-source, no API keys required
// Sources: TPB, 1337x, YTS (JSON API), Nyaa, EZTV (API), Torrent Galaxy

import { assertPublicUrl } from '../fetch/ssrf-guard.js';

const TPB_MIRRORS = [
  'https://tpb.party',
  'https://thepiratebay.org',
];

const MIRRORS_1337X = [
  'https://www.1337xx.to',
  'https://1337x.unblockit.bz',
  'https://1337x.nocensor.lol',
];

const TORRENT_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:122.0) Gecko/20100101 Firefox/122.0';

// ─── Shared fetch ─────────────────────────────────────────────────────────────

async function fetchTorrentPage(url, timeoutMs = 10_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': TORRENT_UA, Accept: 'text/html,*/*;q=0.5' },
      signal: ac.signal, redirect: 'follow',
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = await r.arrayBuffer();
    return Buffer.from(buf).subarray(0, 300_000).toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

export function extractMagnetFromHtml(html) {
  const m = html.match(/href="(magnet:\?xt=urn:btih:[^"&]{20,}[^"]*)"/i);
  return m ? m[1] : null;
}

// ─── The Pirate Bay ───────────────────────────────────────────────────────────
// Magnets are directly in search results — no per-page fetch needed

export async function scrapeTPB(query, limit = 8) {
  const slug = encodeURIComponent(query.trim());
  for (const base of TPB_MIRRORS) {
    try {
      const html = await fetchTorrentPage(`${base}/search/${slug}/0/99/0`, 12_000);
      const rows    = html.split(/<tr[\s>]/gi).slice(1);
      const results = [];
      for (const row of rows) {
        if (results.length >= limit) break;
        const magnetM = row.match(/href="(magnet:\?xt=urn:btih:[^"]{20,}?)"/i);
        if (!magnetM) continue;
        const titleM  = row.match(/href="[^"]*\/torrent\/\d+[^"]*"[^>]*>([^<]{3,120})<\/a>/i)
          || row.match(/title="Details for ([^"]{3,120})"/i);
        const seedsM  = row.match(/<td align="right">(\d+)<\/td>/ig);
        const seed    = seedsM?.[0] ? parseInt(seedsM[0].replace(/<[^>]+>/g, ''), 10) : 0;
        const leech   = seedsM?.[1] ? parseInt(seedsM[1].replace(/<[^>]+>/g, ''), 10) : 0;
        results.push({
          title: titleM ? titleM[1].trim() : 'Unknown',
          url: `${base}/torrent/` + (row.match(/href="[^"]*\/torrent\/(\d+)/i)?.[1] || ''),
          magnetLink: magnetM[1], seed, leech, engine: 'piratebay',
        });
      }
      if (results.length > 0) return results;
    } catch { /* try next mirror */ }
  }
  return [];
}

// ─── 1337x ────────────────────────────────────────────────────────────────────
// Must fetch each torrent page individually to get the magnet link

const QUERY_STOP_WORDS = new Set(['torrent', 'download', 'iso', 'film', 'serie', 'series', 'movie', 'full', 'free', 'crack', 'cracked', 'repack', 'pack']);

export async function scrape1337x(query, limit = 5) {
  const slug = query.trim().split(/\s+/).join('+');
  for (const base of MIRRORS_1337X) {
    try {
      const html = await fetchTorrentPage(`${base}/sort-search/${slug}/seeders/desc/1/`, 14_000);
      if (html.includes('window.location.replace') || html.includes('FingerprintJS')) continue;

      const rows  = html.split(/<tr[\s>]/gi).slice(1);
      const items = [];
      for (const row of rows) {
        if (items.length >= limit * 4) break;
        const titleM = row.match(/<a href="(\/torrent\/\d+\/[^"]+\/)"[^>]*>([^<]{3,120})<\/a>/i);
        if (!titleM) continue;
        const seedM  = row.match(/class="coll-2 seeds[^"]*"[^>]*>\s*([\d,]+)\s*<\/td>/i);
        items.push({ path: titleM[1], title: titleM[2].trim(), seed: seedM ? parseInt(seedM[1].replace(/,/g, ''), 10) : 0 });
      }
      if (!items.length) continue;

      const queryWords = query.toLowerCase().split(/\s+/).filter((w) => w.length >= 3 && !/^\d+$/.test(w) && !QUERY_STOP_WORDS.has(w));
      const relevant   = queryWords.length ? items.filter((r) => queryWords.every((w) => r.title.toLowerCase().includes(w))) : items;
      if (!relevant.length) continue;

      const top        = relevant.sort((a, b) => b.seed - a.seed).slice(0, limit);
      const settled    = await Promise.allSettled(top.map(async (it) => {
        const pageUrl  = `${base}${it.path}`;
        try {
          const pageHtml = await fetchTorrentPage(pageUrl, 10_000);
          if (pageHtml.includes('window.location.replace')) return null;
          const magnet   = extractMagnetFromHtml(pageHtml);
          return magnet ? { ...it, url: pageUrl, magnetLink: magnet, engine: '1337x' } : null;
        } catch { return null; }
      }));
      const results = settled.filter((r) => r.status === 'fulfilled' && r.value).map((r) => r.value);
      if (results.length > 0) return results;
    } catch { /* try next mirror */ }
  }
  return [];
}

// ─── YTS (YIFY) ───────────────────────────────────────────────────────────────
// Public JSON API — movies only, high-quality releases, direct magnets

export async function scrapeYTS(query, limit = 8) {
  const params = new URLSearchParams({ query_term: query, limit: String(limit), sort_by: 'seeds', order_by: 'desc' });
  try {
    const html = await fetchTorrentPage(`https://yts.mx/api/v2/list_movies.json?${params}`, 10_000);
    const data = JSON.parse(html);
    const movies = data?.data?.movies || [];
    const results = [];
    for (const movie of movies) {
      for (const torrent of (movie.torrents || []).slice(0, 2)) {
        const hash = torrent.hash;
        if (!hash) continue;
        const magnet = `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(movie.title_long)}&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr=udp%3A%2F%2Fopen.tracker.cl%3A1337%2Fannounce`;
        results.push({
          title:     `${movie.title_long} [${torrent.quality}] [${torrent.type || 'web'}]`,
          url:       movie.url || `https://yts.mx/movies/${movie.slug}`,
          magnetLink: magnet,
          seed:      torrent.seeds || 0,
          leech:     torrent.peers || 0,
          engine:    'yts',
          filesize:  torrent.size || null,
        });
        if (results.length >= limit) break;
      }
      if (results.length >= limit) break;
    }
    return results;
  } catch { return []; }
}

// ─── Nyaa ─────────────────────────────────────────────────────────────────────
// Anime/manga/JP content — simple table HTML, magnets inline

const NYAA_MIRRORS = [
  'https://nyaa.si',
  'https://nyaa.land',
];

export async function scrapeNyaa(query, limit = 8) {
  const slug = encodeURIComponent(query.trim());
  for (const base of NYAA_MIRRORS) {
    try {
      const html = await fetchTorrentPage(`${base}/?q=${slug}&s=seeders&o=desc`, 12_000);
      if (html.includes('Cloudflare') || html.includes('cf-browser-verification')) continue;
      const rows = html.split(/<tr[\s>]/gi).slice(1);
      const results = [];
      for (const row of rows) {
        if (results.length >= limit) break;
        const magnetM = row.match(/href="(magnet:\?xt=urn:btih:[^"]{20,}?)"/i);
        if (!magnetM) continue;
        const titleM = row.match(/title="([^"]{3,200})"/i) || row.match(/class="[^"]*success[^"]*"[^>]*>\s*<[^>]+>([^<]{3,200})<\/a>/i);
        const seedM  = row.match(/<td[^>]*class="[^"]*success[^"]*"[^>]*>\s*(\d+)\s*<\/td>/i);
        const leechM = row.match(/<td[^>]*class="[^"]*danger[^"]*"[^>]*>\s*(\d+)\s*<\/td>/i);
        const title  = titleM ? titleM[1].trim() : 'Unknown';
        results.push({
          title, url: '', magnetLink: magnetM[1],
          seed:  seedM  ? parseInt(seedM[1],  10) : 0,
          leech: leechM ? parseInt(leechM[1], 10) : 0,
          engine: 'nyaa',
        });
      }
      if (results.length > 0) return results;
    } catch { /* next mirror */ }
  }
  return [];
}

// ─── EZTV ─────────────────────────────────────────────────────────────────────
// TV shows — JSON API, direct magnets

export async function scrapeEZTV(query, limit = 8) {
  const params = new URLSearchParams({ limit: String(limit), page: '1', q: query });
  try {
    const html = await fetchTorrentPage(`https://eztv.re/api/get-torrents?${params}`, 10_000);
    const data = JSON.parse(html);
    const torrents = data?.torrents || [];
    return torrents.slice(0, limit).map((t) => ({
      title:     t.title || t.filename || 'Unknown',
      url:       t.episode_url || '',
      magnetLink: t.magnet_url || '',
      seed:      t.seeds  || 0,
      leech:     t.peers  || 0,
      engine:    'eztv',
      filesize:  t.size_bytes ? `${(t.size_bytes / 1_073_741_824).toFixed(2)} GB` : null,
    })).filter((r) => r.magnetLink);
  } catch { return []; }
}

// ─── Torrent Galaxy (TGx) ─────────────────────────────────────────────────────
// General index — HTML scraping, good for software/movies/games

const TGX_MIRRORS = [
  'https://torrentgalaxy.to',
  'https://tgx.rs',
];

export async function scrapeTGx(query, limit = 6) {
  const slug = encodeURIComponent(query.trim());
  for (const base of TGX_MIRRORS) {
    try {
      const html = await fetchTorrentPage(`${base}/torrents.php?search=${slug}&sort=seeders&order=desc`, 14_000);
      if (html.includes('Cloudflare') || html.length < 2000) continue;

      const rows = html.split(/<div[^>]+class="[^"]*tgxtablerow[^"]*"/gi).slice(1);
      const results = [];
      for (const row of rows) {
        if (results.length >= limit) break;
        const magnetM = row.match(/href="(magnet:\?xt=urn:btih:[^"]{20,}?)"/i);
        if (!magnetM) continue;
        const titleM = row.match(/href="\/torrent\/\d+\/([^"]+)"[^>]*class="[^"]*txlight[^"]*"/i)
          || row.match(/title="([^"]{3,200})"/i);
        const seedM  = row.match(/<span[^>]*class="[^"]*tgxtable-s[^"]*"[^>]*>\s*(\d+)\s*<\/span>/i);
        const title  = titleM ? decodeURIComponent(titleM[1].replace(/\+/g, ' ')).trim() : 'Unknown';
        results.push({
          title, url: '', magnetLink: magnetM[1],
          seed:  seedM ? parseInt(seedM[1], 10) : 0,
          leech: 0, engine: 'tgx',
        });
      }
      if (results.length > 0) return results;
    } catch { /* next mirror */ }
  }
  return [];
}

// ─── Magnet extraction from URL ───────────────────────────────────────────────

export async function extractMagnetFromUrl(rawUrl) {
  await assertPublicUrl(rawUrl);
  const html   = await fetchTorrentPage(rawUrl, 10_000);
  const magnet = extractMagnetFromHtml(html);
  if (!magnet) throw new Error('No magnet link found on page');
  return magnet;
}
