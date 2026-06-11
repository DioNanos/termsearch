// SSRF protection — validates URLs before fetching, blocks private/internal IPs

import dns from 'dns/promises';
import dnsCb from 'dns';
import net from 'net';
import http from 'http';
import https from 'https';

const PRIVATE_V4_PREFIXES = [
  '10.', '172.16.', '172.17.', '172.18.', '172.19.', '172.20.', '172.21.',
  '172.22.', '172.23.', '172.24.', '172.25.', '172.26.', '172.27.',
  '172.28.', '172.29.', '172.30.', '172.31.',
  '192.168.', '127.', '169.254.', '0.',
];

export function isPrivateIp(ip) {
  if (!ip) return true;
  if (net.isIPv6(ip)) {
    return ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80');
  }
  return PRIVATE_V4_PREFIXES.some((prefix) => ip.startsWith(prefix));
}

export async function assertPublicUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http/https URLs are allowed.');
  }
  const hostname = parsed.hostname;
  if (!hostname || hostname === 'localhost') {
    throw new Error('Local addresses are not allowed.');
  }
  const records = await dns.lookup(hostname, { all: true });
  if (!records.length || records.some((record) => isPrivateIp(record.address))) {
    throw new Error('Private or internal targets are not allowed.');
  }
  return parsed;
}

// DNS lookup wrapper that re-applies isPrivateIp to EVERY resolved address.
// This is the actual lookup used by the connection, so the IP the socket
// connects to is the same IP that was validated — closing the DNS-rebinding
// TOCTOU window where assertPublicUrl resolves a public IP but the later
// fetch re-resolves to a private one.
function guardedLookup(hostname, options, callback) {
  const cb = typeof options === 'function' ? options : callback;
  const opts = typeof options === 'function' ? {} : (options || {});
  dnsCb.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
    if (err) return cb(err);
    const list = Array.isArray(addresses) ? addresses : [addresses];
    const blocked = list.find((a) => isPrivateIp(a.address));
    if (blocked) {
      return cb(new Error(`Blocked private/internal address ${blocked.address} for ${hostname}.`));
    }
    if (opts.all) return cb(null, list);
    const first = list[0];
    return cb(null, first.address, first.family);
  });
}

// Minimal fetch-like helper that pins SSRF validation to the connection's DNS
// lookup and re-validates every redirect hop. Returns a subset of the fetch
// Response API actually used by callers: { ok, status, headers.get, arrayBuffer }.
export async function safeFetch(rawUrl, { headers = {}, signal, maxRedirects = 5, maxBytes } = {}) {
  let current = await assertPublicUrl(rawUrl);

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const transport = current.protocol === 'https:' ? https : http;
    const res = await new Promise((resolve, reject) => {
      const req = transport.request(
        current,
        { method: 'GET', headers, lookup: guardedLookup, signal },
        resolve
      );
      req.on('error', reject);
      req.end();
    });

    const status = res.statusCode || 0;
    const location = res.headers.location;
    if (status >= 300 && status < 400 && location) {
      res.resume(); // drain
      if (hop === maxRedirects) throw new Error('Too many redirects.');
      const next = new URL(location, current);
      current = await assertPublicUrl(next.toString());
      continue;
    }

    const chunks = [];
    let total = 0;
    return await new Promise((resolve, reject) => {
      res.on('data', (chunk) => {
        chunks.push(chunk);
        total += chunk.length;
        if (maxBytes && total >= maxBytes) {
          res.destroy();
        }
      });
      res.on('end', () => resolve(buildResponse(current, status, res.headers, Buffer.concat(chunks))));
      res.on('close', () => resolve(buildResponse(current, status, res.headers, Buffer.concat(chunks))));
      res.on('error', reject);
    });
  }
  throw new Error('Too many redirects.');
}

function buildResponse(url, status, rawHeaders, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: url.toString(),
    headers: {
      get: (name) => {
        const v = rawHeaders[String(name).toLowerCase()];
        return Array.isArray(v) ? v.join(', ') : (v ?? null);
      },
    },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
}
