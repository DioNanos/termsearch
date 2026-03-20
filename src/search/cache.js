// Tiered cache: L1 in-process RAM + L2 disk (persistent across restarts)
// L1: hot-set in RAM, bounded, lost on restart (fast Map with LRU eviction)
// L2: disk JSON files, larger budget, survives restarts
// Read path: L1 hit → return; L2 hit → promote to L1 (remaining TTL) → return
// Write path: write to both L1 and L2 (async disk write, non-blocking)

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// L1: in-process Map with TTL + LRU eviction
export function makeCache(maxSize) {
  const store = new Map();
  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (Date.now() > entry.expires) { store.delete(key); return undefined; }
      return entry.value;
    },
    set(key, value, ttl) {
      if (store.size >= maxSize) store.delete(store.keys().next().value);
      store.set(key, { value, expires: Date.now() + ttl });
    },
  };
}

function _hashKey(key) {
  return crypto.createHash('sha1').update(key).digest('hex');
}

function _diskEvict(dir, maxEntries, maxBytes) {
  fs.readdir(dir, (err, files) => {
    if (err) return;
    const jsonFiles = files.filter((f) => f.endsWith('.json'));
    if (!jsonFiles.length) return;
    const stats = [];
    let pending = jsonFiles.length;
    for (const f of jsonFiles) {
      const fp = path.join(dir, f);
      fs.stat(fp, (statErr, st) => {
        if (!statErr) stats.push({ fp, mtime: st.mtimeMs, size: st.size });
        if (--pending > 0) return;
        stats.sort((a, b) => a.mtime - b.mtime); // oldest first
        let totalBytes = stats.reduce((s, e) => s + e.size, 0);
        const now = Date.now();
        const alive = [];
        for (const s of stats) {
          try {
            const { expires } = JSON.parse(fs.readFileSync(s.fp, 'utf8'));
            if (now > expires) { fs.unlink(s.fp, () => {}); totalBytes -= s.size; }
            else alive.push(s);
          } catch { fs.unlink(s.fp, () => {}); }
        }
        while (alive.length > maxEntries || totalBytes > maxBytes) {
          const oldest = alive.shift();
          if (!oldest) break;
          totalBytes -= oldest.size;
          fs.unlink(oldest.fp, () => {});
        }
      });
    }
  });
}

// L2: disk cache — sync read, async write (non-blocking fire-and-forget)
export function makeDiskCache(dir, maxEntries, maxBytes) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  let evictTimer = null;
  return {
    get(key) {
      const fp = path.join(dir, _hashKey(key) + '.json');
      try {
        const { value, expires } = JSON.parse(fs.readFileSync(fp, 'utf8'));
        if (Date.now() > expires) { fs.unlink(fp, () => {}); return undefined; }
        return { value, remainingTtl: expires - Date.now() };
      } catch { return undefined; }
    },
    set(key, value, ttl) {
      const fp = path.join(dir, _hashKey(key) + '.json');
      fs.writeFile(fp, JSON.stringify({ value, expires: Date.now() + ttl }), (err) => {
        if (err) console.warn('[disk-cache] write error:', err.message);
      });
      if (!evictTimer) {
        evictTimer = setTimeout(() => { evictTimer = null; _diskEvict(dir, maxEntries, maxBytes); }, 15_000);
        evictTimer.unref?.();
      }
    },
  };
}

// Tiered cache: L1 (RAM) + L2 (disk). Same get/set API as makeCache.
export function makeTieredCache(l1Max, diskDir, diskMaxEntries, diskMaxBytes) {
  const l1 = makeCache(l1Max);
  const l2 = makeDiskCache(diskDir, diskMaxEntries, diskMaxBytes);
  const L1_PROMO_CAP = 15 * 60 * 1000;
  return {
    get(key) {
      const v = l1.get(key);
      if (v !== undefined) return v;
      const d = l2.get(key);
      if (d !== undefined) {
        l1.set(key, d.value, Math.min(d.remainingTtl, L1_PROMO_CAP));
        return d.value;
      }
      return undefined;
    },
    set(key, value, ttl) {
      l1.set(key, value, ttl);
      l2.set(key, value, ttl);
    },
  };
}

// Build a cache key for search queries
export function searchCacheKey(query, lang, safe, providerList, tier, category = 'web', page = 1) {
  const sorted = [...providerList].sort().join(',');
  return `${tier}:${lang}:${safe}:${sorted}:${category}:p${page}:${query.toLowerCase().trim()}`;
}
