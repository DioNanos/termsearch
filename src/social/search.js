// Social search — Bluesky (AT Protocol) + GDELT news
// Ported from MmmSearch

// ─── Bluesky ──────────────────────────────────────────────────────────────────

export async function fetchBlueskyPosts(query, limit = 25) {
  const url = `https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(query)}&limit=${Math.min(limit, 100)}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'TermSearch/1.0' }, signal: ac.signal });
    if (!r.ok) return [];
    const data = await r.json();
    return (data.posts || []).map((post) => {
      const uriParts = (post.uri || '').split('/');
      const rkey   = uriParts[uriParts.length - 1];
      const handle = post.author?.handle || 'unknown';
      const text   = post.record?.text || '';
      return {
        title: (post.author?.displayName || handle) + ': ' + text.slice(0, 100),
        url: `https://bsky.app/profile/${handle}/post/${rkey}`,
        snippet: text, engine: 'bluesky',
        author: handle,
        likeCount: post.likeCount || 0,
        repostCount: post.repostCount || 0,
        publishedDate: post.record?.createdAt || null,
      };
    });
  } catch { return []; }
  finally { clearTimeout(timer); }
}

export async function fetchBlueskyActors(query, limit = 20) {
  const url = `https://api.bsky.app/xrpc/app.bsky.actor.searchActors?q=${encodeURIComponent(query)}&limit=${Math.min(limit, 100)}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'TermSearch/1.0' }, signal: ac.signal });
    if (!r.ok) return [];
    const data = await r.json();
    return (data.actors || []).map((actor) => ({
      title: (actor.displayName || actor.handle) + ' (@' + actor.handle + ')',
      url: `https://bsky.app/profile/${actor.handle}`,
      snippet: actor.description || '',
      engine: 'bluesky users',
      handle: actor.handle,
      followersCount: actor.followersCount || 0,
      publishedDate: null,
    }));
  } catch { return []; }
  finally { clearTimeout(timer); }
}

// ─── GDELT ────────────────────────────────────────────────────────────────────

export async function fetchGdeltArticles(query, limit = 25) {
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=artlist&maxrecords=${Math.min(limit, 250)}&format=json`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12_000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'TermSearch/1.0' }, signal: ac.signal });
    if (!r.ok) return [];
    const data = await r.json();
    return (data.articles || []).map((article) => {
      const raw = article.seendate || '';
      const publishedDate = raw.length >= 8 ? raw.slice(0, 4) + '-' + raw.slice(4, 6) + '-' + raw.slice(6, 8) : null;
      return {
        title: article.title || '',
        url: article.url || '',
        snippet: article.title || '',
        engine: 'gdelt', publishedDate,
        source: article.domain || null,
      };
    }).filter((a) => a.url);
  } catch { return []; }
  finally { clearTimeout(timer); }
}
