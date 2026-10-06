import test from 'node:test';
import assert from 'node:assert/strict';
import { startCredentialSetup } from '../src/setup.mjs';

test('setup exige origem, cookie e formulário, salva uma vez e não reflete segredos', async t => {
  const saved = [];
  const { url, server } = await startCredentialSetup({ save: async credentials => saved.push(credentials), autoClose: false });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const page = await fetch(url);
  const html = await page.text();
  const cookie = page.headers.get('set-cookie').split(';')[0];
  const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/)[1];
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(page.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal(page.headers.get('referrer-policy'), 'same-origin');
  const body = new URLSearchParams({ csrf, clientId: 'mock-id', clientSecret: 'secret-do-not-echo', refreshToken: 'refresh-do-not-echo' });
  const headers = { origin: new URL(url).origin, cookie, 'content-type': 'application/x-www-form-urlencoded' };
  const hostile = await fetch(url, { method: 'POST', headers: { ...headers, origin: 'https://example.com' }, body });
  assert.equal(hostile.status, 403);
  assert.equal(saved.length, 0);
  const nullOrigin = await fetch(url, { method: 'POST', headers: { ...headers, origin: 'null' }, body });
  assert.equal(nullOrigin.status, 403);
  assert.equal(saved.length, 0);
  const badToken = await fetch(url, { method: 'POST', headers, body: new URLSearchParams({ ...Object.fromEntries(body), csrf: 'bad' }) });
  assert.equal(badToken.status, 403);
  const result = await fetch(url, { method: 'POST', headers, body });
  assert.equal(result.status, 200);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].clientSecret, 'secret-do-not-echo');
  const success = await result.text();
  assert.equal(/secret-do-not-echo|refresh-do-not-echo/.test(success), false);
  const again = await fetch(url, { method: 'POST', headers, body });
  assert.equal(again.status, 410);
  assert.equal(saved.length, 1);
});

test('erros de armazenamento são genéricos e caminhos de configuração não são enumeráveis', async t => {
  const { url, server } = await startCredentialSetup({ save: async () => { throw new Error('secret-data'); }, autoClose: false });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const unknown = await fetch(`${new URL(url).origin}/setup/unknown`);
  assert.equal(unknown.status, 404);
  const page = await fetch(url);
  const cookie = page.headers.get('set-cookie').split(';')[0];
  const csrf = (await page.text()).match(/name="csrf" value="([a-f0-9]+)"/)[1];
  const result = await fetch(url, { method: 'POST', headers: { origin: new URL(url).origin, cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf, clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh' }) });
  assert.equal(result.status, 500);
  assert.equal((await result.text()).includes('secret-data'), false);
});
