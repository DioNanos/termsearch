// Express middleware: security headers, rate limiting, IP utilities

// Hostnames accepted in the Host / Origin / Referer headers. The server only
// binds to loopback, so any request whose Host is a different name is either a
// DNS-rebinding attempt (a malicious page resolving an attacker domain to
// 127.0.0.1) or a misconfiguration — reject it.
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function hostnameFromHostHeader(hostHeader) {
  const raw = String(hostHeader || '').trim().toLowerCase();
  if (!raw) return { host: '', port: '' };
  if (raw.startsWith('[')) {
    // IPv6 literal, e.g. [::1]:3000
    const end = raw.indexOf(']');
    if (end === -1) return { host: raw, port: '' };
    return { host: raw.slice(0, end + 1), port: raw.slice(end + 2) || '' };
  }
  const idx = raw.lastIndexOf(':');
  if (idx === -1) return { host: raw, port: '' };
  return { host: raw.slice(0, idx), port: raw.slice(idx + 1) };
}

function isLocalHostname(host) {
  return LOCAL_HOSTNAMES.has(String(host || '').trim().toLowerCase());
}

// Anti-DNS-rebinding / anti-drive-by guard for the loopback API server.
// - Host header must name localhost/127.0.0.1/[::1] (+ expected port if set).
// - For state-mutating / resource-consuming requests (anything but GET/HEAD),
//   any present Origin/Referer must also be local (blocks cross-site POSTs from
//   a page in the user's browser).
export function createHostGuard(expectedPort) {
  const wantPort = expectedPort ? String(expectedPort) : '';
  return function hostGuard(req, res, next) {
    const { host, port } = hostnameFromHostHeader(req.headers.host);
    if (!isLocalHostname(host) || (wantPort && port && port !== wantPort)) {
      return sendJson(res, 403, { error: 'forbidden_host', message: 'Invalid Host header.' });
    }

    const method = String(req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const origin = req.headers.origin || req.headers.referer;
      if (origin) {
        try {
          const u = new URL(origin);
          const originHost = u.hostname.toLowerCase();
          const localOk = isLocalHostname(originHost) || isLocalHostname(`[${originHost}]`);
          if (!localOk || (wantPort && u.port && u.port !== wantPort)) {
            return sendJson(res, 403, { error: 'forbidden_origin', message: 'Cross-origin request rejected.' });
          }
        } catch {
          return sendJson(res, 403, { error: 'forbidden_origin', message: 'Invalid Origin header.' });
        }
      }
    }
    next();
  };
}

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
