// TermSearch — Vanilla JS SPA (allineato a MmmSearch)

// ─── State ────────────────────────────────────────────────────────────────
const state = {
  query: '',
  category: 'web',
  results: [],
  aiSummary: '',
  aiStatus: 'idle',
  aiError: null,
  aiMeta: null,
  aiProgress: 0,
  aiSteps: [],
  aiSources: [],
  aiExpanded: false,
  aiStartTime: null,
  aiLatencyMs: null,
  aiSession: [],     // { q, r }[] — ultimi 4 summary (passati all'AI come contesto)
  aiLastQuery: null,
  aiLastResults: null,
  aiLastLang: null,
  profilerData: null,
  profilerLoading: false,
  torrentData: [],
  socialData: [],
  loading: false,
  providers: [],
  config: null,
  historyEnabled: localStorage.getItem('ts-save-history') !== '0',
  selectedEngines: (() => {
    try {
      const raw = JSON.parse(localStorage.getItem('ts-engines') || '[]');
      return Array.isArray(raw) ? raw.slice(0, 20).map((v) => String(v || '').trim().toLowerCase()).filter(Boolean) : [];
    } catch {
      return [];
    }
  })(),
  searchHistory: (() => {
    try {
      const raw = JSON.parse(localStorage.getItem('ts-history') || '[]');
      return Array.isArray(raw) ? raw.slice(0, 50).filter((q) => typeof q === 'string' && q.trim()) : [];
    } catch {
      return [];
    }
  })(),
};

let mobileBarCleanup = null;

function clearMobileBarLayout() {
  if (typeof mobileBarCleanup === 'function') {
    mobileBarCleanup();
  }
  mobileBarCleanup = null;
  document.documentElement.style.setProperty('--mobile-bar-height', '0px');
}

function bindMobileBarLayout(mobileBar) {
  clearMobileBarLayout();
  if (!mobileBar) return;

  const media = window.matchMedia('(max-width: 640px)');
  const root = document.documentElement;
  const update = () => {
    if (!media.matches || !mobileBar.isConnected) {
      root.style.setProperty('--mobile-bar-height', '0px');
      return;
    }
    const h = Math.ceil(mobileBar.getBoundingClientRect().height);
    root.style.setProperty('--mobile-bar-height', `${h}px`);
  };

  const onResize = () => update();
  window.addEventListener('resize', onResize);

  let observer = null;
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(update);
    observer.observe(mobileBar);
  }

  requestAnimationFrame(update);
  mobileBarCleanup = () => {
    window.removeEventListener('resize', onResize);
    if (observer) observer.disconnect();
  };
}

function buildSearchHash(query, category = 'web') {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (category && category !== 'web') params.set('cat', category);
  const raw = params.toString();
  return raw ? `#/?${raw}` : '#/';
}

// ─── Router ───────────────────────────────────────────────────────────────
function route() {
  const hash = location.hash || '#/';
  if (hash.startsWith('#/settings')) return renderSettings();
  const queryIdx = hash.indexOf('?');
  const params = new URLSearchParams(queryIdx >= 0 ? hash.slice(queryIdx + 1) : '');
  const q = params.get('q') || '';
  const cat = (params.get('cat') || 'web').toLowerCase();
  state.category = ['web', 'images', 'news'].includes(cat) ? cat : 'web';
  if (q && (q !== state.query || state.results.length === 0)) {
    state.query = q;
    doSearch(q);
    return;
  }
  if (!q) {
    state.query = '';
  }
  renderApp();
}

function navigate(path) { location.hash = path; }
window.addEventListener('hashchange', route);
window.addEventListener('load', route);

// ─── Helpers ──────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function getLang() { return localStorage.getItem('ts-lang') || 'auto'; }
function setLang(v) { localStorage.setItem('ts-lang', v); }
function getTheme() { return localStorage.getItem('ts-theme') || 'dark'; }
function toggleTheme() {
  const isLight = document.documentElement.classList.toggle('light');
  localStorage.setItem('ts-theme', isLight ? 'light' : 'dark');
}

function setHistoryEnabled(enabled) {
  state.historyEnabled = Boolean(enabled);
  localStorage.setItem('ts-save-history', state.historyEnabled ? '1' : '0');
  if (!state.historyEnabled) {
    state.searchHistory = [];
    localStorage.removeItem('ts-history');
  }
}

function persistHistory() {
  if (!state.historyEnabled) return;
  localStorage.setItem('ts-history', JSON.stringify(state.searchHistory.slice(0, 50)));
}

function addSearchToHistory(query) {
  const q = String(query || '').trim();
  if (!q || !state.historyEnabled) return;
  state.searchHistory = [q, ...state.searchHistory.filter((item) => item !== q)].slice(0, 50);
  persistHistory();
}

const LANG_CANONICAL = new Map([
  ['it', 'it-IT'], ['it-it', 'it-IT'],
  ['en', 'en-US'], ['en-us', 'en-US'],
  ['es', 'es-ES'], ['es-es', 'es-ES'],
  ['fr', 'fr-FR'], ['fr-fr', 'fr-FR'],
  ['de', 'de-DE'], ['de-de', 'de-DE'],
  ['pt', 'pt-PT'], ['pt-pt', 'pt-PT'],
  ['ru', 'ru-RU'], ['ru-ru', 'ru-RU'],
  ['zh', 'zh-CN'], ['zh-cn', 'zh-CN'],
  ['ja', 'ja-JP'], ['ja-jp', 'ja-JP'],
]);

function normalizeLangCode(raw) {
  const key = String(raw || '').trim().toLowerCase();
  return LANG_CANONICAL.get(key) || null;
}

function getResolvedLang() {
  const selected = getLang();
  if (selected && selected !== 'auto') return selected;
  const browser = normalizeLangCode(navigator.language || navigator.languages?.[0] || '');
  return browser || 'en-US';
}

function persistSelectedEngines() {
  localStorage.setItem('ts-engines', JSON.stringify(state.selectedEngines.slice(0, 20)));
}

function setSelectedEngines(engines) {
  state.selectedEngines = [...new Set(
    (Array.isArray(engines) ? engines : [])
      .map((engine) => String(engine || '').trim().toLowerCase())
      .filter(Boolean)
  )].slice(0, 20);
  persistSelectedEngines();
}

