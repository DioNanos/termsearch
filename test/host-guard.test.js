// Tests for the local-API host/origin guard (F3) — anti-DNS-rebinding / drive-by.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHostGuard } from '../src/api/middleware.js';

function mockReqRes(method, headers) {
  const req = { method, headers };
  const res = {
    statusCode: 200,
    headers: {},
    _json: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this._json = payload; return this; },
  };
  return { req, res };
}

function run(guard, method, headers) {
  const { req, res } = mockReqRes(method, headers);
  let nextCalled = false;
  guard(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

const guard = createHostGuard(38219);

test('allows loopback Host with expected port', () => {
  for (const h of ['127.0.0.1:38219', 'localhost:38219', '[::1]:38219']) {
    const { nextCalled, res } = run(guard, 'GET', { host: h });
    assert.equal(nextCalled, true, `host ${h} should pass`);
    assert.equal(res.statusCode, 200);
  }
});

test('rejects a foreign Host header (DNS rebinding)', () => {
  const { nextCalled, res } = run(guard, 'GET', { host: 'evil.attacker.com' });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res._json.error, 'forbidden_host');
});

test('rejects a loopback Host on the wrong port', () => {
  const { nextCalled, res } = run(guard, 'GET', { host: '127.0.0.1:9999' });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test('rejects cross-origin mutating POST (drive-by)', () => {
  const { nextCalled, res } = run(guard, 'POST', {
    host: '127.0.0.1:38219',
    origin: 'https://evil.com',
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res._json.error, 'forbidden_origin');
});

test('allows same-origin mutating POST (legit SPA)', () => {
  const { nextCalled } = run(guard, 'POST', {
    host: '127.0.0.1:38219',
    origin: 'http://127.0.0.1:38219',
  });
  assert.equal(nextCalled, true);
});

test('allows mutating POST with no Origin/Referer (CLI / curl)', () => {
  const { nextCalled } = run(guard, 'POST', { host: 'localhost:38219' });
  assert.equal(nextCalled, true);
});

test('rejects cross-origin via Referer when Origin absent', () => {
  const { nextCalled, res } = run(guard, 'POST', {
    host: '127.0.0.1:38219',
    referer: 'https://evil.com/page',
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});
