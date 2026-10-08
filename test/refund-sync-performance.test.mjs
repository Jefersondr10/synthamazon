import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Repository } from '../src/domain/repository.mjs';
import { getLocalReview } from '../src/domain/local-reviews.mjs';

test('multi-page reconciliation reuses full evidence while preserving every refund and returned SAFE-T assignment', t => {
  const repo = new Repository({ rootDir: path.resolve('test'), dbPath: ':memory:',
    stores: [{ storeId: 'a', name: 'A' }, { storeId: 'b', name: 'B' }] });
  t.after(() => repo.close());
  const now = '2026-10-06T12:00:00.000Z', count = 501;
  const orderIds = Array.from({ length: count }, (_, index) => `order-${String(index).padStart(4, '0')}`);
  const insert = repo.db.prepare('INSERT INTO entities VALUES(?,?,?,?,?,?,?,?,?)');
  const put = (storeId, source, id, payload) => insert.run(storeId, source, id, now, now, 'fixture', payload.status, 1,
    JSON.stringify({ storeId, observedAt: now, ...payload }));
  for (const orderId of orderIds) {
    put('a', 'orders', orderId, { orderId, status: 'SHIPPED', fulfillmentMode: 'DBA', createdAt: now,
      packages: [{ packageReferenceId: orderId, status: 'UNDELIVERABLE', detailedStatus: 'RETURNED_TO_SELLER' }] });
    put('a', 'transactions', `refund-${orderId}`, { transactionId: `refund-${orderId}`, type: 'Refund',
      status: 'RELEASED', postedAt: now, totalCents: '-10000', currency: 'BRL', orderIds: [orderId] });
  }
  // Credit assignments cross the page boundary; the same IDs in another
  // store must remain untouched by this store's reconciliation.
  for (const storeId of ['a', 'b']) for (const orderId of [orderIds[0], orderIds.at(-1)]) {
    put(storeId, 'transactions', `credit-${orderId}`, { transactionId: `credit-${orderId}`, type: 'Adjustment',
      status: 'RELEASED', postedAt: now, totalCents: '10000', currency: 'BRL', orderIds: [orderId],
      breakdowns: [{ kind: 'SAFETReimbursement', amountCents: '10000', currency: 'BRL' }] });
  }
  const sourceBefore = repo.db.prepare('SELECT store_id,source,source_id,payload_json FROM entities ORDER BY store_id,source,source_id').all();
  let sourceScans = 0, financialReviewReads = 0;
  const prepare = repo.db.prepare;
  t.mock.method(repo.db, 'prepare', function (sql) {
    if (sql.startsWith('SELECT payload_json FROM entities WHERE store_id=? AND source=?')) sourceScans++;
    if (sql.startsWith('SELECT status,notes,version,updated_at AS updatedAt FROM financial_case_reviews')) financialReviewReads++;
    return prepare.call(this, sql);
  });

  assert.deepEqual(repo.syncRefundManagement({ storeId: 'a', now }), { created: count, updated: 0, reopened: 0, missing: 0 });
  assert.equal(sourceScans, 2, 'orders and transactions are scanned once regardless of management page count');
  assert.ok(financialReviewReads <= count * 2, 'each financial page is projected at most once, never for each management page');
  const rows = repo.db.prepare('SELECT store_id,order_id,source_json FROM refund_management ORDER BY order_id').all();
  assert.equal(rows.length, count);
  assert.deepEqual(rows.map(row => row.order_id), orderIds);
  assert.ok(rows.every(row => row.store_id === 'a' && JSON.parse(row.source_json).refund.byCurrency[0].totalCents === '10000'));
  for (const orderId of [orderIds[0], orderIds.at(-1)]) {
    assert.equal(getLocalReview(repo.db, { menu: 'returns', storeId: 'a', entityId: orderId }).label, 'SAFE-T CONCEDIDO');
    assert.equal(getLocalReview(repo.db, { menu: 'returns', storeId: 'b', entityId: orderId }).version, 0);
  }
  assert.deepEqual(repo.db.prepare('SELECT store_id,source,source_id,payload_json FROM entities ORDER BY store_id,source,source_id').all(), sourceBefore);
  sourceScans = 0; financialReviewReads = 0;
  assert.deepEqual(repo.syncRefundManagement({ storeId: 'a', now }), { created: 0, updated: 0, reopened: 0, missing: 0 });
  assert.equal(sourceScans, 2);
  assert.ok(financialReviewReads <= count * 2);
  assert.equal(repo.db.prepare("SELECT count(*) AS count FROM returned_management_history WHERE action='automatic-safe-t-granted'").get().count, 2);
});
