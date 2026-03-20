// AI query refinement — Phase 0 (parallel with search, optional)

import { call } from './providers/openai-compat.js';

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
  "intent": "one of: definition, how_to, news, research, comparison, navigation, other",
  "also_search": ["optional alternative query 1", "optional alternative query 2"]
}

Rules:
- refined_query: fix typos, expand acronyms, clarify ambiguous terms — keep it concise
- intent: classify what the user is looking for
- also_search: at most 2 useful variant queries, empty array if not applicable
- JSON only, no explanation`;
}

// Returns { refined_query, intent, also_search } or null on failure
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
    return {
      refined_query: String(parsed.refined_query || query).slice(0, 240),
      intent: String(parsed.intent || 'other'),
      also_search: Array.isArray(parsed.also_search) ? parsed.also_search.slice(0, 2).map(String) : [],
    };
  } catch {
    return null;
  }
}
