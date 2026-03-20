// Express middleware: security headers, rate limiting, IP utilities

export function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'microphone=(), geolocation=(), camera=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

export function sendJson(res, status, payload) {
  applySecurityHeaders(res);
  res.status(status).json(payload);
}

export function normalizeIp(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'unknown';
  return raw.replace(/^::ffff:/, '') || 'unknown';
}

export function isLoopbackIp(value) {
  const ip = normalizeIp(value);
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

export function getClientIp(req) {
  const remoteIp = normalizeIp(req.socket?.remoteAddress || req.ip || '');
  if (isLoopbackIp(remoteIp)) {
    const realIp = req.headers['x-real-ip'];
    if (typeof realIp === 'string' && realIp.trim()) return normalizeIp(realIp);
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
      return normalizeIp(forwarded.split(',')[0].trim());
    }
  }
  return remoteIp;
}

// Rate limiting: sliding window per IP
export function checkWindowRateLimit(store, ip, windowMs, limit) {
  const key = normalizeIp(ip);
  const now = Date.now();
  const bucket = store.get(key) || [];
  const recent = bucket.filter((ts) => now - ts < windowMs);
  if (recent.length >= limit) { store.set(key, recent); return false; }
  recent.push(now);
  store.set(key, recent);
  return true;
}

export function sendRateLimited(res, { windowMs, message = 'Too many requests' }) {
  res.setHeader('Retry-After', String(Math.max(1, Math.ceil(windowMs / 1000))));
  return sendJson(res, 429, { error: 'rate_limited', message });
}

// Middleware factory that creates rate limit stores and checkers
export function createRateLimiters(cfg) {
  const generalStore = new Map();
  const searchStore = new Map();
  const aiStore = new Map();

  // Prune expired entries every 5 minutes
  const pruneInterval = setInterval(() => {
    const now = Date.now();
    for (const store of [generalStore, searchStore, aiStore]) {
      for (const [key, bucket] of store) {
        const fresh = bucket.filter((ts) => now - ts < 3_600_000);
        if (fresh.length === 0) store.delete(key);
        else store.set(key, fresh);
      }
    }
  }, 5 * 60 * 1000);
  pruneInterval.unref?.();

  const rl = cfg.rate_limit;
  const aiCfg = cfg.ai;

  return {
    checkGeneral: (ip) => checkWindowRateLimit(generalStore, ip, rl.window_ms, rl.general_per_min),
    checkSearch: (ip) => checkWindowRateLimit(searchStore, ip, rl.window_ms, rl.search_per_min),
    checkAi: (ip) => checkWindowRateLimit(aiStore, ip, aiCfg.rate_window_ms, aiCfg.rate_limit),
    windowMs: rl.window_ms,
    aiWindowMs: aiCfg.rate_window_ms,
  };
}

// Express middleware: attach client IP to req
export function ipMiddleware(req, _res, next) {
  req.clientIp = getClientIp(req);
  next();
}