function sanitizeHttpUrl(raw) {
  try {
    const url = new URL(String(raw || '').trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString();
  } catch {
    return '';
  }
}

// ─── SVG Icons ────────────────────────────────────────────────────────────
function svg(paths, size = 16, extra = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${paths}</svg>`;
}

const ICONS = {
  search:   svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3m-3.7-8.3-2.1 2.1m-8.4 8.4-2.1 2.1m12.5 0-2.1-2.1M5.7 5.7 3.6 3.6"/>'),
  theme:    svg('<circle cx="12" cy="12" r="5"/><path d="M12 1v2m0 18v2M4.22 4.22l1.42 1.42m12.72 12.72 1.42 1.42M1 12h2m18 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>'),
  back:     svg('<path d="M19 12H5"/><path d="m12 5-7 7 7 7"/>'),
  magnet:   svg('<path d="M6 15A6 6 0 1 0 6 3a6 6 0 0 0 0 12z"/><path d="M6 3v12"/><path d="M18 3a6 6 0 0 1 0 12"/><path d="M18 3v12"/><path d="M6 15h12"/>'),
  profile:  svg('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  torrent:  svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
  social:   svg('<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>'),
  github:   svg('<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.2c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>'),
  spinner:  svg('<path opacity=".25" d="M12 2a10 10 0 1 0 10 10" stroke-width="3"/><path d="M12 2a10 10 0 0 1 10 10" stroke-width="3"/>', 14, 'class="spin"'),
  chevron:  svg('<polyline points="6 9 12 15 18 9"/>'),
  external: svg('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>'),
};

function iconEl(name, cls = '') {
  const span = document.createElement('span');
  span.innerHTML = ICONS[name] || '';
  span.style.display = 'inline-flex';
  span.style.alignItems = 'center';
  if (cls) span.className = cls;
  return span;
}

// ─── DOM helper ───────────────────────────────────────────────────────────
function el(tag, props, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'className') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v);
  }
  for (const child of children.flat()) {
    if (child == null) continue;
    e.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return e;
}

// ─── Language picker ──────────────────────────────────────────────────────
const LANGS = [
  { code: 'auto',  label: '🌐 Auto' },
  { code: 'it-IT', label: '🇮🇹 IT' },
  { code: 'en-US', label: '🇺🇸 EN' },
  { code: 'es-ES', label: '🇪🇸 ES' },
  { code: 'fr-FR', label: '🇫🇷 FR' },
  { code: 'de-DE', label: '🇩🇪 DE' },
  { code: 'pt-PT', label: '🇵🇹 PT' },
  { code: 'ru-RU', label: '🇷🇺 RU' },
  { code: 'zh-CN', label: '🇨🇳 ZH' },
  { code: 'ja-JP', label: '🇯🇵 JA' },
];

const AI_PRESETS = [
  { id: 'ollama',   label: 'LocalHost — Ollama',       api_base: 'http://127.0.0.1:11434/v1', keyRequired: false, defaultModel: 'qwen3.5:4b' },
  { id: 'lmstudio', label: 'LocalHost — LM Studio',    api_base: 'http://127.0.0.1:1234/v1',  keyRequired: false, defaultModel: '' },
  { id: 'llamacpp', label: 'LocalHost — llama.cpp',    api_base: 'http://127.0.0.1:8080/v1',  keyRequired: false, defaultModel: '' },
  { id: 'chutes',   label: 'Chutes.ai TEE',            api_base: 'https://llm.chutes.ai/v1',  keyRequired: true,  defaultModel: 'deepseek-ai/DeepSeek-V3.2-TEE' },
  { id: 'anthropic',label: 'Anthropic',                api_base: 'https://api.anthropic.com/v1', keyRequired: true, defaultModel: 'claude-3-5-haiku-latest' },
  { id: 'openai',   label: 'OpenAI',                   api_base: 'https://api.openai.com/v1', keyRequired: true,  defaultModel: 'gpt-4o-mini' },
  { id: 'openrouter', label: 'OpenRoute/OpenRouter',   api_base: 'https://openrouter.ai/api/v1', keyRequired: true, defaultModel: 'openai/gpt-4o-mini' },
];

const ENGINE_GROUPS = [
  { label: 'Web Core', items: ['duckduckgo', 'wikipedia', 'brave', 'startpage', 'qwant', 'mojeek', 'bing', 'google', 'yahoo'] },
  { label: 'Uncensored', items: ['yandex', 'marginalia', 'ahmia'] },
  { label: 'Code & Dev', items: ['github', 'github-api', 'hackernews', 'reddit'] },
  { label: 'Media', items: ['youtube', 'sepiasearch'] },
  { label: 'Research', items: ['wikidata', 'crossref', 'openalex', 'openlibrary'] },
  { label: 'Federated', items: ['mastodon users', 'mastodon hashtags', 'tootfinder', 'lemmy communities', 'lemmy posts'] },
  { label: 'Torrent', items: ['piratebay', '1337x', 'nyaa'] },
];

const ENGINE_PRESETS = [
  { id: 'all', label: 'All', engines: [] },
  { id: 'balanced', label: 'Balanced', engines: ['duckduckgo', 'wikipedia', 'bing', 'startpage', 'github', 'reddit', 'youtube'] },
  { id: 'github', label: 'GitHub Focus', engines: ['github-api', 'github', 'duckduckgo', 'wikipedia'] },
];

function detectPresetFromBase(base) {
  const raw = String(base || '').toLowerCase();
  if (!raw) return 'custom';
  const preset = AI_PRESETS.find((p) => raw.startsWith(String(p.api_base).toLowerCase()));
  return preset ? preset.id : 'custom';
}

function LangPicker() {
  const wrap = el('div', { className: 'lang-wrap' });
  const sel  = el('select', { className: 'lang-select' });
  for (const l of LANGS) {
    const opt = el('option', { value: l.code }, l.label);
    if (l.code === getLang()) opt.selected = true;
    sel.append(opt);
  }
  sel.addEventListener('change', () => {
    setLang(sel.value);
    if (state.query) {
      doSearch(state.query, state.category);
    } else {
      renderApp();
    }
  });
  const arrow = el('span', { className: 'lang-arrow', html: svg('<polyline points="6 9 12 15 18 9"/>', 12) });
  wrap.append(sel, arrow);
  return wrap;
}

function EnginePicker() {
  const details = el('details', { className: 'engine-picker' });
  const selectedCount = state.selectedEngines.length;
  const summary = el('summary', { className: 'engine-picker-summary' },
    el('span', { className: 'engine-picker-title' }, selectedCount ? `Engines (${selectedCount})` : 'Engines (all)'),
    iconEl('chevron', 'engine-chevron'),
  );

  const body = el('div', { className: 'engine-picker-body' });
  const presetRow = el('div', { className: 'engine-preset-row' });
  ENGINE_PRESETS.forEach((preset) => {
    presetRow.append(el('button', {
      className: `btn ${preset.id === 'balanced' ? 'btn-primary' : ''}`,
      type: 'button',
      onClick: () => {
        setSelectedEngines(preset.engines);
        details.open = false;
        if (state.query) doSearch(state.query, state.category);
        else renderApp();
      },
    }, preset.label));
  });
  body.append(presetRow);

  ENGINE_GROUPS.forEach((group) => {
    const card = el('div', { className: 'engine-group' });
    card.append(el('div', { className: 'engine-group-title' }, group.label));
    const list = el('div', { className: 'engine-chip-wrap' });
    group.items.forEach((engine) => {
      const checked = state.selectedEngines.includes(engine);
      const id = `engine-${engine.replace(/[^a-z0-9]+/g, '-')}-${Math.random().toString(36).slice(2, 6)}`;
      const input = el('input', { id, type: 'checkbox', ...(checked ? { checked: '' } : {}) });
      const label = el('label', { className: 'engine-chip', for: id }, input, el('span', {}, engine));
      list.append(label);
    });
    card.append(list);
    body.append(card);
  });

  body.append(el('div', { className: 'engine-actions' },
    el('button', {
      className: 'btn btn-primary',
      type: 'button',
      onClick: () => {
        const selected = [...details.querySelectorAll('.engine-chip input:checked')]
          .map((node) => node.parentElement?.textContent?.trim().toLowerCase())
          .filter(Boolean);
        setSelectedEngines(selected);
        details.open = false;
        if (state.query) doSearch(state.query, state.category);
        else renderApp();
      },
    }, 'Apply'),
    el('button', {
      className: 'btn',
      type: 'button',
      onClick: () => {
        setSelectedEngines([]);
        details.open = false;
        if (state.query) doSearch(state.query, state.category);
        else renderApp();
      },
    }, 'Reset'),
  ));

  details.append(summary, body);
  return details;
}

// ─── Search form ──────────────────────────────────────────────────────────
function SearchForm(value, onSearch) {
  const form  = el('form', { className: 'search-form' });
  const sicon = el('span', { className: 'search-icon', html: ICONS.search });
  const listId = `search-history-list-${Math.random().toString(36).slice(2, 8)}`;
  const input = el('input', {
    className: 'search-input', type: 'search',
    placeholder: 'Search...', value: value || '',
    autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false',
    ...(state.historyEnabled ? { list: listId } : {}),
  });
  const btn = el('button', { className: 'search-btn', type: 'submit', html: ICONS.search });
  form.append(sicon, input, btn);
  if (state.historyEnabled && state.searchHistory.length) {
    const dl = el('datalist', { id: listId });
    state.searchHistory.slice(0, 12).forEach((q) => dl.append(el('option', { value: q })));
    form.append(dl);
  }
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    navigate(buildSearchHash(q, state.category));
    onSearch(q, state.category);
  });
  return form;
}

// ─── Favicon helper ───────────────────────────────────────────────────────
function Favicon(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return el('span', { className: 'result-favicon result-favicon-fallback' }, host.slice(0, 1).toUpperCase());
  } catch {
    return el('span', { className: 'result-favicon result-favicon-fallback' }, '?');
  }
}

// ─── Result item ──────────────────────────────────────────────────────────
function ResultItem(r, idx = 0) {
  let host = '', displayUrl = r.url || '';
  try {
    const u = new URL(r.url);
    host = u.hostname.replace(/^www\./, '');
    displayUrl = u.hostname + u.pathname.replace(/\/$/, '');
  } catch { host = r.url; }

  const item = el('div', { className: 'result-item anim-fade-up', style: `animation-delay:${idx * 50}ms` });

  // Source row: favicon + host
  const source = el('div', { className: 'result-source' });
  source.append(Favicon(r.url), el('span', { className: 'result-host' }, host));

  // Badges
  const titleRow = el('div', { style: 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:2px' });
  const titleLink = el('a', { className: 'result-title', href: r.url, target: '_blank', rel: 'noopener noreferrer' }, r.title || r.url);
  titleRow.append(titleLink);

  // Type badge
  const type = r.type || r.engine || '';
  if (type.includes('torrent') || r.magnetLink) {
    const b = el('span', { className: 'result-badge badge-torrent' }, 'torrent');
    titleRow.append(b);
  } else if (type.includes('video') || /youtube|vimeo/.test(r.url || '')) {
    titleRow.append(el('span', { className: 'result-badge badge-video' }, 'video'));
  } else if (/github\.com/.test(r.url || '')) {
    titleRow.append(el('span', { className: 'result-badge badge-github' }, 'github'));
  } else if (/reddit\.com/.test(r.url || '')) {
    titleRow.append(el('span', { className: 'result-badge badge-reddit' }, 'reddit'));
  }

  const urlLine = el('div', { className: 'result-url' }, displayUrl);
  const snippet = r.snippet ? el('div', { className: 'result-snippet' }, r.snippet) : null;

  // Actions
  const actions = el('div', { className: 'result-actions' });
  actions.append(el('span', { className: 'result-engine' }, r.engine || ''));

  if (r.magnetLink) {
    const magBtn = el('a', { className: 'magnet-btn', href: r.magnetLink, title: 'Open magnet' });
    magBtn.innerHTML = ICONS.magnet + ' Magnet';
    actions.append(magBtn);
  }

  item.append(source, titleRow, urlLine);
  if (snippet) item.append(snippet);
  item.append(actions);
  return item;
}

// ─── AI Panel ─────────────────────────────────────────────────────────────
function renderAiPanel() {
  const panel = document.getElementById('ai-panel');
  if (!panel) return;
  const isActive = ['loading', 'streaming', 'done', 'error'].includes(state.aiStatus);
  if (!isActive) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';

  const isLoading = state.aiStatus === 'loading' || state.aiStatus === 'streaming';
  const isDone    = state.aiStatus === 'done';
  const isError   = state.aiStatus === 'error';
  const dotsClass = isDone ? 'done' : isError ? 'error' : '';

  // Row 1: dots + "AI" (always) + model + latency
  const dotsEl = el('div', { className: 'ai-dots' });
  ['violet', 'indigo', 'dim'].forEach(c => {
    dotsEl.append(el('div', { className: `ai-dot ${dotsClass || c}` }));
  });
  const latMs = state.aiLatencyMs;
  const latLabel = latMs != null ? (latMs < 1000 ? `${latMs}ms` : `${(latMs / 1000).toFixed(1)}s`) : null;
  const row1 = el('div', { className: 'panel-header-left' },
    dotsEl,
    el('span', { className: 'panel-label' }, 'AI'),
    state.aiMeta?.model ? el('span', { className: 'ai-model-label' }, state.aiMeta.model) : null,
    latLabel ? el('span', { className: 'ai-latency-label' }, `· ${latLabel}`) : null,
  );

  // Row 2: status text (violet) + step/fetch meta
  const statusText = isError ? 'Error'
    : isDone ? 'Done'
    : state.aiStatus === 'loading' ? 'Thinking…' : 'Generating…';
  const statusColor = isError ? '#f87171' : isDone ? '#a78bfa' : '#a78bfa';
  const lastStep = state.aiSteps.length > 0 ? state.aiSteps[state.aiSteps.length - 1] : null;
  const metaText = isDone && state.aiMeta?.fetchedCount ? `· ${state.aiMeta.fetchedCount} pages read`
    : isLoading && lastStep ? `· ${lastStep}` : '';
  const row2 = el('div', { className: 'ai-status-row' },
    el('span', { className: 'ai-status-text', style: `color:${statusColor}` }, statusText),
    metaText ? el('span', { className: 'ai-status-meta' }, metaText) : null,
  );

  const chevronPath = state.aiExpanded ? '<polyline points="18 15 12 9 6 15"/>' : '<polyline points="6 9 12 15 18 9"/>';
  const expandBtn = el('button', { className: 'ai-expand-btn', type: 'button', title: state.aiExpanded ? 'Collapse' : 'Expand' });
  expandBtn.innerHTML = svg(chevronPath, 14);
  expandBtn.onclick = () => { state.aiExpanded = !state.aiExpanded; renderAiPanel(); };

  const headerInner = el('div', { className: 'ai-header-inner' }, row1, row2);
  const header = el('div', { className: 'panel-header' }, headerInner, expandBtn);

  // Progress bar
  const showProgress = isLoading && state.aiProgress > 0;
  const progressEl = showProgress ? el('div', { className: 'ai-progress-wrap' },
    el('div', { className: 'ai-progress-bar', style: `width:${state.aiProgress}%` }),
  ) : null;

  // Steps
  const showSteps = isLoading && state.aiSteps.length > 0;
  const stepsEl = showSteps ? el('div', { className: 'ai-steps' },
    ...state.aiSteps.slice(-4).map(s => el('div', { className: 'ai-step' }, s)),
  ) : null;

  // Content
  const contentEl = el('div', { className: `ai-content${!state.aiExpanded && !isLoading ? ' ai-content-collapsed' : ''}` });
  if (isError) {
    contentEl.style.color = '#f87171';
    contentEl.textContent = state.aiError;
  } else {
    contentEl.textContent = state.aiSummary;
  }

  // Sources (shown when expanded + done)
  const showSources = isDone && state.aiExpanded && state.aiSources.length > 0;
  const sourcesEl = showSources ? el('div', { className: 'ai-sources' },
    ...state.aiSources.slice(0, 8).map((src, i) => {
      const safeSrc = sanitizeHttpUrl(src);
      if (!safeSrc) return null;
      let label = src;
      try {
        const { hostname, pathname } = new URL(safeSrc);
        const host = hostname.replace(/^www\./, '');
        const segs = pathname.replace(/\/$/, '').split('/').filter(Boolean).slice(0, 2);
        label = segs.length ? `${host} › ${segs.join('/')}` : host;
      } catch {}
      const a = el('a', { className: 'ai-source-pill', href: safeSrc, target: '_blank', rel: 'noopener noreferrer' }, `[${i + 1}] ${label}`);
      return a;
    }),
  ) : null;

  // Session memory (shown when expanded + more than 1 entry, all except current)
  const prevSession = state.aiSession.slice(0, -1);
  const sessionEl = (state.aiExpanded && prevSession.length > 0) ? el('div', { className: 'ai-session' },
    el('p', { className: 'ai-session-label' }, 'Session'),
    ...prevSession.map((item, i) =>
      el('div', { className: 'ai-session-item' },
        el('span', { className: 'ai-session-num' }, `${i + 1}.`),
        el('span', { className: 'ai-session-q' }, item.q),
        el('span', { className: 'ai-session-r' }, `→ ${item.r}`),
      )
    ),
  ) : null;

  // Footer: retry + expand/collapse
  const retryBtn = el('button', { className: 'ai-retry-btn', type: 'button' }, 'Retry');
  retryBtn.onclick = () => {
    if (state.aiLastQuery) startAiSummary(state.aiLastQuery, state.aiLastResults || [], state.aiLastLang || 'en-US');
  };
  const toggleBtn = el('button', { className: 'ai-toggle-btn', type: 'button' },
    state.aiExpanded ? 'Show less' : 'Show more',
  );
  toggleBtn.onclick = () => { state.aiExpanded = !state.aiExpanded; renderAiPanel(); };
  const footer = el('div', { className: 'ai-footer' }, retryBtn, toggleBtn);

  panel.innerHTML = '';
  panel.append(header);
  if (progressEl) panel.append(progressEl);
  if (stepsEl)    panel.append(stepsEl);
  panel.append(contentEl);
  if (sourcesEl)  panel.append(sourcesEl);
  if (sessionEl)  panel.append(sessionEl);
  panel.append(footer);

  if (state.aiStatus === 'streaming' && state.aiSummary.length < 60) {
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// ─── Profiler Panel ───────────────────────────────────────────────────────
function ProfilerPanel(data) {
  if (!data) return null;
  const { target, profile, similar } = data;

  const platformClass = {
    github: 'plat-github', bluesky: 'plat-bluesky', reddit: 'plat-reddit',
    twitter: 'plat-twitter', instagram: 'plat-instagram', linkedin: 'plat-linkedin',
    youtube: 'plat-youtube', facebook: 'plat-facebook', telegram: 'plat-telegram', tiktok: 'plat-tiktok',
  };

  const panel = el('div', { className: 'panel panel-profiler anim-fade-in' });

  // Header
  panel.append(el('div', { className: 'panel-header' },
    el('div', { className: 'panel-header-left' },
      iconEl('profile'),
      el('span', { className: 'panel-label' }, 'Profile Scan'),
      target?.platform ? el('span', { className: `${platformClass[target.platform] || ''} `, style: 'font-size:11px;margin-left:4px' }, target.platform) : null,
    ),
  ));

  if (!profile) {
    if (state.profilerLoading) {
      panel.append(el('div', { className: 'loader' },
        el('span', { html: ICONS.spinner }),
        'Scanning…',
      ));
    } else {
      panel.append(el('div', { style: 'font-size:13px;color:var(--text3)' }, 'No profile data found.'));
    }
    return panel;
  }

  // Profile card
  const card = el('div', { className: 'profile-card' });
  if (profile.avatar) {
    const av = el('img', { className: 'profile-avatar', src: profile.avatar, alt: profile.name || '' });
    av.onerror = () => { av.style.display = 'none'; };
    card.append(av);
  }
  const info = el('div', { style: 'flex:1;min-width:0' });
  const nameEl = profile.url
    ? el('a', { className: 'profile-name', href: profile.url, target: '_blank', rel: 'noopener' }, profile.name || profile.handle || '')
    : el('div', { className: 'profile-name' }, profile.name || profile.handle || '');
  info.append(nameEl);
  if (profile.handle) info.append(el('div', { className: 'profile-handle' }, '@' + profile.handle));
  if (profile.bio)    info.append(el('div', { className: 'profile-bio' }, profile.bio));

  // Extra metadata
  const extras = [profile.location, profile.company].filter(Boolean);
  if (extras.length) {
    info.append(el('div', { style: 'font-size:10px;color:var(--text3);margin-top:4px' }, extras.join(' · ')));
  }
  card.append(info);
  panel.append(card);

  // Stats
  const statsFields = [
    { key: 'followers',  label: 'Followers' },
    { key: 'following',  label: 'Following' },
    { key: 'repos',      label: 'Repos' },
    { key: 'karma',      label: 'Karma' },
    { key: 'posts',      label: 'Posts' },
    { key: 'subscribers',label: 'Subscribers' },
    { key: 'likes',      label: 'Likes' },
  ];
  const statsData = statsFields.filter(f => profile[f.key] != null);
  if (statsData.length) {
    const statsRow = el('div', { className: 'profile-stats' });
    statsData.forEach(f => {
      statsRow.append(el('div', { className: 'stat' },
        el('div', { className: 'stat-val' }, String(profile[f.key])),
        el('div', { className: 'stat-key' }, f.label),
      ));
    });
    panel.append(statsRow);
  }

  // Top repos (GitHub)
  if (profile.topRepos?.length) {
    panel.append(el('div', { className: 'section-title' }, 'Top Repositories'));
    profile.topRepos.slice(0, 5).forEach(r => {
      const repoEl = el('a', { className: 'repo-item', href: r.url || '#', target: '_blank', rel: 'noopener' });
      repoEl.append(
        el('span', { className: 'repo-name' }, r.name),
        r.lang  ? el('span', { className: 'repo-lang' },  r.lang) : null,
        r.stars != null ? el('span', { className: 'repo-stars' }, '★ ' + r.stars) : null,
        r.forks != null ? el('span', { className: 'repo-forks' }, '⑂ ' + r.forks) : null,
      );
      panel.append(repoEl);
    });
  }

  // Similar profiles
  if (similar?.length) {
    panel.append(el('div', { className: 'section-title' }, 'Similar Profiles'));
    const grid = el('div', { className: 'similar-grid' });
    similar.slice(0, 8).forEach(s => {
      const item = el('div', { className: 'similar-item', onClick: () => {
        const q = s.url || s.handle;
        if (q) navigate(`#/?q=${encodeURIComponent(q)}`);
      }});
      if (s.avatar) {
        const av = el('img', { className: 'similar-avatar', src: s.avatar, alt: s.handle || '' });
        av.onerror = () => av.remove();
        item.append(av);
      }
      item.append(el('span', { className: 'similar-handle' }, '@' + (s.handle || '')));
      grid.append(item);
    });
    panel.append(grid);
  }

  return panel;
}

