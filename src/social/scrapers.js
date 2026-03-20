// Social platform scrapers — ported from MmmSearch
// Twitter/Nitter, Instagram, YouTube, Facebook, LinkedIn, TikTok, Telegram

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MOBILE_UA  = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const NITTER_INSTANCES = [
  'https://nitter.net',
  'https://nitter.privacydev.net',
  'https://nitter.poast.org',
  'https://xcancel.com',
  'https://nitter.cz',
  'https://nitter.space',
  'https://lightbrd.com',
];

// ─── Shared helpers ───────────────────────────────────────────────────────────

async function fetchWith(url, { headers = {}, timeoutMs = 8000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, ...headers }, signal: ac.signal });
    if (!r.ok) return null;
    return r.text();
  } catch { return null; }
  finally { clearTimeout(t); }
}

function parseOgTags(html) {
  const og = {};
  const unescape = (s) => s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'");
  const re1 = /<meta\s[^>]*property=["']og:([^"']+)["'][^>]*content=["']([^"']*)/gi;
  let m;
  while ((m = re1.exec(html)) !== null) og[m[1]] = unescape(m[2]);
  const re2 = /<meta\s[^>]*content=["']([^"']*)[^>]*property=["']og:([^"']+)["']/gi;
  while ((m = re2.exec(html)) !== null) { if (!og[m[2]]) og[m[2]] = unescape(m[1]); }
  return og;
}

function parseMetaContent(html, name) {
  const quoted = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re1 = new RegExp(`<meta\\s[^>]*name=["']${quoted}["'][^>]*content=["']([^"']*)`, 'i');
  const re2 = new RegExp(`<meta\\s[^>]*content=["']([^"']*)[^>]*name=["']${quoted}["']`, 'i');
  const match = html.match(re1) || html.match(re2);
  return match?.[1]?.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim() || null;
}

function parseTitleTag(html) {
  return html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ')?.trim() || null;
}

export function parseLooseCount(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const compact = value.match(/([\d.,]+)\s*([KMB])?/i);
  if (!compact) return null;
  const num = Number.parseFloat(compact[1].replace(/,/g, '.'));
  if (!Number.isFinite(num)) return null;
  const suffix = (compact[2] || '').toUpperCase();
  const multiplier = suffix === 'K' ? 1_000 : suffix === 'M' ? 1_000_000 : suffix === 'B' ? 1_000_000_000 : 1;
  return Math.round(num * multiplier);
}

function parseNitterRSS(xml) {
  const posts = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let item;
  while ((item = itemRe.exec(xml)) !== null) {
    const titleM = item[1].match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i) || item[1].match(/<title>([\s\S]*?)<\/title>/i);
    const linkM  = item[1].match(/<link>([\s\S]*?)<\/link>/i);
    const dateM  = item[1].match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
    if (titleM) posts.push({ text: titleM[1].trim(), url: linkM?.[1]?.trim() || null, date: dateM?.[1]?.trim() || null });
    if (posts.length >= 5) break;
  }
  return posts;
}

// ─── SocialBlade fallback ─────────────────────────────────────────────────────

async function trySocialBlade(platform, handle) {
  const pathMap = {
    instagram: `instagram/user/${handle}`,
    youtube:   `youtube/channel/${handle}`,
    tiktok:    `tiktok/user/${handle}`,
    twitter:   `twitter/user/${handle}`,
    facebook:  `facebook/user/${handle}`,
  };
  const sbPath = pathMap[platform];
  if (!sbPath) return null;
  const html = await fetchWith(`https://socialblade.com/${sbPath}`, { timeoutMs: 10000 });
  if (!html) return null;
  const og = parseOgTags(html);
  if (!og.title) return null;
  const name = og.title.split(/\s+(?:Instagram|YouTube|Twitch|TikTok|Twitter|Facebook)\s+Stats/i)[0].trim() || handle;
  const followersM = og.description?.match(/([\d,\.]+[KkMm]?)\s*(?:follower|subscriber)/i);
  return {
    platform, handle, name, bio: null,
    followers: followersM?.[1] || null,
    avatar: og.image || null,
    url: og.url || `https://socialblade.com/${sbPath}`,
    scraped: true, source: 'socialblade',
  };
}

// ─── Twitter/X (via Nitter RSS) ───────────────────────────────────────────────

export async function tryNitterInstances(handle) {
  for (const base of NITTER_INSTANCES) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 6000);
    try {
      const rssUrl = `${base}/${encodeURIComponent(handle)}/rss`;
      const r = await fetch(rssUrl, {
        headers: { 'User-Agent': BROWSER_UA, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
        signal: ac.signal,
      });
      clearTimeout(t);
      if (!r.ok) continue;
      const xml = await r.text();
      if (!xml.includes('<rss')) continue;
      const posts      = parseNitterRSS(xml);
      const nameM      = xml.match(/<title><!\[CDATA\[(.*?) \/ Twitter\]\]><\/title>/i) || xml.match(/<title>(.*?) \/ Twitter<\/title>/i);
      const descM      = xml.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i);
      const imgM       = xml.match(/<url>(https?:\/\/[^<]+)<\/url>/i);
      const followersM = xml.match(/(\d[\d,\.]+)\s*Followers/i);
      const followingM = xml.match(/(\d[\d,\.]+)\s*Following/i);
      return {
        platform: 'twitter', handle,
        name: nameM?.[1]?.trim() || handle,
        bio:  descM?.[1]?.trim().slice(0, 300) || null,
        avatar: imgM?.[1]?.trim() || null,
        followers: followersM ? parseInt(followersM[1].replace(/[,\.]/g, '')) : null,
        following: followingM ? parseInt(followingM[1].replace(/[,\.]/g, '')) : null,
        url: `https://x.com/${handle}`,
        recentPosts: posts, scraped: true, source: base,
      };
    } catch { clearTimeout(t); continue; }
  }
  return null;
}

