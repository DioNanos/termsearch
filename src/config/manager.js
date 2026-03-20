import fs from 'fs';
import path from 'path';
import os from 'os';
import { DEFAULTS } from './defaults.js';

// Data directory: $TERMSEARCH_DATA_DIR or ~/.termsearch/
function resolveDataDir() {
  return process.env.TERMSEARCH_DATA_DIR
    ? path.resolve(process.env.TERMSEARCH_DATA_DIR)
    : path.join(os.homedir(), '.termsearch');
}

// Deep-merge: src values override dst, recursively for plain objects
function deepMerge(dst, src) {
  const out = { ...dst };
  for (const [k, v] of Object.entries(src || {})) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && typeof dst[k] === 'object' && dst[k] !== null && !Array.isArray(dst[k])) {
      out[k] = deepMerge(dst[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function isMaskedValue(value) {
  const s = String(value || '').trim();
  return s.includes('*') || s.includes('•');
}

class ConfigManager {
  constructor() {
    this._dataDir = null;
    this._config = null;
  }

  getDataDir() {
    if (!this._dataDir) this._init();
    return this._dataDir;
  }

  getConfig() {
    if (!this._config) this._init();
    return this._config;
  }

  _init() {
    this._dataDir = resolveDataDir();
    // Create data dir and cache subdirs on first run
    try {
      fs.mkdirSync(this._dataDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.join(this._dataDir, 'cache', 'search'), { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.join(this._dataDir, 'cache', 'docs'), { recursive: true, mode: 0o700 });
    } catch { /* ignore */ }

    const configPath = path.join(this._dataDir, 'config.json');
    let userConfig = {};
    if (fs.existsSync(configPath)) {
      try {
        userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        try { fs.chmodSync(configPath, 0o600); } catch { /* ignore */ }
      } catch {
        console.warn('[config] Warning: could not parse config.json, using defaults');
      }
    } else {
      // First run: write defaults
      this._writeFile(configPath, DEFAULTS);
    }

    // Env var overrides (for power users / CI)
    const envOverrides = this._readEnvOverrides();
    this._config = deepMerge(deepMerge(DEFAULTS, userConfig), envOverrides);
  }

  _readEnvOverrides() {
    const overrides = {};
    if (process.env.TERMSEARCH_PORT) overrides.port = Number(process.env.TERMSEARCH_PORT);
    if (process.env.TERMSEARCH_HOST) overrides.host = process.env.TERMSEARCH_HOST;
    if (process.env.TERMSEARCH_AI_API_BASE) {
      overrides.ai = { ...overrides.ai, api_base: process.env.TERMSEARCH_AI_API_BASE, enabled: true };
    }
    if (process.env.TERMSEARCH_AI_API_KEY) {
      overrides.ai = { ...overrides.ai, api_key: process.env.TERMSEARCH_AI_API_KEY };
    }
    if (process.env.TERMSEARCH_AI_MODEL) {
      overrides.ai = { ...overrides.ai, model: process.env.TERMSEARCH_AI_MODEL };
    }
    if (process.env.TERMSEARCH_BRAVE_API_KEY) {
      overrides.brave = { api_key: process.env.TERMSEARCH_BRAVE_API_KEY, enabled: true };
    }
    if (process.env.TERMSEARCH_MOJEEK_API_KEY) {
      overrides.mojeek = { api_key: process.env.TERMSEARCH_MOJEEK_API_KEY, enabled: true };
    }
    if (process.env.TERMSEARCH_SEARXNG_URL) {
      overrides.searxng = { url: process.env.TERMSEARCH_SEARXNG_URL, enabled: true };
    }
    return overrides;
  }

  // Update config in-memory and persist to disk
  update(partial) {
    if (!this._config) this._init();
    const safePartial = JSON.parse(JSON.stringify(partial || {}));
    this._sanitizeSensitiveKeys(safePartial);
    this._config = deepMerge(this._config, safePartial);
    // Auto-enable AI/providers when keys are provided
    if (safePartial?.ai?.api_base && !safePartial?.ai?.hasOwnProperty('enabled')) {
      this._config.ai.enabled = Boolean(this._config.ai.api_base);
    }
    if (safePartial?.brave?.api_key && !safePartial?.brave?.hasOwnProperty('enabled')) {
      this._config.brave.enabled = Boolean(this._config.brave.api_key);
    }
    if (safePartial?.mojeek?.api_key && !safePartial?.mojeek?.hasOwnProperty('enabled')) {
      this._config.mojeek.enabled = Boolean(this._config.mojeek.api_key);
    }
    if (safePartial?.searxng?.url && !safePartial?.searxng?.hasOwnProperty('enabled')) {
      this._config.searxng.enabled = Boolean(this._config.searxng.url);
    }
    this._persist();
  }

  _sanitizeSensitiveKeys(partial) {
    const sections = ['ai', 'brave', 'mojeek'];
    for (const section of sections) {
      const block = partial?.[section];
      if (!block || typeof block !== 'object' || !Object.prototype.hasOwnProperty.call(block, 'api_key')) continue;
      const incoming = block.api_key;
      if (incoming == null) {
        delete block.api_key;
        continue;
      }
      const raw = String(incoming);
      const trimmed = raw.trim();
      if (trimmed === '') {
        block.api_key = '';
        continue;
      }
      // UI placeholders like sk-****1234 must never overwrite the stored secret
      if (isMaskedValue(trimmed)) {
        block.api_key = this._config?.[section]?.api_key || '';
      }
    }
  }

  _persist() {
    const configPath = path.join(this._dataDir, 'config.json');
    // Don't persist env overrides — only persist what the user explicitly set via web UI
    const toSave = this._stripSensitiveForPersist(this._config);
    this._writeFile(configPath, toSave);
  }

  _stripSensitiveForPersist(config) {
    // Persist everything — env overrides will re-apply on next startup
    return JSON.parse(JSON.stringify(config));
  }

  _writeFile(filePath, data) {
    const tmp = filePath + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, filePath);
      fs.chmodSync(filePath, 0o600);
    } catch (e) {
      console.warn('[config] Could not write config file:', e.message);
    }
  }

  // Returns config with API keys masked for public display
  getPublicConfig() {
    const c = this.getConfig();
    return {
      ...c,
      ai: { ...c.ai, api_key: maskKey(c.ai.api_key) },
      brave: { ...c.brave, api_key: maskKey(c.brave.api_key) },
      mojeek: { ...c.mojeek, api_key: maskKey(c.mojeek.api_key) },
    };
  }
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

// Singleton
export const config = new ConfigManager();
export default config;
