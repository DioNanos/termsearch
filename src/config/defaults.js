// Default configuration values for TermSearch
// These are deep-merged with user config on load, so new keys auto-appear on upgrade.

export const DEFAULTS = {
  port: 3000,
  host: '127.0.0.1',

  search: {
    providers: ['duckduckgo', 'wikipedia'],
    timeout_ms: 15000,
    max_query_length: 240,
    result_count: 10,
    fallback_min_results: 5,
    cache_ttl_search_ms: 720_000,   // 12 min
    cache_ttl_doc_ms: 2_700_000,    // 45 min
    cache_l1_max_search: 200,
    cache_l1_max_docs: 150,
    // Disk cache — conservative defaults for Termux/low-end devices
    disk_max_search_entries: 1000,
    disk_max_search_bytes: 50 * 1024 * 1024,   // 50 MB
    disk_max_doc_entries: 1500,
    disk_max_doc_bytes: 100 * 1024 * 1024,     // 100 MB
  },

  ai: {
    enabled: false,
    api_base: '',       // e.g. http://localhost:11434/v1
    api_key: '',        // optional
    model: '',          // e.g. qwen3:1.7b
    max_tokens: 1200,
    timeout_ms: 90_000,
    rate_limit: 20,     // per hour per IP
    rate_window_ms: 3_600_000,
    fetch_soft_cap: 15,
    fetch_hard_cap: 25,
    fetch_max_per_domain: 2,
    fetch_min_per_engine: 3,
  },

  brave: {
    enabled: false,
    api_key: '',
    api_base: 'https://api.search.brave.com/res/v1',
  },

  mojeek: {
    enabled: false,
    api_key: '',
    api_base: 'https://api.mojeek.com',
  },

  searxng: {
    enabled: false,
    url: '',  // e.g. http://localhost:9090
  },

  rate_limit: {
    general_per_min: 45,
    search_per_min: 30,
    window_ms: 60_000,
  },
};