// ─── Instagram ────────────────────────────────────────────────────────────────

async function tryInstagramApi(handle) {
  const IG_APP_ID  = '936619743392459';
  const IG_SESSION = process.env.TERMSEARCH_INSTAGRAM_SESSION || '';
  const url = `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 10000);
  try {
    const hdrs = {
      'x-ig-app-id': IG_APP_ID,
      'x-requested-with': 'XMLHttpRequest',
      'Referer': 'https://www.instagram.com/',
      'Accept': '*/*',
      'User-Agent': BROWSER_UA,
    };
    if (IG_SESSION) hdrs['Cookie'] = IG_SESSION;
    const r = await fetch(url, { headers: hdrs, signal: ac.signal });
    if (!r.ok) return null;
    const data = await r.json();
    if (data?.status === 'fail') return null;
    const user = data?.data?.user;
    if (!user || user.is_private === undefined) return null;
    return {
      platform: 'instagram', handle,
      name: user.full_name || handle,
      bio: user.biography || null,
      avatar: user.profile_pic_url || null,
      followers: user.edge_followed_by?.count ?? null,
      following: user.edge_follow?.count ?? null,
      posts: user.edge_owner_to_timeline_media?.count ?? null,
      isPrivate: user.is_private || false,
      externalUrl: user.external_url || null,
      url: `https://www.instagram.com/${handle}/`,
      scraped: true, source: 'instagram-api',
    };
  } catch { return null; }
  finally { clearTimeout(t); }
}

