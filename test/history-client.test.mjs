import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pacedHistoryClient, resumableOrderClient } from '../src/history-client.mjs';
import { SnapshotStore } from '../src/storage.mjs';

test('a espera ocorre antes de pedir a próxima página e não impede operações independentes', async () => {
  let now = 0;
  const calls = [], waits = [];
  const client = pacedHistoryClient({
    async *searchOrders() { calls.push(['orders',now]); yield { nextToken:'second' }; calls.push(['orders',now]); yield {}; },
    async *listTransactions() { calls.push(['finance',now]); yield {}; },
  }, { now:() => now, sleep:async ms => { waits.push(ms); now += ms; } });
  const pages = client.searchOrders();
  await pages.next();
  for await (const page of client.listTransactions()) assert.deepEqual(page,{});
  await pages.next();
  assert.equal((await pages.next()).done,true);
  assert.deepEqual(calls,[['orders',0],['finance',0],['orders',200000]]);
  assert.deepEqual(waits,[200000]);
});

test('retomada reaproveita páginas salvas, preserva observação e não lê cache de outra loja', async t => {
  const base = path.resolve(tmpdir()), rootDir = await mkdtemp(path.join(base,'synthamazon-history-cache-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(rootDir)),base); assert.ok(path.basename(rootDir).startsWith('synthamazon-history-cache-')); await rm(rootDir,{recursive:true,force:true}); });
  const calls = [], parameters = { createdAfter:'2026-01-01T03:00:00Z', createdBefore:'2026-01-02T03:00:00Z' };
  const page = (id, nextToken) => ({ orders:[{orderId:id}], nextToken, rawBody:JSON.stringify({ orders:[{orderId:id}], ...(nextToken ? {pagination:{nextToken}} : {}) }) });
  const first = resumableOrderClient({ async *searchOrders(params) { calls.push(params); yield page('one','cursor'); throw new Error('interrupted'); } },
    { store:new SnapshotStore({rootDir,storeId:'hd-comercio'}), now:() => new Date('2026-09-01T10:00:00Z') });
  await assert.rejects(async () => { for await (const _ of first.searchOrders(parameters)) {} }, /interrupted/);
  const second = resumableOrderClient({ async *searchOrders(params) { calls.push(params); yield page('two'); } },
    { store:new SnapshotStore({rootDir,storeId:'hd-comercio'}) });
  const result = [];
  for await (const item of second.searchOrders(parameters)) result.push(item);
  assert.deepEqual(result.map(item => item.orders[0].orderId),['one','two']);
  assert.equal(result[0].observedAt,'2026-09-01T10:00:00.000Z');
  assert.equal(calls[1].paginationToken,'cursor');
  for await (const _ of second.searchOrders(parameters)) {}
  assert.equal(calls.length,2);
  const other = resumableOrderClient({ async *searchOrders(params) { calls.push(params); yield page('other'); } },
    { store:new SnapshotStore({rootDir,storeId:'origem-comercio'}) });
  for await (const _ of other.searchOrders(parameters)) {}
  assert.equal(calls.length,3);
  assert.equal(calls[2].paginationToken,undefined);
});
