// Profile scanner — ported from MmmSearch
// Supports: GitHub, Bluesky, Reddit, Twitter/X, Instagram, YouTube, LinkedIn, TikTok, Telegram, Facebook

import { tryNitterInstances, fetchInstagramProfile, fetchYouTubeProfile, fetchFacebookPage, fetchLinkedInProfile, fetchTikTokProfile, fetchTelegramProfile } from '../social/scrapers.js';
import { fetchBlueskyActors } from '../social/search.js';

export const PROFILER_PLATFORMS = new Set([
  'github', 'bluesky', 'reddit', 'twitter', 'instagram',
  'linkedin', 'telegram', 'youtube', 'facebook', 'tiktok', 'auto',
]);

// ─── URL/handle detection ─────────────────────────────────────────────────────

export function detectProfileTarget(raw) {
  const q = (raw || '').trim();
  let m;
  if ((m = q.match(/github\.com\/([A-Za-z0-9_-]+)/i)))                               return { platform: 'github',    handle: m[1], url: `https://github.com/${m[1]}` };
  if ((m = q.match(/bsky\.app\/profile\/([A-Za-z0-9._:-]+)/i)))                       return { platform: 'bluesky',   handle: m[1], url: `https://bsky.app/profile/${m[1]}` };
  if ((m = q.match(/reddit\.com\/u(?:ser)?\/([A-Za-z0-9_-]+)/i)))                     return { platform: 'reddit',    handle: m[1], url: `https://reddit.com/u/${m[1]}` };
  if ((m = q.match(/(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{3,})/i)))                   return { platform: 'telegram',  handle: m[1], url: `https://t.me/${m[1]}` };
  if ((m = q.match(/(?:twitter|x)\.com\/([A-Za-z0-9_]+)(?:\/|$)/i)))                 return { platform: 'twitter',   handle: m[1], url: `https://x.com/${m[1]}` };
  if ((m = q.match(/youtube\.com\/@([A-Za-z0-9._-]+)(?:\/|$|\?|#)/i)))               return { platform: 'youtube',   handle: m[1], url: `https://www.youtube.com/@${m[1]}` };
  if ((m = q.match(/youtube\.com\/(?:channel|c|user)\/([A-Za-z0-9._-]+)(?:\/|$)/i))) return { platform: 'youtube',   handle: m[1], url: `https://www.youtube.com/channel/${m[1]}` };
  if ((m = q.match(/instagram\.com\/([A-Za-z0-9_.]+)(?:\/|$)/i)))                     return { platform: 'instagram', handle: m[1], url: `https://instagram.com/${m[1]}` };
  if ((m = q.match(/linkedin\.com\/in\/([A-Za-z0-9_-]+)(?:\/|$)/i)))                 return { platform: 'linkedin',  handle: m[1], url: `https://linkedin.com/in/${m[1]}` };
  if ((m = q.match(/(?:facebook|fb)\.com\/([A-Za-z0-9_.]+)(?:\/|$)/i)))              return { platform: 'facebook',  handle: m[1], url: `https://www.facebook.com/${m[1]}` };
  if ((m = q.match(/tiktok\.com\/@([A-Za-z0-9_.]+)(?:\/|$)/i)))                       return { platform: 'tiktok',   handle: m[1], url: `https://www.tiktok.com/@${m[1]}` };
  if ((m = q.match(/^@([A-Za-z0-9_.][A-Za-z0-9_.-]{0,58})$/)))                        return { platform: 'auto',     handle: m[1], url: null };
  return null;
}

// ─── GitHub ───────────────────────────────────────────────────────────────────

async function ghFetch(path) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  try {
    const hdrs = { 'User-Agent': 'TermSearch/1.0', Accept: 'application/vnd.github.v3+json' };
    const token = process.env.TERMSEARCH_GITHUB_TOKEN;
    if (token) hdrs['Authorization'] = `token ${token}`;
    const r = await fetch(`https://api.github.com${path}`, { headers: hdrs, signal: ac.signal });
    if (!r.ok) return null;
    return r.json();
  } catch { return null; }
  finally { clearTimeout(t); }
}

export async function fetchGitHubProfileData(handle) {
  const [user, repos] = await Promise.all([
    ghFetch(`/users/${encodeURIComponent(handle)}`),
    ghFetch(`/users/${encodeURIComponent(handle)}/repos?per_page=100&sort=updated`),
  ]);
  if (!user || user.message) return null;
  const sortedRepos = (Array.isArray(repos) ? repos : [])
    .sort((a, b) => {
      const s = Number(b.stargazers_count || 0) - Number(a.stargazers_count || 0);
      if (s !== 0) return s;
      const f = Number(b.forks_count || 0) - Number(a.forks_count || 0);
      if (f !== 0) return f;
      return new Date(b.updated_at || 0) - new Date(a.updated_at || 0);
    })
    .slice(0, 8);
  return {
    platform: 'github', handle: user.login, name: user.name || user.login,
    bio: user.bio || null, avatar: user.avatar_url, url: user.html_url,
    followers: user.followers, following: user.following,
    publicRepos: user.public_repos, company: user.company || null,
    location: user.location || null, blog: user.blog || null,
    createdAt: user.created_at,
    topRepos: sortedRepos.map((r) => ({
      name: r.name, stars: r.stargazers_count, forks: r.forks_count,
      lang: r.language || null, description: (r.description || '').slice(0, 180),
      url: r.html_url,
    })),
  };
}

// ─── Bluesky ──────────────────────────────────────────────────────────────────

export async function fetchBlueskyProfileData(handle) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(`https://api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(handle)}`, {
      headers: { 'User-Agent': 'TermSearch/1.0' }, signal: ac.signal,
    });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d.handle) return null;
    return {
      platform: 'bluesky', handle: d.handle, name: d.displayName || d.handle,
      bio: d.description || null, avatar: d.avatar || null,
      url: `https://bsky.app/profile/${d.handle}`,
      followers: d.followersCount, following: d.followsCount, postsCount: d.postsCount,
      createdAt: d.indexedAt || null,
    };
  } catch { return null; }
  finally { clearTimeout(t); }
}