async function tryDumpor(handle) {
  const html = await fetchWith(`https://dumpor.io/v/${encodeURIComponent(handle)}`);
  if (!html) return null;
  const og = parseOgTags(html);
  if (!og.title) return null;
  if (og.title.toLowerCase().includes('dumpor') || og.title.toLowerCase().includes('watch instagram')) return null;
  if (og.image && og.image.includes('dumpor.io/images')) return null;
  const name       = og.title.split('(')[0].split('•')[0].trim() || handle;
  const followersM = og.description?.match(/([\d,]+)\s*Followers/i);
  const followingM = og.description?.match(/([\d,]+)\s*Following/i);
  const postsM     = og.description?.match(/([\d,]+)\s*Posts/i);
  const bioM       = html.match(/class="[^"]*bio[^"]*"[^>]*>([\s\S]{1,300}?)<\/(?:p|div|span)>/i);
  const bioText    = bioM ? bioM[1].replace(/<[^>]+>/g, '').trim() : null;
  let externalUrl  = null;
  const linkRe     = /<a[^>]+href=["'](https?:\/\/(?!(?:www\.)?(?:instagram\.com|dumpor\.io))[^"'\s>]+)["']/gi;
  let lm;
  while ((lm = linkRe.exec(html)) !== null) {
    const u = lm[1];
    if (/\.(png|jpg|gif|woff|css|js)(\?|$)/i.test(u)) continue;
    if (/fonts\.googleapis|cdn\.|static\.|analytics|fbcdn|cdninstagram/i.test(u)) continue;
    externalUrl = u; break;
  }
  return {
    platform: 'instagram', handle, name, bio: bioText,
    avatar: og.image || null,
    followers: followersM ? parseInt(followersM[1].replace(/,/g, '')) : null,
    following: followingM ? parseInt(followingM[1].replace(/,/g, '')) : null,
    posts: postsM ? parseInt(postsM[1].replace(/,/g, '')) : null,
    externalUrl, url: `https://www.instagram.com/${handle}/`,
    scraped: true, source: 'dumpor',
  };
}

export async function fetchInstagramProfile(handle) {
  return await tryInstagramApi(handle) || await tryDumpor(handle) || await trySocialBlade('instagram', handle) || null;
}

// ─── YouTube ──────────────────────────────────────────────────────────────────

