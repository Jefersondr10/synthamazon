import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SnapshotStore } from '../src/storage.mjs';

async function temporaryRoot(t) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'synthamazon-storage-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  return rootDir;
}

test('identical pages reuse one object and preserve the exact response text', async (t) => {
  const rootDir = await temporaryRoot(t);
  const store = new SnapshotStore({ rootDir, storeId: 'origem-comercio' });
  const body = '{\n  "label": "Comissão", "amount": 1.00\n}\n';
  const first = await store.savePage({ source: 'transactions', body });
  const repeated = await store.savePage({ source: 'transactions', body });

  assert.deepEqual(repeated, first);
  assert.equal(first.hash, createHash('sha256').update(body, 'utf8').digest('hex'));
  assert.equal(first.relativePath, `objects/transactions/${first.hash}.json`);
  assert.deepEqual(
    await readdir(path.join(rootDir, 'origem-comercio', 'objects', 'transactions')),
    [`${first.hash}.json`],
  );
  assert.equal(await store.readPage({ source: 'transactions', hash: first.hash }), body);
});

test('revised responses remain beside the original snapshot', async (t) => {
  const rootDir = await temporaryRoot(t);
  const store = new SnapshotStore({ rootDir, storeId: 'origem-comercio' });
  const beforeBody = '{"transactionId":"example","status":"DEFERRED"}';
  const afterBody = '{"transactionId":"example","status":"RELEASED"}';
  const before = await store.savePage({ source: 'transactions', body: beforeBody });
  const after = await store.savePage({ source: 'transactions', body: afterBody });

  assert.notEqual(before.hash, after.hash);
  assert.equal(await store.readPage({ source: 'transactions', hash: before.hash }), beforeBody);
  assert.equal(await store.readPage({ source: 'transactions', hash: after.hash }), afterBody);
  assert.equal(
    (await readdir(path.join(rootDir, 'origem-comercio', 'objects', 'transactions'))).length,
    2,
  );
});

test('an existing truncated or corrupted object is rejected without overwriting it', async (t) => {
  const rootDir = await temporaryRoot(t);
  const store = new SnapshotStore({ rootDir, storeId: 'origem-comercio' });
  const body = '{"items":[{"amount":100}]}';
  const page = await store.savePage({ source: 'transactions', body });
  const filename = path.join(rootDir, 'origem-comercio', page.relativePath);

  for (const damaged of ['', body.slice(0, 12), body.replace('100', '999')]) {
    await writeFile(filename, damaged, 'utf8');
    await assert.rejects(
      store.savePage({ source: 'transactions', body }),
      /Snapshot integrity check failed for existing object/,
    );
    assert.equal(await readFile(filename, 'utf8'), damaged);
  }
});

test('stores and sources are isolated even when response bytes match', async (t) => {
  const rootDir = await temporaryRoot(t);
  const origem = new SnapshotStore({ rootDir, storeId: 'origem-comercio' });
  const other = new SnapshotStore({ rootDir, storeId: 'test-store' });
  const page = await origem.savePage({ source: 'orders', body: '{"items":[]}' });

  await assert.rejects(other.readPage({ source: 'orders', hash: page.hash }), { code: 'ENOENT' });
  await assert.rejects(origem.readPage({ source: 'transactions', hash: page.hash }), { code: 'ENOENT' });
  const otherPage = await other.savePage({ source: 'orders', body: '{"items":[]}' });
  const otherSourcePage = await origem.savePage({ source: 'transactions', body: '{"items":[]}' });
  assert.equal(otherPage.hash, page.hash);
  assert.equal(otherSourcePage.hash, page.hash);
  for (const [storeId, source] of [
    ['origem-comercio', 'orders'],
    ['test-store', 'orders'],
    ['origem-comercio', 'transactions'],
  ]) {
    assert.equal(
      await readFile(path.join(rootDir, storeId, 'objects', source, `${page.hash}.json`), 'utf8'),
      '{"items":[]}',
    );
  }
});

test('path traversal and invalid identifiers are rejected before writing', async (t) => {
  const rootDir = await temporaryRoot(t);
  const store = new SnapshotStore({ rootDir, storeId: 'origem-comercio' });
  const invalid = ['../other', '..\\other', '/absolute', 'C:\\absolute', '', 'UPPER', 'a/b', '.', 'a'.repeat(65)];
  for (const value of invalid) {
    assert.throws(() => new SnapshotStore({ rootDir, storeId: value }), TypeError);
    await assert.rejects(store.savePage({ source: value, body: '{}' }), TypeError);
  }
  await assert.rejects(store.readPage({ source: 'orders', hash: '../../file' }), TypeError);
  await assert.rejects(store.saveRun({ id: '../outside' }), TypeError);
  assert.deepEqual(await readdir(rootDir), []);
});

test('run manifests are independent, immutable, and tied to their store', async (t) => {
  const rootDir = await temporaryRoot(t);
  const store = new SnapshotStore({ rootDir, storeId: 'origem-comercio' });
  const page = await store.savePage({ source: 'orders', body: '{"items":[]}' });
  const first = { id: randomUUID(), storeId: 'origem-comercio', pages: [page] };
  const second = { ...first, id: randomUUID() };
  const firstSaved = await store.saveRun(first);
  await store.saveRun(second);
  await assert.rejects(store.saveRun({ ...first, pages: [] }), { code: 'EEXIST' });
  await assert.rejects(store.saveRun({ id: randomUUID(), storeId: 'other-store' }), TypeError);

  assert.deepEqual(
    JSON.parse(await readFile(path.join(rootDir, 'origem-comercio', firstSaved.relativePath), 'utf8')),
    first,
  );
  assert.equal((await readdir(path.join(rootDir, 'origem-comercio', 'runs'))).length, 2);
  assert.equal((await readdir(path.join(rootDir, 'origem-comercio', 'objects', 'orders'))).length, 1);
});

test('invalid JSON is rejected without creating storage files', async (t) => {
  const rootDir = await temporaryRoot(t);
  const store = new SnapshotStore({ rootDir, storeId: 'origem-comercio' });
  await assert.rejects(store.savePage({ source: 'orders', body: { items: [] } }), TypeError);
  await assert.rejects(store.savePage({ source: 'orders', body: '<html>error</html>' }), SyntaxError);
  assert.deepEqual(await readdir(rootDir), []);
});
