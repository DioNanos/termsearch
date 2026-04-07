// AI query refinement — Phase 0 (parallel with search, optional)

import { call } from './providers/openai-compat.js';

// Fast regex-based torrent intent detection (no AI call needed)
export const TORRENT_QUERY_RE = /\b(torrent|magnet|\.iso|\.mkv|\.avi|\.mp4|720p|1080p|2160p|4k|uhd|season|s\d{1,2}e\d{1,2}|xvid|x264|x265|hevc|blu.?ray|webrip|dvdrip|bdrip|hdtv|yify|yts|piratebay|1337x|nyaa|eztv|tgx|download\s+film|download\s+serie|scarica\s+film)\b/i;

// Available engine names for also_search_on routing
const ENGINE_ROUTING_RULES = `
Engine routing rules — pick from this list only:
- Code, libraries, APIs, "how to implement", programming → ["github-api", "duckduckgo", "hackernews"]
- Opinions, reviews, "best X", community advice → ["reddit", "duckduckgo"]
- Academic papers, research, studies, citations → ["wikidata", "duckduckgo"]
- Open source, FOSS, privacy tools → ["github-api", "marginalia", "duckduckgo"]
- Person/brand social presence → ["reddit", "duckduckgo"]
- Anime, manga, Japanese content → ["nyaa", "duckduckgo"]
- TV shows, episodes → ["eztv", "duckduckgo"]
- Movies, film downloads → ["yts", "piratebay", "duckduckgo"]
- General torrent/file downloads → ["piratebay", "1337x", "tgx"]
- News, current events → ["duckduckgo", "hackernews"]
- Definitions, encyclopedic → ["wikipedia", "duckduckgo"]
- Default/other → ["duckduckgo", "startpage"]`;

function buildQueryInterpretPrompt({ query, lang }) {
  const langName = {
    'it-IT': 'Italian', 'en-US': 'English', 'es-ES': 'Spanish',
    'fr-FR': 'French', 'de-DE': 'German', 'pt-PT': 'Portuguese',
  }[lang] || 'English';

  return `Analyze this search query and respond in JSON only.

Query: "${query}"
User language: ${langName}

Respond with this exact JSON structure:
{
  "refined_query": "improved version of the query (or same if already good)",
  "intent": "one of: torrent, code, social, academic, news, definition, how_to, other",
  "also_search_on": ["engine1", "engine2"],
  "category": "one of: web, torrent, images, news"
}
${ENGINE_ROUTING_RULES}

Rules:
- refined_query: fix typos, expand acronyms — keep concise
- intent: classify the query type
- also_search_on: 2-3 engine names from the routing rules above, best match for this query
- category: "torrent" if the query is clearly about downloading files/media, else "web"
- JSON only, no explanation`;
}

// Returns { refined_query, intent, also_search_on, category } or null on failure
export async function refineQuery({ query, lang = 'en-US' }, aiConfig) {
  if (!aiConfig?.enabled || !aiConfig?.api_base || !aiConfig?.model) return null;

  try {
    const result = await call(buildQueryInterpretPrompt({ query, lang }), {
      apiBase: aiConfig.api_base,
      apiKey: aiConfig.api_key,
      model: aiConfig.model,
      maxTokens: 200,
      timeoutMs: 5000,
      jsonMode: true,
    });

    if (!result?.content) return null;
    const parsed = JSON.parse(result.content);

    const ALLOWED_ENGINES = new Set([
      'duckduckgo', 'wikipedia', 'startpage', 'qwant', 'ecosia', 'brave', 'mojeek',
      'github', 'github-api', 'hackernews', 'reddit', 'yandex', 'marginalia', 'ahmia',
      'piratebay', '1337x', 'yts', 'nyaa', 'eztv', 'tgx',
      'wikidata', 'youtube', 'mastodon users', 'lemmy posts',
    ]);

    return {
      refined_query:  String(parsed.refined_query || query).slice(0, 240),
      intent:         String(parsed.intent || 'other'),
      also_search_on: Array.isArray(parsed.also_search_on)
        ? parsed.also_search_on.map(String).filter(e => ALLOWED_ENGINES.has(e)).slice(0, 3)
        : [],
      category: ['web', 'torrent', 'images', 'news'].includes(parsed.category) ? parsed.category : 'web',
    };
  } catch {
    return null;
  }
}