// ─── Torrent Panel ────────────────────────────────────────────────────────
function TorrentPanel(results) {
  if (!results?.length) return null;
  const panel = el('div', { className: 'panel panel-torrent anim-fade-in' });

  panel.append(el('div', { className: 'panel-header' },
    el('div', { className: 'panel-header-left' },
      iconEl('torrent'),
      el('span', { className: 'panel-label' }, 'Best Magnets'),
      el('span', { style: 'font-size:10px;color:var(--text3);margin-left:4px' }, results.length + ' results'),
    ),
  ));

  results.slice(0, 6).forEach((r, i) => {
    const item = el('div', { className: 'torrent-item' });
    const rank = el('span', { className: 'torrent-rank' }, '#' + (i + 1));
    const info = el('div', { className: 'torrent-info' });
    info.append(el('div', { className: 'torrent-title' }, r.title || 'Unknown'));
    const meta = el('div', { className: 'torrent-meta' });
    if (r.seed != null) meta.append(el('span', {}, r.seed + ' seed'));
    if (r.filesize)     meta.append(el('span', {}, r.filesize));
    if (r.engine)       meta.append(el('span', { style: 'color:var(--text3)' }, r.engine));
    info.append(meta);

    const actions = el('div', { style: 'display:flex;gap:4px;flex-shrink:0' });
    if (r.magnetLink) {
      const magBtn = el('a', { className: 'magnet-btn', href: r.magnetLink, title: 'Magnet link' });
      magBtn.innerHTML = ICONS.magnet;
      actions.append(magBtn);
    }
    item.append(rank, info, actions);
    panel.append(item);
  });

  return panel;
}

