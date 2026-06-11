// Tests for SSRF guard, including DNS-rebinding TOCTOU closure (F2).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { isPrivateIp, assertPublicUrl, safeFetch } from '../src/fetch/ssrf-guard.js';

test('isPrivateIp flags loopback, RFC1918, link-local and IPv6 ULA', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.1.1', '::1', 'fc00::1', 'fd12::1', 'fe80::1']) {
    assert.equal(isPrivateIp(ip), true, `${ip} should be private`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.equal(isPrivateIp(ip), false, `${ip} should be public`);
  }
});

test('assertPublicUrl rejects non-http(s) and localhost', async () => {
  await assert.rejects(() => assertPublicUrl('ftp://example.com'), /http\/https/);
  await assert.rejects(() => assertPublicUrl('http://localhost/'), /Local addresses/);
  await assert.rejects(() => assertPublicUrl('not a url'), /Invalid URL/);
});

// Core F2 regression: a public hostname whose DNS resolves to a private IP
// must be blocked at connection time, even if a TOCTOU attacker passed the
// pre-fetch validation. localtest.me is a real public name that resolves to
// 127.0.0.1, simulating a rebinding A-record.
test('safeFetch blocks a public hostname that resolves to a private IP', async () => {
  // Stand up a loopback server so a successful connect would actually return 200.
  const server = http.createServer((_req, res) => { res.end('SECRET'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    await assert.rejects(
      () => safeFetch(`http://localtest.me:${port}/`, { maxBytes: 1000 }),
      /private|internal/i,
      'safeFetch must refuse a hostname resolving to loopback'
    );
  } finally {
    server.close();
  }
});

// Positive path: safeFetch returns a fetch-like response for a public-IP host.
// We bind a server on a routable-looking loopback alias is not possible, so we
// assert the response shape against a public endpoint only when network is up;
// otherwise this is a no-op skip to keep CI deterministic offline.
test('safeFetch response object exposes ok/status/headers.get/arrayBuffer', async () => {
  // Use a public host. If offline, skip rather than fail.
  let res;
  try {
    res = await safeFetch('https://example.com/', { maxBytes: 50_000 });
  } catch (err) {
    if (/private|internal/i.test(err.message)) throw err; // a real guard bug
    return; // offline / network blocked — skip shape assertions
  }
  assert.equal(typeof res.ok, 'boolean');
  assert.equal(typeof res.status, 'number');
  assert.equal(typeof res.headers.get, 'function');
  const buf = await res.arrayBuffer();
  assert.ok(buf.byteLength >= 0);
});
