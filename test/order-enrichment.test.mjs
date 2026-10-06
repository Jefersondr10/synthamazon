import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Repository } from '../src/domain/repository.mjs';
import { SnapshotStore } from '../src/storage.mjs';
import { collectMissingSafeTOrders, recoverOrderEnrichment, selectMissingSafeTOrders } from '../src/order-enrichment.mjs';

const at = '2026-09-25T12:00:00.000Z';
const config = { storeId: 'store-a', marketplaceId: 'A2Q3Y263D00KWC' };
const rawOrder = id => `{ "order": {"orderId":"${id}","orderItems":[],"createdTime":"2026-01-03T12:00:00Z","programs":[],"fulfillment":{"fulfilledBy":"AMAZON","fulfillmentStatus":"SHIPPED"},"proceeds":{"grandTotal":{"amount":9007199254740993.13,"currencyCode":"BRL"}}} }`;
const response = id => ({ order: { orderId: id }, rawBody: rawOrder(id), requestId: 'mock-request' });
async function fixture(t, ids = ['order-a']) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'synth-enrichment-'));
  const repository = new Repository({ rootDir, dbPath: path.join(rootDir, 'test.sqlite'), stores: [config] });
  const store = new SnapshotStore({ rootDir, storeId: config.storeId });
  repository.safeTCases = ({ offset, limit }) => ({ items: ids.slice(offset, offset + limit).map(orderId => ({ storeId: config.storeId, orderId })), hasMore: offset + limit < ids.length });
  t.after(async () => { repository.close(); await rm(rootDir, { recursive: true, force: true }); });
  const options = { repository, store, config, rootDir, now: () => new Date(at), sleep: async () => {} };
  async function existing(id) {
    const saved = await store.savePage({ source: 'orders', body: JSON.stringify({ orders: [{ orderId: id, orderItems: [],
      fulfillment: { fulfillmentStatus: 'CANCELLED', fulfilledBy: 'MERCHANT' }, proceeds: { grandTotal: { amount: '10.17', currencyCode: 'BRL' } } }] }) });
    await repository.importRun({ id: randomUUID(), storeId: config.storeId, startedAt: at, finishedAt: at, sources: [{
      source: 'orders', status: 'partial', pages: [{ ...saved, observedAt: at, hasNextPage: false }] }] });
  }
  return { ...options, options, existing };
}

test('candidate selection reads every menu page, excludes existing orders, caps 100, and isolates store', async t => {
  const ids = Array.from({ length: 603 }, (_, i) => `order-${String(i).padStart(4, '0')}`);
  const { repository, existing } = await fixture(t, ids);
  await existing(ids[0]);
  const before = repository.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n;
  const selected = selectMissingSafeTOrders(repository, { storeId: config.storeId });
  assert.equal(selected.missingCount, 602);
  assert.equal(selected.orderIds.length, 100);
  assert.ok(!selected.orderIds.includes(ids[0]));
  assert.equal(repository.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n, before);
  assert.throws(() => selectMissingSafeTOrders(repository, { storeId: 'all' }), { code: 'INVALID_PARAMETERS' });
  assert.throws(() => selectMissingSafeTOrders(repository, { storeId: config.storeId, maxOrders: 101 }), { code: 'INVALID_PARAMETERS' });
  repository.safeTCases = () => ({ items: [{ storeId: 'store-b', orderId: 'other' }], hasMore: false });
  assert.throws(() => selectMissingSafeTOrders(repository, { storeId: config.storeId }), { code: 'INVALID_RESPONSE' });
});

test('serial enrichment isolates failures, rejects wrong IDs, preserves raw amounts, and prints only aggregates', async t => {
  const ctx = await fixture(t, ['order-a', 'order-b', 'order-c']);
  const delays = [], calls = [], reports = [];
  const client = { async getOrder(id, params) {
    calls.push({ id, params });
    if (id === 'order-b') throw Object.assign(new Error('SECRET access=private'), { code: 'HTTP_ERROR', status: 404, url: 'https://secret.invalid' });
    return id === 'order-c' ? { order: { orderId: id }, rawBody: rawOrder('wrong-id') } : response(id);
  } };
  const result = await collectMissingSafeTOrders({ ...ctx.options, client, sleep: async ms => delays.push(ms), report: progress => reports.push(JSON.stringify(progress)) });
  assert.equal(result.attempted, 3); assert.equal(result.collected, 1); assert.equal(result.failed, 2); assert.equal(result.insertedOrders, 1);
  assert.deepEqual(delays, [2100, 2100]);
  assert.ok(calls.every(call => JSON.stringify(call.params) === '{"includedData":["PACKAGES","FULFILLMENT"]}'));
  assert.ok(reports.every(value => !/order-|SECRET|private|https:/.test(value)));
  const [filename] = await readdir(path.join(ctx.rootDir, config.storeId, 'runs'));
  const manifest = JSON.parse(await readFile(path.join(ctx.rootDir, config.storeId, 'runs', filename), 'utf8'));
  assert.equal(manifest.outcome, 'partial');
  assert.equal(manifest.sources[0].failures[0].code, 'HTTP_ERROR');
  assert.ok(!JSON.stringify(manifest).includes('SECRET'));
  assert.equal(await ctx.store.readPage({ source: 'orders', hash: manifest.sources[0].pages[0].hash }), rawOrder('order-a'));
  assert.equal(ctx.repository.orderDetail(config.storeId, 'order-a').grandTotalCents, '900719925474099313');
  assert.equal(ctx.repository.getBootstrap().coverage[0].status, 'targeted-observations');
  assert.equal(ctx.repository.getBootstrap().latestSync, null);
  assert.deepEqual(await readdir(path.join(ctx.rootDir, config.storeId, 'order-enrichment')), []);
});

