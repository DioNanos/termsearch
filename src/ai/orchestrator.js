// AI orchestrator — coordinates the 2-phase agentic summary flow

import { call, stream, classifyAiError } from './providers/openai-compat.js';
import { buildFetchDecisionPrompt, parseFetchDecision, buildAgenticSummaryPrompt, extractAiSites, scoreResultsFromSummary } from './summary.js';
import { batchFetch } from '../fetch/document.js';

function mapAiErrorCode(error) { return classifyAiError(error); }
function mapAiErrorMessage(error) {
  switch (classifyAiError(error)) {
    case 'ai_provider_auth': return 'AI provider authentication failed. Check your API key in Settings.';
    case 'ai_rate_limited_provider': return 'AI provider rate limited. Try again shortly.';
    case 'ai_timeout_provider': return 'AI provider timed out. Try again shortly.';
    case 'ai_provider_unavailable': case 'ai_provider_unreachable': return 'AI provider temporarily unavailable.';
    default: return 'AI unavailable. Check endpoint in Settings.';
  }
}
function mapAiErrorStatus(error) {
  switch (classifyAiError(error)) {
    case 'ai_rate_limited_provider': return 429;
    case 'ai_timeout_provider': return 504;
    case 'ai_provider_auth': return 503;
    default: return 502;
  }
}

// Refine a query using AI (non-streaming, quick call)
// Returns { content, model } or throws
export async function aiQueryRefine(prompt, aiConfig) {
  return call(prompt, {
    apiBase: aiConfig.api_base,
    apiKey: aiConfig.api_key,
    model: aiConfig.model,
    maxTokens: 200,
    timeoutMs: 5000,
    jsonMode: true,
  });
}

// Generate AI summary with optional streaming
// If onToken is provided, streams tokens as they arrive
// Returns { summary, sites, fetchedCount, fetchedUrls, model, error? }
export async function generateSummary({
  query,
  lang = 'en-US',
  results = [],
  session = [],
  onToken = null,
  onProgress = null,
  onStep = null,
  docCache = null,
}, aiConfig) {
  const emit = (progress, step) => {
    if (onProgress) onProgress(progress);
    if (step && onStep) onStep(step);
  };
  if (!aiConfig?.enabled || !aiConfig?.api_base || !aiConfig?.model) {
    return { error: 'ai_not_configured', message: 'AI not configured. Add endpoint in Settings.' };
  }

  const ai = {
    apiBase: aiConfig.api_base,
    apiKey: aiConfig.api_key,
    model: aiConfig.model,
    maxTokens: aiConfig.max_tokens || 1200,
    timeoutMs: aiConfig.timeout_ms || 90_000,
  };

  try {
    // Phase 1: AI decides which URLs to fetch
    emit(5, 'Analyzing query…');
    const phase1Prompt = buildFetchDecisionPrompt({
      query,
      results,
      maxFetch: aiConfig.fetch_soft_cap || 10,
      session,
    });

    let phase1Result = null;
    try {
      phase1Result = await call(phase1Prompt, {
        ...ai,
        maxTokens: 300,
        timeoutMs: 8000,
        jsonMode: true,
      });
    } catch {
      // Phase 1 failure is non-fatal — fall back to fetching top results
    }

    const allResultUrls = results.slice(0, 10).map((r) => r.url).filter(Boolean);
    const { urls: urlsToFetch } = parseFetchDecision(phase1Result?.content, allResultUrls);

    // Emit step per URL before batch fetch
    emit(15, `Fetching ${urlsToFetch.length || allResultUrls.slice(0, 2).length} source(s)…`);
    urlsToFetch.slice(0, 6).forEach((url) => {
      try {
        const host = new URL(url).hostname.replace(/^www\./, '');
        if (onStep) onStep(`Reading: ${host}`);
      } catch { if (onStep) onStep('Reading source…'); }
    });

    // Fetch the selected URLs
    let documents = [];
    if (urlsToFetch.length > 0) {
      const fetched = await batchFetch(
        urlsToFetch.slice(0, aiConfig.fetch_hard_cap || 15),
        { timeoutMs: 12000, docCache }
      );
      documents = fetched.filter((d) => d.status === 'ok' && d.content);
    }

    // Fallback: if no docs fetched, try top 2 results directly
    if (documents.length === 0 && allResultUrls.length > 0) {
      const fallback = await batchFetch(allResultUrls.slice(0, 2), { timeoutMs: 10000, docCache });
      documents = fallback.filter((d) => d.status === 'ok' && d.content);
    }

    emit(60, `Synthesizing from ${documents.length} page(s)…`);

    // Phase 2: synthesize summary
    const phase2Prompt = buildAgenticSummaryPrompt({ query, lang, results, documents, session });

    let summaryText = '';
    let summaryModel = ai.model;

    if (typeof onToken === 'function') {
      // Streaming mode
      emit(65, 'Generating summary…');
      const streamResult = await stream(phase2Prompt, onToken, {
        ...ai,
        systemPrompt: 'You are a search assistant. Write your answer directly. Do not include reasoning or thinking.',
      });
      summaryText = streamResult.content;
      summaryModel = streamResult.model;
    } else {
      // Non-streaming mode
      const result = await call(phase2Prompt, {
        ...ai,
        systemPrompt: 'You are a search assistant. Write your answer directly. Do not include reasoning or thinking.',
      });
      summaryText = result.content;
      summaryModel = result.model;
    }

    const sites = extractAiSites(summaryText);
    const scoredResults = scoreResultsFromSummary(results, summaryText, urlsToFetch);

    return {
      summary: summaryText,
      sites,
      fetchedCount: documents.length,
      fetchedUrls: urlsToFetch,
      scoredResults,
      model: summaryModel,
    };
  } catch (error) {
    return {
      error: mapAiErrorCode(error),
      message: mapAiErrorMessage(error),
      status: mapAiErrorStatus(error),
    };
  }
}

// Test the AI connection with a simple completion
export async function testConnection(aiConfig) {
  if (!aiConfig?.api_base || !aiConfig?.model) {
    return { ok: false, error: 'Missing api_base or model' };
  }
  try {
    const result = await call('Say "OK" and nothing else.', {
      apiBase: aiConfig.api_base,
      apiKey: aiConfig.api_key,
      model: aiConfig.model,
      maxTokens: 10,
      timeoutMs: 10000,
    });
    return { ok: true, model: result.model, response: result.content.slice(0, 50) };
  } catch (error) {
    return { ok: false, error: mapAiErrorMessage(error), code: mapAiErrorCode(error) };
  }
}
