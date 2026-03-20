// GitHub Search API provider — optional fallback when SearXNG is unavailable.
// Works without token (rate-limited by GitHub); token can be set with TERMSEARCH_GITHUB_TOKEN.

const GITHUB_API = 'https://api.github.com';

function buildHeaders(config = {}) {
  const token = process.env.TERMSEARCH_GITHUB_TOKEN || config?.github?.api_key || '';
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'TermSearch/1.0',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function fetchJson(url, { headers, timeoutMs = 12000 }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: ac.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`github_http_${response.status}:${body.slice(0, 140)}`);
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

function mapRepo(item) {
  const stars = Number(item?.stargazers_count || 0);
  const forks = Number(item?.forks_count || 0);
  const lang = String(item?.language || '').trim();
  const desc = String(item?.description || '').trim();
  const metaParts = [];
  if (lang) metaParts.push(lang);
  metaParts.push(`★ ${stars}`);
  metaParts.push(`forks ${forks}`);
  const meta = metaParts.join(' · ');
  return {
    title: item?.full_name || item?.name || 'GitHub repository',
    url: item?.html_url || '',
    snippet: desc ? `${desc}${meta ? ` — ${meta}` : ''}` : meta,
    engine: 'github-api',
    score: 1.0 + Math.min(stars / 10000, 1.0),
    publishedDate: item?.updated_at || item?.pushed_at || null,
  };
}

function mapUser(item) {
  return {
    title: item?.login ? `@${item.login} · GitHub` : 'GitHub user',
    url: item?.html_url || '',
    snippet: item?.type ? `${item.type} profile on GitHub` : 'GitHub profile',
    engine: 'github-api',
    score: 0.8,
    publishedDate: null,
  };
}

export async function search({ query, page = 1, config, timeoutMs = 12000 }) {
  const q = String(query || '').trim();
  if (!q) return [];

  const headers = buildHeaders(config);
  const pageNo = Math.max(1, Number(page) || 1);
  const repoParams = new URLSearchParams({
    q,
    per_page: '8',
    page: String(pageNo),
    sort: 'stars',
    order: 'desc',
  });
  const usersParams = new URLSearchParams({
    q,
    per_page: '4',
    page: String(pageNo),
    sort: 'followers',
    order: 'desc',
  });

  const [reposData, usersData] = await Promise.all([
    fetchJson(`${GITHUB_API}/search/repositories?${repoParams.toString()}`, { headers, timeoutMs }),
    fetchJson(`${GITHUB_API}/search/users?${usersParams.toString()}`, { headers, timeoutMs }),
  ]);

  const repos = Array.isArray(reposData?.items) ? reposData.items.map(mapRepo).filter((r) => r.url) : [];
  const users = Array.isArray(usersData?.items) ? usersData.items.map(mapUser).filter((u) => u.url) : [];
  return [...repos, ...users];
}