test('persistent authorization error stops the batch after one attempt and publishes safe recoverable evidence', async t => {
  const ctx = await fixture(t, ['order-a', 'order-b']);
  let calls = 0;
  const result = await collectMissingSafeTOrders({ ...ctx.options, client: { async getOrder() {
    calls++; throw Object.assign(new Error('private access'), { code: 'HTTP_ERROR', status: 403 });
  } } });
  assert.equal(calls, 1); assert.equal(result.stoppedEarly, true); assert.equal(result.failed, 1);
  assert.equal(ctx.repository.orders({ storeId: config.storeId }).total, 0);
  assert.deepEqual(result.errorCounts, { HTTP_ERROR: 1 });
});

test('an import failure can be recovered without another request and replay is idempotent', async t => {
  const ctx = await fixture(t);
  const original = ctx.repository.importRun.bind(ctx.repository);
  ctx.repository.importRun = async () => { throw new Error('simulated database interruption'); };
  let calls = 0;
  await assert.rejects(collectMissingSafeTOrders({ ...ctx.options, client: { async getOrder(id) { calls++; return response(id); } } }), { code: 'ENRICHMENT_IMPORT_FAILED' });
  assert.equal(calls, 1);
  assert.equal((await readdir(path.join(ctx.rootDir, config.storeId, 'order-enrichment'))).length, 1);
  ctx.repository.importRun = original;
  assert.deepEqual(await recoverOrderEnrichment(ctx.options), { recoveredRuns: 1, insertedOrders: 1 });
  assert.deepEqual(await recoverOrderEnrichment(ctx.options), { recoveredRuns: 0, insertedOrders: 0 });
  assert.equal(calls, 1);
  assert.equal(ctx.repository.getEntityHistory(config.storeId, 'orders', 'order-a').length, 1);
});

test('interruption between requests recovers the last checkpoint without pretending the remaining IDs were queried', async t => {
  const ctx = await fixture(t, ['order-a', 'order-b']);
  let calls = 0;
  await assert.rejects(collectMissingSafeTOrders({ ...ctx.options, sleep: async () => { throw new Error('simulated process interruption'); },
    client: { async getOrder(id) { calls++; return response(id); } } }), /simulated process/);
  assert.equal(calls, 1);
  assert.deepEqual(await recoverOrderEnrichment(ctx.options), { recoveredRuns: 1, insertedOrders: 1 });
  assert.equal(ctx.repository.orderDetail(config.storeId, 'order-b'), null);
  assert.equal(selectMissingSafeTOrders(ctx.repository, { storeId: config.storeId }).missingCount, 1);
});

test('a concurrent normal import wins over enrichment and a pre-aborted batch performs no network work', async t => {
  const ctx = await fixture(t);
  const result = await collectMissingSafeTOrders({ ...ctx.options, client: { async getOrder(id) {
    await ctx.existing(id); return response(id);
  } } });
  assert.equal(result.collected, 1); assert.equal(result.insertedOrders, 0); assert.equal(result.skippedExisting, 1);
  const kept = ctx.repository.orderDetail(config.storeId, 'order-a');
  assert.equal(kept.status, 'CANCELLED'); assert.equal(kept.grandTotalCents, '1017');
  assert.equal(ctx.repository.getEntityHistory(config.storeId, 'orders', 'order-a').length, 1);
  ctx.repository.safeTCases = () => ({ items: [{ storeId: config.storeId, orderId: 'order-b' }], hasMore: false });
  const controller = new AbortController(); controller.abort();
  const aborted = await collectMissingSafeTOrders({ ...ctx.options, signal: controller.signal, client: { async getOrder() { assert.fail('network must not run'); } } });
  assert.equal(aborted.attempted, 0); assert.equal(aborted.interrupted, true);
});