// ─── Social Panel ─────────────────────────────────────────────────────────
function SocialPanel(results) {
  if (!results?.length) return null;
  const panel = el('div', { className: 'panel panel-social anim-fade-in' });

  const engines = [...new Set(results.map(r => r._socialEngine || r.engine).filter(Boolean))];
  panel.append(el('div', { className: 'panel-header' },
    el('div', { className: 'panel-header-left' },
      iconEl('social'),
      el('span', { className: 'panel-label' }, 'Social & News'),
      engines.length ? el('span', { style: 'font-size:10px;color:var(--text3);margin-left:4px' }, engines.join(' · ')) : null,
    ),
  ));

  const inner = el('div', {});
  results.forEach((r, i) => inner.append(ResultItem(r, i)));
  panel.append(inner);
  return panel;
}

// ─── Search logic ─────────────────────────────────────────────────────────
function isProfileQuery(q) {
  return /^https?:\/\/(github|twitter|x|instagram|bluesky|reddit|linkedin|youtube|tiktok|telegram|facebook)/.test(q)
    || /^@[a-zA-Z0-9_\.]{2,}$/.test(q)
    || /github\.com\/.+|bsky\.app\/.+|reddit\.com\/u\//.test(q);
}

function flattenSocialResults(payload) {
  if (!payload) return [];
  const nested = payload.results && !Array.isArray(payload.results) ? payload.results : {};
  const flat = Array.isArray(payload.results) ? payload.results : [];
  return [
    ...flat,
    ...(nested.bluesky_posts || []).map((item) => ({
      title: item.title || item.text || '',
      url: item.url || '',
      snippet: item.snippet || item.author || '',
      _socialEngine: 'bluesky',
    })),
    ...(nested.bluesky_actors || []).map((item) => ({
      title: item.title || item.displayName || item.handle || '',
      url: item.url || '',
      snippet: item.snippet || item.description || '',
      _socialEngine: 'bluesky users',
    })),
    ...(nested.gdelt || []).map((item) => ({
      title: item.title || '',
      url: item.url || '',
      snippet: item.snippet || item.domain || '',
      _socialEngine: 'gdelt',
    })),
  ].filter((item) => item.url);
}

