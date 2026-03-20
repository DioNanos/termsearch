// SSRF protection — validates URLs before fetching, blocks private/internal IPs

import dns from 'dns/promises';
import net from 'net';

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
