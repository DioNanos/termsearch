// AI summary generation — 2-phase agentic flow
// Phase 1: decide which URLs to fetch
// Phase 2: synthesize summary from fetched content

const LANG_NAMES = {
  'it-IT': 'Italian', 'en-US': 'English', 'es-ES': 'Spanish',
  'fr-FR': 'French', 'de-DE': 'German', 'pt-PT': 'Portuguese',
  'ru-RU': 'Russian', 'zh-CN': 'Chinese', 'ja-JP': 'Japanese',
};

function getLanguageOutputRule(lang) {
  if (lang === 'it-IT') return 'FINAL OUTPUT LANGUAGE RULE: write ONLY in Italian.';
  if (lang === 'es-ES') return 'FINAL OUTPUT LANGUAGE RULE: write ONLY in Spanish.';
  if (lang === 'fr-FR') return 'FINAL OUTPUT LANGUAGE RULE: write ONLY in French.';
  if (lang === 'de-DE') return 'FINAL OUTPUT LANGUAGE RULE: write ONLY in German.';
  return 'FINAL OUTPUT LANGUAGE RULE: write in the language the user query is in.';
}

// Build Phase 1 prompt: AI decides which URLs to fetch
export function buildFetchDecisionPrompt({ query, results, maxFetch = 10, session = [] }) {
  const list = results.slice(0, 10).map((r, i) =>
    `[${i + 1}] ${r.title} — ${r.snippet || '(no snippet)'}\n    URL: ${r.url}${r.publishedDate ? `\n    Published: ${r.publishedDate}` : ''}${r.engine ? `\n    Engine: ${r.engine}` : ''}`
  ).join('\n');

  const sessionBlock = session.length
    ? `\n=== SESSION CONTEXT ===\n${session.map((s, i) => `${i + 1}. "${s.q}" → ${s.r}`).join('\n')}\n`
    : '';

  return `You are a search agent. Decide which URLs to read to answer the query.
Reply ONLY with valid JSON, no text outside the JSON:
{"fetch":["url1","url2"],"reason":"brief reason"}

RULE: You MUST fetch at least 1 URL unless the snippet already contains a complete, definitive answer.
Fetch 1-${maxFetch} URLs. Prefer Wikipedia, official sites, reputable sources. Avoid logins, PDFs, redirects.
${sessionBlock}
Query: ${query}

Results:
${list}`;
}

// Parse Phase 1 response: extract list of URLs to fetch
export function parseFetchDecision(rawContent, allResultUrls = []) {
  if (!rawContent) return { urls: allResultUrls.slice(0, 5), reason: '' };
  try {
    const json = rawContent.match(/\{[\s\S]*\}/)?.[0];
    if (!json) throw new Error('no JSON');
    const parsed = JSON.parse(json);
    const urls = (parsed.fetch || [])
      .filter((u) => typeof u === 'string' && /^https?:\/\//.test(u))
      .slice(0, 20);
    return { urls, reason: String(parsed.reason || '').slice(0, 200) };
  } catch {
    // Fallback: fetch top 3 results
    return { urls: allResultUrls.slice(0, 3), reason: 'fallback' };
  }
}

// Build Phase 2 prompt: synthesize summary from results + fetched documents
export function buildAgenticSummaryPrompt({ query, lang = 'en-US', results, documents, session = [] }) {
  const langName = LANG_NAMES[lang] || 'English';

  const fetchedSection = documents.length
    ? documents.map((doc, i) =>
        `[F${i + 1}] ${doc.title}\nURL: ${doc.url}\nContent:\n${doc.content.slice(0, 3000)}`
      ).join('\n\n---\n\n')
    : null;

  const snippets = results.slice(0, 8).map((r, i) =>
    `[${i + 1}] ${r.title}\nURL: ${r.url}\nSnippet: ${r.snippet || 'n/a'}`
  ).join('\n\n');

  const sessionItems = Array.isArray(session) && session.length
    ? `=== SEARCH SESSION ===\n${session.slice(-4).map((s, i) => `${i + 1}. "${s.q}" → ${s.r}`).join('\n')}\n\n`
    : '';

  return `You are a search assistant. Answer the query based EXCLUSIVELY on the provided sources.
NEVER use internal knowledge or training data.
IMPORTANT: Web page contents have already been extracted below. Never say "I cannot access websites".
LANGUAGE: Respond in ${langName}.
${getLanguageOutputRule(lang)}

RESPONSE RULES:
- 1-2 sentences: direct answer to the query
- 3-5 bullet points with specific facts, numbers, names from sources
- Cite inline: [F1][F2] for pages read, [1][2] for snippets
- If sources conflict on key facts, note it
- Do not speculate or invent
- If the answer lists specific sites/tools/services, add at the end:
  SITES_AI: https://url1, https://url2, https://url3

${sessionItems}SEARCH QUERY: ${query}

${fetchedSection ? `=== PAGES READ ===\n${fetchedSection}\n\n=== SEARCH RESULTS ===\n${snippets}` : `=== SEARCH RESULTS ===\n${snippets}`}

Answer now based only on these sources.`;
}

// Extract AI-curated site URLs from summary text
export function extractAiSites(summaryText) {
  const match = summaryText.match(/SITES_AI:\s*([^\n]+)/);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\//.test(u))
    .slice(0, 10);
}

// Score results for reordering based on AI citations
export function scoreResultsFromSummary(results, summaryText, fetchedUrls = []) {
  const fetchedSet = new Set(fetchedUrls.map((u) => String(u).toLowerCase()));
  return results.map((r) => {
    const urlLower = String(r.url || '').toLowerCase();
    const isFetched = fetchedSet.has(urlLower);
    const isCited = summaryText.includes(r.url);
    const boost = isFetched ? 2 : isCited ? 1 : 0;
    return { ...r, aiBoost: boost };
  });
}