async function runSearchProgressive(q, lang, category, engines = []) {
  const params = new URLSearchParams({ q, lang, cat: category });
  if (Array.isArray(engines) && engines.length > 0) {
    params.set('engines', engines.join(','));
  }
  const response = await fetch(`/api/search-stream?${params.toString()}`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    const fallback = await response.json();
    return { results: fallback.results || [], providers: fallback.providers || [] };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullResults = null;
  let providers = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      let chunk;
      try {
        chunk = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      if (chunk.error) throw new Error(chunk.message || chunk.error);
      if (chunk.batch === 'fast') {
        state.results = chunk.results || [];
        state.providers = chunk.providers || state.providers;
        state.loading = false;
        renderApp();
      } else if (chunk.batch === 'full') {
        fullResults = chunk.allResults || chunk.results || [];
        providers = chunk.providers || providers;
        state.results = fullResults;
        state.providers = providers;
        state.loading = false;
        renderApp();
      } else if (chunk.providers && Array.isArray(chunk.providers)) {
        providers = chunk.providers;
      }
    }
  }

  return {
    results: fullResults || state.results || [],
    providers: providers.length ? providers : state.providers || [],
  };
}

async function doSearch(q, category = state.category) {
  if (!q.trim()) return;
  addSearchToHistory(q);
  state.category = ['web', 'images', 'news'].includes(category) ? category : 'web';
  state.loading = true;
  state.results = [];
  state.aiSummary = '';
  state.aiStatus = 'idle';
  state.aiError = null;
  state.aiMeta = null;
  state.profilerData = null;
  state.profilerLoading = isProfileQuery(q);
  state.torrentData = [];
  state.socialData = [];
  renderApp();

  const lang = getResolvedLang();
  const engines = state.selectedEngines.slice();

  try {
    const searchPromise = runSearchProgressive(q, lang, state.category, engines).catch(async () => {
      const p = new URLSearchParams({ q, lang, cat: state.category });
      if (engines.length > 0) p.set('engines', engines.join(','));
      return api(`/api/search?${p.toString()}`);
    });
    const promises = [
      searchPromise,
      api(`/api/social-search?q=${encodeURIComponent(q)}`).catch(() => null),
    ];

    if (state.profilerLoading) {
      promises.push(
        api(`/api/profiler?q=${encodeURIComponent(q)}`).catch(() => null)
      );
    } else {
      promises.push(Promise.resolve(null));
    }

    const [searchRes, socialRes, profilerRes] = await Promise.all(promises);

    state.loading = false;
    state.results = searchRes?.results || state.results || [];
    state.providers = searchRes?.providers || state.providers || [];

    // Social results
    state.socialData = flattenSocialResults(socialRes);

    // Profiler
    state.profilerData = profilerRes;
    state.profilerLoading = false;

    // Torrent results (from main search or extracted by engine)
    state.torrentData = state.results.filter(r => r.magnetLink || r.engine?.includes('torrent') || r.engine?.includes('piratebay') || r.engine?.includes('1337x'));

    renderApp();

    // AI summary
    if (state.config?.ai?.enabled && state.config?.ai?.api_base && state.config?.ai?.model) {
      startAiSummary(q, state.results, lang);
    }
  } catch (e) {
    state.loading = false;
    state.profilerLoading = false;
    state.results = [];
    renderApp();
  }
}

async function startAiSummary(query, results, lang) {
  state.aiStatus = 'loading';
  state.aiSummary = '';
  state.aiError = null;
  state.aiProgress = 0;
  state.aiSteps = [];
  state.aiSources = [];
  state.aiStartTime = Date.now();
  state.aiLatencyMs = null;
  state.aiLastQuery = query;
  state.aiLastResults = results;
  state.aiLastLang = lang;
  renderAiPanel();

  try {
    const r = await fetch('/api/ai-summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, lang, results: results.slice(0, 10), stream: true, session: state.aiSession }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    state.aiStatus = 'streaming';
    renderAiPanel();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const d = JSON.parse(line.slice(6));
          if (d.chunk !== undefined)    { state.aiSummary += d.chunk; renderAiPanel(); }
          else if (d.progress !== undefined) { state.aiProgress = d.progress; renderAiPanel(); }
          else if (d.step)              { state.aiSteps = [...state.aiSteps.slice(-3), d.step]; renderAiPanel(); }
          else if (d.error)             { state.aiStatus = 'error'; state.aiError = d.message || d.error; renderAiPanel(); }
          else if (d.model != null || d.sites != null) {
            state.aiStatus = 'done';
            state.aiProgress = 100;
            state.aiSources = Array.isArray(d.sites) ? d.sites.map(sanitizeHttpUrl).filter(Boolean) : [];
            state.aiMeta = { fetchedCount: d.fetchedCount, model: d.model };
            state.aiLatencyMs = Date.now() - state.aiStartTime;
            // Save to session memory (max 4 entries, skip if already saved for this query)
            const lastEntry = state.aiSession[state.aiSession.length - 1];
            if (state.aiSummary && (!lastEntry || lastEntry.q !== query)) {
              const r = state.aiSummary.split(/[.!?\n]/)[0].slice(0, 100);
              state.aiSession = [...state.aiSession.slice(-3), { q: query, r }];
            }
            renderAiPanel();
          }
        } catch { /* ignore */ }
      }
    }
    if (state.aiStatus === 'streaming') { state.aiStatus = 'done'; state.aiLatencyMs = Date.now() - state.aiStartTime; renderAiPanel(); }
  } catch (e) {
    state.aiStatus = 'error';
    state.aiError = e.message;
    renderAiPanel();
  }
}

// ─── Main render ──────────────────────────────────────────────────────────
function renderApp() {
  const app = document.getElementById('app');
  if (!app) return;
  app.innerHTML = '';

  if (!state.query) {
    clearMobileBarLayout();
    renderHome(app);
    return;
  }

  // Results page
  const header = el('div', { className: 'header hide-mobile' },
    el('div', { className: 'logo-text', onClick: () => { state.query = ''; state.category = 'web'; navigate('#/'); renderApp(); } },
      'Term', el('strong', {}, 'Search'),
    ),
    el('div', { className: 'header-search' }, SearchForm(state.query, (q, cat) => { state.query = q; doSearch(q, cat); })),
    el('div', { className: 'header-nav' },
      LangPicker(),
      el('button', { className: 'btn-icon', title: 'Settings',     onClick: () => navigate('#/settings') }, iconEl('settings')),
      el('button', { className: 'btn-icon', title: 'Toggle theme', onClick: toggleTheme }, iconEl('theme')),
    ),
  );

  const categoryBar = el('div', { className: 'category-tabs hide-mobile' });
  const categories = [
    { id: 'web', label: 'Web' },
    { id: 'images', label: 'Images' },
    { id: 'news', label: 'News' },
  ];
  const buildCatTabs = (container) => {
    categories.forEach((cat) => {
      container.append(el('button', {
        className: `cat-tab ${state.category === cat.id ? 'active' : ''}`,
        onClick: () => {
          if (state.category === cat.id) return;
          state.category = cat.id;
          navigate(buildSearchHash(state.query, state.category));
          if (state.query) doSearch(state.query, state.category);
        },
        type: 'button',
      }, cat.label));
    });
  };
  buildCatTabs(categoryBar);
  categoryBar.append(EnginePicker());

  const mobileTabs = el('div', { className: 'mobile-bar-tabs' });
  buildCatTabs(mobileTabs);
  const mobileBar = el('div', { className: 'mobile-bar' },
    el('div', { className: 'mobile-bar-search' }, SearchForm(state.query, (q, cat) => { state.query = q; doSearch(q, cat); })),
    mobileTabs,
    el('div', { className: 'mobile-bar-engine' }, EnginePicker()),
    el('div', { className: 'mobile-bar-row' },
      el('div', {
        className: 'mobile-logo',
        onClick: () => { state.query = ''; state.category = 'web'; navigate('#/'); renderApp(); },
      }, 'Term', el('strong', {}, 'Search')),
      LangPicker(),
      el('button', { className: 'btn-icon', title: 'Settings',     onClick: () => navigate('#/settings') }, iconEl('settings')),
      el('button', { className: 'btn-icon', title: 'Toggle theme', onClick: toggleTheme }, iconEl('theme')),
    ),
  );

  const main = el('div', { className: 'main' });

  // AI panel placeholder
  const aiPanel = el('div', { id: 'ai-panel', className: 'panel panel-ai', style: 'display:none' });
  main.append(aiPanel);

  if (state.loading) {
    main.append(el('div', { className: 'loader' },
      el('span', { html: ICONS.spinner }),
      el('span', {}, 'Searching '),
      el('span', { style: 'color:var(--text2)' }, state.query),
    ));
  } else {
    // Results meta
    if (state.results.length > 0) {
      const meta = el('div', { className: 'results-meta' });
      meta.append(document.createTextNode(`${state.results.length} results`));
      if (state.providers.length) meta.append(document.createTextNode(' · ' + state.providers.join(', ')));
      if (state.selectedEngines.length) meta.append(document.createTextNode(' · engines: ' + state.selectedEngines.join(', ')));
      main.append(meta);
    }

    // 1. Profiler
    const profPanel = ProfilerPanel(state.profilerData || (state.profilerLoading ? { target: null, profile: null } : null));
    if (profPanel) main.append(profPanel);

    // 2. Torrent panel (only if there are magnets)
    const torPanel = TorrentPanel(state.torrentData);
    if (torPanel) main.append(torPanel);

    // 3. Web results (excluding torrents)
    const webResults = state.results.filter(r => !r.magnetLink && !r.engine?.includes('piratebay') && !r.engine?.includes('1337x'));
    if (webResults.length === 0 && state.results.length === 0) {
      main.append(el('div', { className: 'no-results' }, 'No results found.'));
    } else {
      webResults.forEach((r, i) => main.append(ResultItem(r, i)));
    }

    // 4. Social panel
    const socPanel = SocialPanel(state.socialData);
    if (socPanel) main.append(socPanel);
  }

  app.append(header, categoryBar, main, mobileBar);
  bindMobileBarLayout(mobileBar);
  renderAiPanel();
}