export async function fetchYouTubeProfile(handle, profileUrl = null) {
  const candidates = [
    profileUrl,
    `https://www.youtube.com/@${encodeURIComponent(handle)}`,
    `https://www.youtube.com/channel/${encodeURIComponent(handle)}`,
    `https://www.youtube.com/c/${encodeURIComponent(handle)}`,
    `https://www.youtube.com/user/${encodeURIComponent(handle)}`,
  ].filter(Boolean);
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const html = await fetchWith(candidate, { headers: { 'Accept-Language': 'en-US,en;q=0.9' }, timeoutMs: 10000 });
    if (!html) continue;
    const og          = parseOgTags(html);
    const metaDesc    = parseMetaContent(html, 'description');
    const titleTag    = parseTitleTag(html);
    const title       = og.title || titleTag || handle;
    const name        = title.replace(/\s*-\s*YouTube.*$/i, '').trim() || handle;
    const description = [og.description, metaDesc].map((s) => String(s || '').replace(/\s+/g, ' ').trim()).find(Boolean) || null;
    const subM = html.match(/"subscriberCountText"\s*:\s*\{"simpleText":"([^"]+)"/) || html.match(/"subscriberCountText"\s*:\s*\{"runs":\[\{"text":"([^"]+)"/);
    const vidM = html.match(/"videosCountText"\s*:\s*\{"runs":\[\{"text":"([^"]+)"/) || description?.match(/([\d.,KMB]+)\s+videos?/i);
    if (!name && !description) continue;
    return {
      platform: 'youtube', handle, name,
      bio: description && description !== name ? description : null,
      avatar: og.image || null,
      followers: parseLooseCount(subM?.[1]),
      posts: parseLooseCount(Array.isArray(vidM) ? vidM[1] : vidM),
      url: og.url || candidate,
      scraped: true, source: 'youtube-page',
    };
  }
  return await trySocialBlade('youtube', handle) || null;
}

// ─── Facebook ─────────────────────────────────────────────────────────────────

export async function fetchFacebookPage(url, handle) {
  const mobileUrl = url.replace('www.facebook.com', 'm.facebook.com').replace('fb.com', 'm.facebook.com');
  for (const [tryUrl, ua] of [[mobileUrl, MOBILE_UA], [url, BROWSER_UA]]) {
    const html = await fetchWith(tryUrl, { headers: { 'User-Agent': ua } });
    if (!html) continue;
    const og = parseOgTags(html);
    if (!og.title && !og.description) continue;
    const followersM = og.description?.match(/([\d,\.]+[KkMm]?)\s*(?:follower|like|Mi piace)/i);
    return {
      platform: 'facebook', handle,
      name: og.title || handle,
      bio: og.description?.split('·')[0]?.split('|')[0]?.trim() || null,
      avatar: og.image || null,
      followers: followersM?.[1] || null,
      url: og.url || url,
      scraped: true, source: tryUrl.includes('m.facebook') ? 'facebook-mobile' : 'facebook',
    };
  }
  return null;
}

// ─── LinkedIn ─────────────────────────────────────────────────────────────────

export async function fetchLinkedInProfile(handle) {
  const html = await fetchWith(`https://www.linkedin.com/in/${encodeURIComponent(handle)}/`, {
    headers: { 'Accept-Language': 'en-US,en;q=0.9', 'Cache-Control': 'no-cache' },
    timeoutMs: 10000,
  });
  if (html) {
    const og = parseOgTags(html);
    if (og.title && !og.title.toLowerCase().includes('linkedin') && og.title !== 'LinkedIn') {
      const headline = og.description?.split('|')[0]?.split('–')[0]?.split('-')[0]?.trim() || null;
      return {
        platform: 'linkedin', handle,
        name: og.title.split('|')[0].split('-')[0].trim() || handle,
        bio: headline, avatar: og.image || null,
        url: og.url || `https://linkedin.com/in/${handle}`,
        scraped: true, source: 'linkedin-og',
      };
    }
  }
  return { platform: 'linkedin', handle, name: handle, url: `https://linkedin.com/in/${handle}`, webOnly: true };
}

// ─── TikTok ───────────────────────────────────────────────────────────────────

export async function fetchTikTokProfile(handle) {
  const html = await fetchWith(`https://www.tiktok.com/@${encodeURIComponent(handle)}`);
  if (html) {
    const og = parseOgTags(html);
    if (og.title) {
      const name       = og.title.split('(')[0].split('-')[0].split('|')[0].trim() || handle;
      const followersM = html.match(/"followerCount"\s*:\s*(\d+)/);
      const followingM = html.match(/"followingCount"\s*:\s*(\d+)/);
      const likesM     = html.match(/"heartCount"\s*:\s*(\d+)/);
      const bioM       = html.match(/"signature"\s*:\s*"([^"]{1,300})"/);
      return {
        platform: 'tiktok', handle, name,
        bio: bioM?.[1] || og.description?.split('·')[0]?.trim() || null,
        avatar: og.image || null,
        followers: followersM ? parseInt(followersM[1]) : null,
        following: followingM ? parseInt(followingM[1]) : null,
        likes: likesM ? parseInt(likesM[1]) : null,
        url: `https://www.tiktok.com/@${handle}`,
        scraped: true, source: 'tiktok-og',
      };
    }
  }
  return await trySocialBlade('tiktok', handle) || null;
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

export async function fetchTelegramProfile(handle) {
  const h = handle.replace(/^@/, '');
  const html = await fetchWith(`https://t.me/${encodeURIComponent(h)}`);
  if (!html) return null;
  const og      = parseOgTags(html);
  const nameM   = html.match(/<div class="tgme_page_title"[^>]*>([\s\S]*?)<\/div>/i);
  const descM   = html.match(/<div class="tgme_page_description"[^>]*>([\s\S]*?)<\/div>/i);
  const extraM  = html.match(/<div class="tgme_page_extra"[^>]*>([\s\S]*?)<\/div>/i);
  const avatarM = html.match(/<img class="tgme_page_photo_image"[^>]*src="([^"]+)"/i);
  const name    = nameM?.[1]?.replace(/<[^>]+>/g, '').trim() || og.title || h;
  const bio     = descM?.[1]?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || og.description || null;
  const extraTx = (extraM?.[1] || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const membersM = extraTx.match(/([\d\s]+)\s*(?:subscriber|member)/i);
  if (!name && !bio) return null;
  return {
    platform: 'telegram', handle: h, name, bio,
    avatar: avatarM?.[1] || og.image || null,
    followers: membersM ? parseInt(membersM[1].replace(/\s/g, ''), 10) : null,
    url: `https://t.me/${h}`,
    scraped: true, source: 'telegram-page',
  };
}
