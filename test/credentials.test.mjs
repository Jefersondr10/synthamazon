import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadCredentials, protectCredentials } from '../src/credentials.mjs';

// Deliberately fabricated values. No real account or Amazon endpoint is used.
const sample = { clientId: 'test-client-id', clientSecret: 'test-secret-only', refreshToken: 'test-refresh-only' };

async function temporaryVault(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'synthamazon-dpapi-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return path.join(root, 'private', 'test.dpapi');
}

test('missing and invalid credentials return safe stable errors', async t => {
  const vaultPath = await temporaryVault(t);
  await assert.rejects(loadCredentials({ vaultPath }), { code: 'CREDENTIALS_NOT_FOUND' });
  await assert.rejects(protectCredentials({ ...sample, refreshToken: '' }, { vaultPath }), { code: 'INVALID_CREDENTIALS' });
  await assert.rejects(protectCredentials({ ...sample, extra: 'do-not-store' }, { vaultPath }), { code: 'INVALID_CREDENTIALS' });
});

test('Windows DPAPI roundtrip writes ciphertext, optional sellerId and explicit replacement', { skip: process.platform !== 'win32' }, async t => {
  const vaultPath = await temporaryVault(t);
  assert.deepEqual(await protectCredentials(sample, { vaultPath }), { vaultPath });
  const encrypted = await readFile(vaultPath, 'utf8');
  for (const value of Object.values(sample)) assert.equal(encrypted.includes(value), false);
  assert.match(encrypted.trim(), /^[a-f0-9]+$/i);
  assert.deepEqual(await loadCredentials({ vaultPath }), sample);
  await assert.rejects(protectCredentials({ ...sample, clientSecret: 'replacement-fake' }, { vaultPath }), { code: 'CREDENTIALS_EXISTS' });
  assert.equal(await readFile(vaultPath, 'utf8'), encrypted);
  const replacement = { ...sample, sellerId: 'test-seller', clientSecret: 'replacement-fake' };
  await protectCredentials(replacement, { vaultPath, allowReplace: true });
  assert.deepEqual(await loadCredentials({ vaultPath }), replacement);
  assert.deepEqual(await readdir(path.dirname(vaultPath)), ['test.dpapi']);
});

test('corruption fails generically and keeps existing file untouched', { skip: process.platform !== 'win32' }, async t => {
  const vaultPath = await temporaryVault(t);
  await protectCredentials(sample, { vaultPath });
  const corrupted = '01000000';
  await writeFile(vaultPath, corrupted, 'utf8');
  await assert.rejects(loadCredentials({ vaultPath }), error => {
    assert.equal(error.code, 'CREDENTIALS_UNAVAILABLE');
    for (const secret of [...Object.values(sample), corrupted]) assert.equal(error.message.includes(secret), false);
    return true;
  });
  assert.equal(await readFile(vaultPath, 'utf8'), corrupted);
});

test('an exclusive lock prevents replacement and is not removed by the rejected writer', { skip: process.platform !== 'win32' }, async t => {
  const vaultPath = await temporaryVault(t);
  await protectCredentials(sample, { vaultPath });
  const encrypted = await readFile(vaultPath, 'utf8');
  await writeFile(`${vaultPath}.lock`, '', { flag: 'wx' });
  await assert.rejects(protectCredentials(sample, { vaultPath, allowReplace: true }), { code: 'CREDENTIALS_BUSY' });
  assert.equal(await readFile(vaultPath, 'utf8'), encrypted);
  assert.equal(await readFile(`${vaultPath}.lock`, 'utf8'), '');
});
