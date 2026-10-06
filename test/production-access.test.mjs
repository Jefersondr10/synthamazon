import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { productionAccess } from '../src/web/production-access.mjs';
import { readStoreCredentials, loadStoreConfig } from '../src/stores.mjs';

test('produção aceita o contrato real do OAuth2 Proxy com prefer_email_to_user e rejeita identidade forjada', () => {
  const config = { origin: 'https://synthamazon.example.com', ownerEmail: 'owner@gmail.com', proxyPassword: 'p'.repeat(64) };
  const access = productionAccess(config);
  const credential = (user, password) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  const valid = { 'x-forwarded-user': config.ownerEmail, authorization: credential(config.ownerEmail, config.proxyPassword) };
  assert.equal(access.authorize({ headers: valid }), true);
  for (const headers of [
    { 'x-forwarded-user': config.ownerEmail },
    { authorization: valid.authorization },
    { authorization: valid.authorization, 'x-forwarded-email': config.ownerEmail },
    { ...valid, 'x-forwarded-user': 'other@gmail.com' },
    { ...valid, 'x-forwarded-user': `${config.ownerEmail},other@gmail.com` },
    { ...valid, authorization: credential(config.ownerEmail, 'wrong') },
    { ...valid, authorization: credential('other@gmail.com', config.proxyPassword) },
  ]) assert.equal(access.authorize({ headers }), false);
});

test('configuração de produção rejeita origem insegura, segredo curto e endereço ambíguo', () => {
  const config = { origin: 'https://synthamazon.example.com', ownerEmail: 'owner@gmail.com', proxyPassword: 'x'.repeat(64) };
  for (const change of [{ origin: 'http://synthamazon.example.com' }, { origin: `${config.origin}/` },
    { origin: 'https://user:password@synthamazon.example.com' }, { proxyPassword: 'short' }, { ownerEmail: 'owner@gmail.com,other@gmail.com' }]) {
    assert.throws(() => productionAccess({ ...config, ...change }));
  }
});

test('segredos de produção são exclusivos da loja e não fazem fallback para ambiente ou cofre', async t => {
  const parent = path.resolve(tmpdir());
  const directory = await mkdtemp(path.join(parent, 'synth-production-secrets-'));
  t.after(async () => {
    assert.equal(path.dirname(directory), parent);
    assert.ok(path.basename(directory).startsWith('synth-production-secrets-'));
    await rm(directory, { recursive: true, force: true });
  });
  const config = await loadStoreConfig('hd-comercio');
  const options = { env: { SYNTHAMAZON_SECRETS_DIR: directory,
    HD_SPAPI_CLIENT_ID: 'old', HD_SPAPI_CLIENT_SECRET: 'old', HD_SPAPI_REFRESH_TOKEN: 'old' },
    readVault: async () => { assert.fail('must not fall back to DPAPI'); } };
  await assert.rejects(readStoreCredentials(config, options), { code: 'CREDENTIALS_UNAVAILABLE' });
  const file = path.join(directory, 'hd-comercio.json');
  const credentials = { clientId: 'hd-id', clientSecret: 'hd-secret', refreshToken: 'hd-token', sellerId: 'ABC123' };
  await writeFile(file, JSON.stringify({ storeId: 'origem-comercio', ...credentials }), { mode: 0o600 });
  await assert.rejects(readStoreCredentials(config, options), { code: 'CREDENTIALS_UNAVAILABLE' });
  await writeFile(file, JSON.stringify({ storeId: config.storeId, ...credentials }));
  assert.deepEqual(await readStoreCredentials(config, options), credentials);
  await writeFile(file, JSON.stringify({ storeId: config.storeId, ...credentials, unexpected: 'field' }));
  await assert.rejects(readStoreCredentials(config, options), { code: 'CREDENTIALS_UNAVAILABLE' });
});
