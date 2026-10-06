import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAllRecords } from '../public/list-data.js';

test('complete lists exceed the API batch size and retain the same filters and ordering', async () => {
  const calls = [], rows = Array.from({ length: 1003 }, (_, orderId) => ({ orderId }));
  const filters = new URLSearchParams({ storeId: 'store-a', workflow: 'all', status: 'rm_safe_t_granted', sort: 'refundDate', direction: 'asc', offset: '10' });
  const result = await loadAllRecords(async url => {
    const params = new URL(url, 'http://localhost').searchParams, offset = Number(params.get('offset'));
    calls.push(params);
    return { items: rows.slice(offset, offset + 500), total: rows.length, hasMore: offset + 500 < rows.length, summary: { total: rows.length } };
  }, '/api/refund-management', filters);
  assert.deepEqual(result.items, rows);
  assert.equal(result.hasMore, false);
  assert.deepEqual(calls.map(p => p.get('offset')), ['0', '500', '1000']);
  for (const params of calls) for (const name of ['storeId', 'workflow', 'status', 'sort', 'direction']) assert.equal(params.get(name), filters.get(name));
  assert.equal(filters.get('offset'), '10');
});

test('a superseded view stops loading and never renders a partial old list', async () => {
  let current = true, calls = 0;
  const result = await loadAllRecords(async () => {
    calls++; current = false;
    return { items: [{ orderId: 'old' }], hasMore: true };
  }, '/api/returns', new URLSearchParams(), () => current);
  assert.equal(result, null); assert.equal(calls, 1);
});

test('empty results finish, incomplete batches and request failures cannot masquerade as all results', async () => {
  assert.deepEqual((await loadAllRecords(async () => ({ items: [], total: 0, hasMore: false }), '/api/returns', {})).items, []);
  await assert.rejects(loadAllRecords(async () => ({ items: [], hasMore: true }), '/api/returns', {}), /todos os pedidos/);
  let requests = 0;
  await assert.rejects(loadAllRecords(async () => {
    if (requests++) throw new Error('Connection lost');
    return { items: [{ orderId: 'first' }], hasMore: true };
  }, '/api/returns', {}), /Connection lost/);
});