// ─── Homepage ─────────────────────────────────────────────────────────────
function renderHome(app) {
  const home = el('div', { className: 'home' },
    el('div', { className: 'home-logo' }, 'Term', el('strong', {}, 'Search')),
    el('div', { className: 'home-tagline' },
      el('span', { className: 'tagline-desktop' }, 'Personal search engine · privacy-first · local-first'),
      el('span', { className: 'tagline-mobile' }, 'Private local search'),
    ),
    el('div', { className: 'home-search' }, SearchForm('', (q) => { state.query = q; state.category = 'web'; doSearch(q, 'web'); })),
    el('div', { className: 'home-actions' },
      LangPicker(),
      el('button', { className: 'btn', onClick: () => navigate('#/settings') }, iconEl('settings'), ' Settings'),
      el('button', { className: 'btn', onClick: toggleTheme }, iconEl('theme'), ' Theme'),
    ),
  );

  const footer = el('div', { className: 'footer' },
    el('span', { className: 'footer-link' }, '© 2026 DioNanos'),
    el('a', { className: 'footer-link', href: 'https://github.com/DioNanos/termsearch', target: '_blank', rel: 'noopener' },
      iconEl('github'), 'GitHub',
    ),
  );

  app.append(home, footer);
}

// ─── Settings ─────────────────────────────────────────────────────────────
async function renderSettings() {
  const app = document.getElementById('app');
  if (!app) return;
  app.innerHTML = '';
  clearMobileBarLayout();

  let cfg = state.config;
  if (!cfg) {
    try { cfg = state.config = await api('/api/config'); } catch { cfg = {}; }
  }
  let health = null, autostart = null;
  await Promise.all([
    api('/api/health').then(h => { health = h; }).catch(() => {}),
    api('/api/autostart').then(a => { autostart = a; }).catch(() => {}),
  ]);

  const ai     = cfg.ai     || {};
  const brave  = cfg.brave  || {};
  const mojeek = cfg.mojeek || {};
  const searxng = cfg.searxng || {};
  const detectedPreset = detectPresetFromBase(ai.api_base);

  const header = el('div', { className: 'header' },
    el('button', { className: 'btn', onClick: () => history.back() }, iconEl('back'), ' Back'),
    el('div', { className: 'logo-text' }, 'Settings'),
    el('button', { className: 'btn-icon', onClick: toggleTheme }, iconEl('theme')),
  );

  function makeInput(id, value, placeholder = '', type = 'text') {
    return el('input', { className: 'form-input', id, type, value: value || '', placeholder });
  }
  function val(id) { return document.getElementById(id)?.value?.trim() || ''; }
  function isChecked(id) { return document.getElementById(id)?.checked || false; }

  function showAlert(alertEl, msg, type) {
    alertEl.className = `alert alert-${type}`;
    alertEl.textContent = msg;
    alertEl.style.display = 'block';
    setTimeout(() => { alertEl.style.display = 'none'; }, 4000);
  }

  const saveAlertEl = el('div', { style: 'display:none' });
  const aiModelStatus = el('div', { id: 'ai-model-status', style: 'display:none' });
  const historyInfoEl = el('div', { id: 'history-preview', className: 'form-hint', style: 'margin-top:8px' });
  const presetSelect = el('select', { className: 'form-input', id: 'ai-preset' });
  presetSelect.append(el('option', { value: 'custom' }, 'Custom'));
  AI_PRESETS.forEach((preset) => {
    const opt = el('option', { value: preset.id }, preset.label);
    if (preset.id === detectedPreset) opt.selected = true;
    presetSelect.append(opt);
  });
  const modelInput = makeInput('ai-model', ai.model, 'qwen3.5:4b');
  const modelSelect = el('select', { className: 'form-input', id: 'ai-model-select' },
    el('option', { value: '' }, 'Load models first…')
  );
  const modelQuickList = el('div', { id: 'ai-model-quick-list', className: 'model-quick-list' },
    el('div', { className: 'form-hint' }, 'No models loaded.')
  );
  let loadedModels = [];

  function setModelStatus(message, type = 'info') {
    aiModelStatus.style.display = 'block';
    aiModelStatus.className = `alert alert-${type}`;
    aiModelStatus.textContent = message;
  }

  function renderHistoryPreview() {
    if (!state.historyEnabled) {
      historyInfoEl.textContent = 'Search history disabled.';
      return;
    }
    if (!state.searchHistory.length) {
      historyInfoEl.textContent = 'No searches saved yet.';
      return;
    }
    historyInfoEl.textContent = `Recent: ${state.searchHistory.slice(0, 8).join(' · ')}`;
  }

  function populateModelList(models) {
    loadedModels = models.slice();
    modelSelect.innerHTML = '';
    for (const model of models) {
      modelSelect.append(el('option', { value: model }, model));
    }
    modelQuickList.innerHTML = '';
    models.forEach((model) => {
      modelQuickList.append(el('button', {
        className: 'model-chip-btn',
        type: 'button',
        onClick: () => {
          const modelField = document.getElementById('ai-model');
          if (modelField) modelField.value = model;
          modelSelect.value = model;
          [...modelQuickList.querySelectorAll('.model-chip-btn')].forEach((n) => n.classList.remove('active'));
          const active = [...modelQuickList.querySelectorAll('.model-chip-btn')].find((n) => n.textContent === model);
          if (active) active.classList.add('active');
        },
      }, model));
    });
    const current = val('ai-model');
    if (current && models.includes(current)) {
      modelSelect.value = current;
      const active = [...modelQuickList.querySelectorAll('.model-chip-btn')].find((n) => n.textContent === current);
      if (active) active.classList.add('active');
    }
  }

  async function loadModels(trigger = 'manual') {
    const base = val('ai-base');
    const key = val('ai-key');
    const presetId = val('ai-preset');
    if (!base) {
      setModelStatus('Set API endpoint first.', 'info');
      return;
    }
    const preset = AI_PRESETS.find((p) => p.id === presetId);
    if (preset?.keyRequired && !key) {
      setModelStatus(`Insert API key for ${preset.label} to load models.`, 'info');
      return;
    }

    const btn = document.getElementById('ai-load-models-btn');
    if (btn) btn.disabled = true;
    setModelStatus('Loading models…', 'info');
    try {
      const res = await api('/api/config/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_base: base, api_key: key, preset: presetId }),
      });
      const models = Array.isArray(res.models) ? res.models : [];
      if (!models.length) {
        setModelStatus(`No models found${res.provider ? ` for ${res.provider}` : ''}.`, 'err');
        modelSelect.innerHTML = '';
        modelSelect.append(el('option', { value: '' }, 'No models found'));
        modelQuickList.innerHTML = '';
        modelQuickList.append(el('div', { className: 'form-hint' }, 'No models loaded.'));
        loadedModels = [];
        return;
      }
      populateModelList(models);
      const current = val('ai-model');
      if (!current || !models.includes(current)) {
        const modelField = document.getElementById('ai-model');
        if (modelField) modelField.value = models[0];
        modelSelect.value = models[0];
      }
      setModelStatus(`Loaded ${models.length} model(s)${res.provider ? ` from ${res.provider}` : ''}.`, 'ok');
    } catch (e) {
      setModelStatus(`Model load failed: ${e.message}`, 'err');
    } finally {
      if (btn) btn.disabled = false;
      if (trigger === 'manual') {
        setTimeout(() => { aiModelStatus.style.display = 'none'; }, 4500);
      }
    }
  }

  function applyPreset() {
    const presetId = val('ai-preset');
    const preset = AI_PRESETS.find((p) => p.id === presetId);
    const hintEl = document.getElementById('ai-preset-hint');
    if (!preset) {
      if (hintEl) hintEl.textContent = 'Custom endpoint mode.';
      return;
    }
    const baseField = document.getElementById('ai-base');
    const modelField = document.getElementById('ai-model');
    if (baseField) baseField.value = preset.api_base;
    if (modelField && (!modelField.value || modelField.value === ai.model) && preset.defaultModel) {
      modelField.value = preset.defaultModel;
    }
    if (hintEl) {
      hintEl.textContent = preset.keyRequired
        ? `Preset ready: insert API key for ${preset.label}, then load models.`
        : `Preset ready: local endpoint (${preset.label}).`;
    }
    if (!preset.keyRequired || val('ai-key')) {
      loadModels('preset');
    }
  }

  async function saveSettings() {
    const aiKey = val('ai-key');
    const braveKey = val('brave-key');
    const mojeekKey = val('mojeek-key');
    setHistoryEnabled(isChecked('history-enabled'));
    renderHistoryPreview();
    const update = {
      ai: {
        api_base: val('ai-base'),
        model:    val('ai-model'),
        enabled:  Boolean(val('ai-base') && val('ai-model')),
      },
      brave:  { enabled: isChecked('brave-enabled') },
      mojeek: { enabled: isChecked('mojeek-enabled') },
      searxng:{ url: val('searxng-url'),                       enabled: isChecked('searxng-enabled') },
    };
    if (aiKey) update.ai.api_key = aiKey;
    if (braveKey) update.brave.api_key = braveKey;
    if (mojeekKey) update.mojeek.api_key = mojeekKey;
    try {
      const res = await api('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(update),
      });
      state.config = cfg = res.config;
      showAlert(saveAlertEl, 'Saved', 'ok');
    } catch (e) {
      showAlert(saveAlertEl, 'Save failed: ' + e.message, 'err');
    }
  }

  async function testAi() {
    const payload = {
      api_base: val('ai-base') || ai.api_base || '',
      model:    val('ai-model') || ai.model || '',
    };
    const key = val('ai-key');
    if (key) payload.api_key = key;
    const btn = document.getElementById('ai-test-btn');
    if (btn) btn.disabled = true;
    const alertEl = document.getElementById('ai-test-result');
    if (alertEl) showAlert(alertEl, 'Testing…', 'info');
    try {
      const res = await api('/api/config/test-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (alertEl) showAlert(alertEl, res.ok ? `OK — ${res.model}: "${res.response}"` : `Failed: ${res.error}`, res.ok ? 'ok' : 'err');
    } catch (e) {
      if (alertEl) showAlert(alertEl, 'Test failed: ' + e.message, 'err');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function testProvider(name) {
    const alertEl = document.getElementById(`provider-test-${name}`);
    if (!alertEl) return;
    showAlert(alertEl, 'Testing…', 'info');
    try {
      const res = await api(`/api/config/test-provider/${name}`);
      showAlert(alertEl, res.ok ? `OK — ${res.count} results` : `Failed: ${res.error || 'no results'}`, res.ok ? 'ok' : 'err');
    } catch (e) {
      showAlert(alertEl, 'Test failed: ' + e.message, 'err');
    }
  }

  function renderProvidersRow() {
    const div = el('div', { style: 'margin-bottom:12px;display:flex;flex-wrap:wrap;gap:6px' });
    for (const p of health?.providers || []) {
      div.append(el('span', { className: 'provider-badge active' }, p));
    }
    return div;
  }

  // Autostart section
  const autostartAlertEl = el('div', { style: 'display:none' });
  let autostartEnabled = autostart?.enabled ?? false;
  const platLabel = { termux: 'Termux:Boot', linux: 'systemd --user', macos: 'launchd', unsupported: 'Not supported' };
  const platName = platLabel[autostart?.platform] || autostart?.method || 'Unknown';

  function statusDot(on) {
    return el('span', { className: `status-dot ${on ? 'on' : 'off'}` });
  }

  const autostartStatusEl = el('div', { className: 'info-val', id: 'autostart-status-val', style: 'display:flex;align-items:center;gap:6px' },
    statusDot(autostartEnabled),
    autostartEnabled ? 'Enabled' : 'Disabled',
  );

  async function toggleAutostart() {
    const newVal = !autostartEnabled;
    const btn = document.getElementById('autostart-toggle-btn');
    if (btn) btn.disabled = true;
    try {
      const res = await api('/api/autostart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: newVal }),
      });
      autostartEnabled = res.enabled;
      const sv = document.getElementById('autostart-status-val');
      if (sv) { sv.innerHTML = ''; sv.append(statusDot(autostartEnabled), autostartEnabled ? 'Enabled' : 'Disabled'); }
      if (btn) {
        btn.textContent = autostartEnabled ? 'Disable' : 'Enable';
        btn.className = autostartEnabled ? 'btn btn-primary' : 'btn';
      }
      showAlert(autostartAlertEl, autostartEnabled ? 'Autostart enabled' : 'Autostart disabled', autostartEnabled ? 'ok' : 'info');
    } catch (e) {
      showAlert(autostartAlertEl, 'Failed: ' + e.message, 'err');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  const autostartToggleBtn = el('button', {
    id: 'autostart-toggle-btn',
    className: autostartEnabled ? 'btn btn-primary' : 'btn',
    onClick: toggleAutostart,
    ...(autostart?.available === false ? { disabled: '' } : {}),
  }, autostartEnabled ? 'Disable' : 'Enable');

  const main = el('div', { className: 'main' },
    el('div', { style: 'margin-bottom:20px' },
      el('h1', { style: 'font-size:20px;font-weight:700' }, 'Settings'),
    ),

    // AI
    el('div', { className: 'settings-section' },
      el('h2', {}, 'AI Configuration (optional)'),
      el('div', { className: 'alert alert-info', style: 'margin-bottom:12px;font-size:11px' },
        'Preset ready: just set key (if required), load models, save.'
      ),
      el('div', { className: 'form-group' },
        el('label', { className: 'form-label', for: 'ai-preset' }, 'Preset'),
        presetSelect,
        el('div', { className: 'form-row', style: 'margin-top:6px' },
          el('button', { id: 'ai-preset-apply-btn', className: 'btn', onClick: applyPreset, type: 'button' }, 'Apply preset'),
          el('span', { id: 'ai-preset-hint', className: 'form-hint', style: 'margin-top:0' }, 'Select a preset to prefill endpoint/model.'),
        ),
      ),
      el('div', { className: 'form-group' },
        el('label', { className: 'form-label', for: 'ai-base' }, 'API Endpoint'),
        makeInput('ai-base', ai.api_base, 'http://localhost:11434/v1'),
        el('div', { className: 'form-hint' },
          'Included presets: LocalHost (Ollama · LM Studio · llama.cpp) · Chutes.ai TEE · Anthropic · OpenAI · OpenRoute/OpenRouter',
          el('br', {}),
          'You can also keep custom OpenAI-compatible endpoints.',
        ),
      ),
      el('div', { className: 'form-group' },
        el('label', { className: 'form-label', for: 'ai-key' }, 'API Key'),
        makeInput('ai-key', '', ai.api_key ? '••••••••' : '', 'password'),
        el('div', { className: 'form-hint' }, 'Not required for local models (Ollama, LM Studio)'),
      ),
      el('div', { className: 'form-group' },
        el('label', { className: 'form-label', for: 'ai-model' }, 'Model'),
        modelInput,
        el('div', { className: 'form-hint', style: 'margin-top:4px' }, 'Model list (tap to open):'),
        modelSelect,
        modelQuickList,
        el('div', { className: 'form-row', style: 'margin-top:6px' },
          el('button', { id: 'ai-load-models-btn', className: 'btn', onClick: () => loadModels('manual'), type: 'button' }, 'Load models'),
          el('span', { className: 'form-hint', style: 'margin-top:0' }, 'Auto-loads from endpoint with current key.'),
        ),
        aiModelStatus,
      ),
      el('div', { className: 'form-row', style: 'margin-top:4px' },
        el('button', { id: 'ai-test-btn', className: 'btn btn-primary', onClick: testAi }, 'Test Connection'),
        el('button', { className: 'btn btn-primary', onClick: saveSettings }, 'Save'),
      ),
      el('div', { id: 'ai-test-result', style: 'display:none' }),
    ),

    // Search history
    el('div', { className: 'settings-section' },
      el('h2', {}, 'Search History'),
      el('div', { className: 'toggle-row' },
        el('span', { className: 'toggle-label' }, 'Save search history'),
        el('label', { className: 'toggle' },
          el('input', { type: 'checkbox', id: 'history-enabled', ...(state.historyEnabled ? { checked: '' } : {}) }),
          el('span', { className: 'toggle-slider' }),
        ),
      ),
      historyInfoEl,
      el('div', { style: 'margin-top:10px;display:flex;gap:8px;align-items:center' },
        el('button', {
          className: 'btn',
          type: 'button',
          onClick: () => {
            state.searchHistory = [];
            localStorage.removeItem('ts-history');
            renderHistoryPreview();
          },
        }, 'Clear history'),
        el('button', { className: 'btn btn-primary', onClick: saveSettings, type: 'button' }, 'Save preference'),
      ),
    ),

    // Providers
    el('div', { className: 'settings-section' },
      el('h2', {}, 'Search Providers'),
      renderProvidersRow(),

      // Brave
      el('div', { style: 'padding:10px 0;border-bottom:1px solid var(--border2)' },
        el('div', { className: 'toggle-row' },
          el('span', { className: 'toggle-label' }, 'Brave Search API'),
          el('label', { className: 'toggle' },
            el('input', { type: 'checkbox', id: 'brave-enabled', ...(brave.enabled ? { checked: '' } : {}) }),
            el('span', { className: 'toggle-slider' }),
          ),
        ),
        el('div', { className: 'form-row' },
          makeInput('brave-key', '', brave.api_key ? '••••••••' : 'API key'),
          el('button', { className: 'btn', onClick: () => testProvider('brave') }, 'Test'),
        ),
        el('div', { id: 'provider-test-brave', style: 'display:none' }),
        el('div', { className: 'form-hint', style: 'margin-top:3px' }, 'Free tier: 2000 req/month · search.brave.com/goodies'),
      ),

      // Mojeek
      el('div', { style: 'padding:10px 0;border-bottom:1px solid var(--border2)' },
        el('div', { className: 'toggle-row' },
          el('span', { className: 'toggle-label' }, 'Mojeek API'),
          el('label', { className: 'toggle' },
            el('input', { type: 'checkbox', id: 'mojeek-enabled', ...(mojeek.enabled ? { checked: '' } : {}) }),
            el('span', { className: 'toggle-slider' }),
          ),
        ),
        el('div', { className: 'form-row' },
          makeInput('mojeek-key', '', mojeek.api_key ? '••••••••' : 'API key'),
          el('button', { className: 'btn', onClick: () => testProvider('mojeek') }, 'Test'),
        ),
        el('div', { id: 'provider-test-mojeek', style: 'display:none' }),
      ),

      // SearXNG
      el('div', { style: 'padding:10px 0' },
        el('div', { className: 'toggle-row' },
          el('span', { className: 'toggle-label' }, 'SearXNG (self-hosted)'),
          el('label', { className: 'toggle' },
            el('input', { type: 'checkbox', id: 'searxng-enabled', ...(searxng.enabled ? { checked: '' } : {}) }),
            el('span', { className: 'toggle-slider' }),
          ),
        ),
        el('div', { className: 'form-row' },
          makeInput('searxng-url', searxng.url, 'http://localhost:9090'),
          el('button', { className: 'btn', onClick: () => testProvider('searxng') }, 'Test'),
        ),
        el('div', { id: 'provider-test-searxng', style: 'display:none' }),
      ),

      el('div', { style: 'margin-top:12px;display:flex;align-items:center;gap:8px' },
        el('button', { className: 'btn btn-primary', onClick: saveSettings }, 'Save All'),
        saveAlertEl,
      ),
    ),

    // Server info
    el('div', { className: 'settings-section' },
      el('h2', {}, 'Server Info'),
      el('div', { className: 'info-row' }, el('span', { className: 'info-key' }, 'Version'),          el('span', { className: 'info-val' }, health?.version || '0.3.3')),
      el('div', { className: 'info-row' }, el('span', { className: 'info-key' }, 'Active providers'), el('span', { className: 'info-val' }, (health?.providers || []).join(', ') || 'none')),
      el('div', { className: 'info-row' }, el('span', { className: 'info-key' }, 'AI'),               el('span', { className: 'info-val' }, health?.ai_enabled ? `enabled (${health.ai_model})` : 'not configured')),
      el('div', { className: 'info-row' }, el('span', { className: 'info-key' }, 'GitHub'),           el('a', { href: 'https://github.com/DioNanos/termsearch', target: '_blank', className: 'info-val', style: 'color:var(--link)' }, 'DioNanos/termsearch')),
    ),

    // Autostart
    el('div', { className: 'settings-section' },
      el('h2', {}, 'Autostart at Boot'),
      el('div', { className: 'alert alert-info', style: 'margin-bottom:12px;font-size:11px' },
        autostart?.available === false
          ? (autostart?.note || 'Autostart not available on this platform')
          : `Boot using ${platName}.`,
      ),
      el('div', { className: 'info-row' }, el('span', { className: 'info-key' }, 'Platform'), el('span', { className: 'info-val' }, platName)),
      el('div', { className: 'info-row' }, el('span', { className: 'info-key' }, 'Status'), autostartStatusEl),
      autostart?.config_path ? el('div', { className: 'info-row' },
        el('span', { className: 'info-key' }, 'Config'),
        el('span', { className: 'info-val', style: 'font-size:10px;word-break:break-all;max-width:240px' }, autostart.config_path),
      ) : null,
      el('div', { style: 'margin-top:12px;display:flex;align-items:center;gap:8px' },
        autostartToggleBtn, autostartAlertEl,
      ),
    ),
  );

  app.append(header, main);
  renderHistoryPreview();
  document.getElementById('history-enabled')?.addEventListener('change', (e) => {
    setHistoryEnabled(Boolean(e.target?.checked));
    renderHistoryPreview();
  });
  modelSelect.addEventListener('change', () => {
    if (!modelSelect.value) return;
    const modelField = document.getElementById('ai-model');
    if (modelField) modelField.value = modelSelect.value;
    [...modelQuickList.querySelectorAll('.model-chip-btn')].forEach((n) => {
      n.classList.toggle('active', n.textContent === modelSelect.value);
    });
  });
  modelSelect.addEventListener('focus', () => {
    if (!loadedModels.length) loadModels('auto');
  });
  modelInput.addEventListener('input', () => {
    const current = modelInput.value || '';
    if ([...modelSelect.options].some((opt) => opt.value === current)) {
      modelSelect.value = modelInput.value;
    }
    [...modelQuickList.querySelectorAll('.model-chip-btn')].forEach((n) => {
      n.classList.toggle('active', n.textContent === current);
      n.style.display = !current || n.textContent.toLowerCase().includes(current.toLowerCase()) ? 'inline-flex' : 'none';
    });
  });
  document.getElementById('ai-key')?.addEventListener('change', () => loadModels('auto'));
  document.getElementById('ai-base')?.addEventListener('change', () => loadModels('auto'));
  presetSelect.addEventListener('change', applyPreset);
  if (detectedPreset && detectedPreset !== 'custom') {
    const hintEl = document.getElementById('ai-preset-hint');
    const preset = AI_PRESETS.find((p) => p.id === detectedPreset);
    if (hintEl && preset) {
      hintEl.textContent = preset.keyRequired
        ? `Preset detected: ${preset.label}. Insert key and load models.`
        : `Preset detected: ${preset.label}.`;
    }
  }
  if (ai.api_base && (!AI_PRESETS.find((p) => p.id === detectedPreset)?.keyRequired)) {
    loadModels('auto');
  }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────
(async () => {
  if (getTheme() === 'light') document.documentElement.classList.add('light');
  try { state.config = await api('/api/config'); } catch { /* non-fatal */ }
  route();
})();
