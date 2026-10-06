import test from 'node:test';
import assert from 'node:assert/strict';
import { startWebServer } from '../src/web/server.mjs';

test('remote access rejects insecure, noncanonical or unbounded configuration before opening a socket', async () => {
  const deadline = Date.now() + 3_600_000;
  for (const publicOrigin of ['http://example.test', 'https://example.test/', 'https://example.test/path', 'https://example.test?x=1', 'https://example.test#x', 'https://user:pass@example.test']) {
    await assert.rejects(startWebServer({ publicOrigin, expiresAt: deadline }), TypeError);
  }
  for (const expiresAt of [null, 0, Date.now() - 1, Date.now() + 90_000_000, Infinity]) {
    await assert.rejects(startWebServer({ publicOrigin: 'https://example.test', expiresAt }), TypeError);
  }
  await assert.rejects(startWebServer({ expiresAt: deadline }), TypeError);
});