// ─── Reddit ───────────────────────────────────────────────────────────────────

export async function fetchRedditProfileData(handle) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(`https://www.reddit.com/user/${encodeURIComponent(handle)}/about.json`, {
      headers: { 'User-Agent': 'TermSearch/1.0 (by /u/termsearch)', Accept: 'application/json' },
      signal: ac.signal,
    });
    if (!r.ok) return null;
    const d = await r.json();
    const u = d?.data;
    if (!u || u.is_suspended) return null;
    return {
      platform: 'reddit', handle: u.name, name: u.name,
      bio: u.subreddit?.public_description || null,
      avatar: u.icon_img ? u.icon_img.split('?')[0] : null,
      url: `https://reddit.com/u/${u.name}`,
      karma: u.total_karma, linkKarma: u.link_karma, commentKarma: u.comment_karma,
      createdAt: new Date(u.created_utc * 1000).toISOString(),
    };
  } catch { return null; }
  finally { clearTimeout(t); }
}

// ─── Similar profiles ─────────────────────────────────────────────────────────

async function findSimilarGitHub(profile) {
  const langs = [...new Set((profile.topRepos || []).map((r) => r.lang).filter(Boolean))].slice(0, 1);
  const minF  = Math.max(5, Math.floor((profile.followers || 100) * 0.15));
  const q     = langs.length > 0 ? `language:${langs[0]} followers:>${minF} repos:>2` : `followers:>${minF} repos:>3`;
  const data  = await ghFetch(`/search/users?q=${encodeURIComponent(q)}&per_page=8&sort=followers`);
  return (data?.items || [])
    .filter((u) => u.login.toLowerCase() !== profile.handle.toLowerCase())
    .slice(0, 6)
    .map((u) => ({ platform: 'github', handle: u.login, name: u.login, avatar: u.avatar_url, url: u.html_url }));
}

async function findSimilarBluesky(profile) {
  const terms  = (profile.bio || profile.name || '').split(/\s+/).slice(0, 4).join(' ');
  if (!terms.trim()) return [];
  const actors = await fetchBlueskyActors(terms, 8);
  return actors
    .filter((a) => a.handle !== profile.handle)
    .slice(0, 6)
    .map((a) => ({
      platform: 'bluesky', handle: a.handle,
      name: (a.title || '').replace(/ \(@.*\)$/, '') || a.handle,
      bio: a.snippet || null, url: a.url,
    }));
}

// ─── Main scan ────────────────────────────────────────────────────────────────

export async function scanProfile(target) {
  const { platform, handle, url } = target;
  let profile = null;
  let similar = [];

  switch (platform) {
    case 'github':
      profile = await fetchGitHubProfileData(handle);
      if (profile) similar = await findSimilarGitHub(profile).catch(() => []);
      break;
    case 'bluesky':
      profile = await fetchBlueskyProfileData(handle);
      if (profile) similar = await findSimilarBluesky(profile).catch(() => []);
      break;
    case 'reddit':
      profile = await fetchRedditProfileData(handle);
      break;
    case 'twitter':
      profile = await tryNitterInstances(handle);
      break;
    case 'instagram':
      profile = await fetchInstagramProfile(handle);
      break;
    case 'youtube':
      profile = await fetchYouTubeProfile(handle, url);
      break;
    case 'facebook':
      profile = url ? await fetchFacebookPage(url, handle) : null;
      break;
    case 'linkedin':
      profile = await fetchLinkedInProfile(handle);
      break;
    case 'tiktok':
      profile = await fetchTikTokProfile(handle);
      break;
    case 'telegram':
      profile = await fetchTelegramProfile(handle);
      break;
    case 'auto': {
      // Try platforms in order for @handle
      const attempts = [
        () => fetchBlueskyProfileData(handle),
        () => fetchGitHubProfileData(handle),
        () => fetchRedditProfileData(handle),
        () => tryNitterInstances(handle),
        () => fetchTelegramProfile(handle),
      ];
      for (const attempt of attempts) {
        profile = await attempt().catch(() => null);
        if (profile) break;
      }
      break;
    }
  }

  return { target, profile: profile || null, similar };
}
