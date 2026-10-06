import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Repository } from '../src/domain/repository.mjs';
import { saveCustomerReturnJob, importCustomerReturnReport } from '../src/domain/customer-returns.mjs';

const type = 'GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE';
const at = day => `2026-09-${String(day).padStart(2, '0')}T12:00:00.000Z`;
function fixture(t) {
  const repo = new Repository({ rootDir: path.resolve('test'), dbPath: ':memory:', stores: [
    { storeId: 'store-a', name: 'Loja A' }, { storeId: 'store-b', name: 'Loja B' },
  ] });
  t.after(() => repo.close());
  for (const storeId of ['store-a', 'store-b']) for (const orderId of ['order-a', 'order-b']) {
    const order = { storeId, orderId, createdAt: at(1), observedAt: at(2), status: 'SHIPPED', fulfillmentMode: 'DBA',
      items: [{ sku: 'TEST-SKU', title: 'Produto teste' }],
      packages: [{ packageReferenceId: 'pkg-a', trackingNumber: 'TRACK-A', status: 'UNDELIVERABLE', detailedStatus: 'RETURNED_TO_SELLER' }] };
    repo.db.prepare('INSERT INTO entities VALUES(?,?,?,?,?,?,?,?,?)').run(storeId, 'orders', orderId, at(2), at(2), 'hash', 'SHIPPED', 1, JSON.stringify(order));
  }
  const ingest = (reportId = 'report-a', observedAt = at(3)) => {
    saveCustomerReturnJob(repo.db, { storeId: 'store-a', reportId, reportType: type, status: 'DONE', from: at(1), to: at(4), createdAt: observedAt, checkedAt: observedAt });
    importCustomerReturnReport(repo.db, { storeId: 'store-a', reportId, reportType: type, observedAt,
      records: ['order-a', 'order-b'].map(orderId => ({ orderId, sku: 'TEST-SKU', rmaId: `rma-${orderId}`, returnRequestedAt: '2026-09-02', returnStatus: 'Approved', reasonCode: 'CR-DEFECTIVE', quantity: 1 })) });
  };
  ingest();
  return { repo, ingest };
}
function status(repo, extra = {}) {
  return repo.saveReviewStatus({ label: 'Aguardando recebimento', color: 'amber', menus: ['customer-returns'],
    active: true, closesCase: false, expectedVersion: 0, ...extra }).status;
}

test('return management persists through report reimport and filters before pagination without changing Amazon evidence', t => {
  const { repo, ingest } = fixture(t), custom = status(repo);
  const row = repo.customerReturns({ storeId: 'store-a' }).items[0];
  const original = repo.db.prepare('SELECT payload_json FROM customer_return_records WHERE return_id=?').get(row.returnId).payload_json;
  const input = { menu: 'customer-returns', storeId: 'store-a', entityId: row.returnId, status: custom.code,
    notes: 'Conferir o item recebido.', expectedVersion: 0, now: at(5) };
  const saved = repo.saveLocalReview(input);
  assert.equal(saved.version, 1); assert.equal(saved.label, custom.label);
  const selected = repo.customerReturns({ storeId: 'store-a', reviewStatus: custom.code, limit: 1 });
  assert.equal(selected.total, 1); assert.equal(selected.items[0].returnId, row.returnId);
  assert.equal(selected.reviewStatusOptions.find(item => item.code === 'pending').count, 1);
  assert.equal(selected.items[0].returnStatus, 'Approved');
  ingest('report-b', at(6));
  const detail = repo.customerReturns({ storeId: 'store-a' }, row.returnId);
  assert.deepEqual(detail.review, saved); assert.equal(detail.reviewHistory.length, 1);
  assert.equal(repo.db.prepare('SELECT payload_json FROM customer_return_records WHERE return_id=?').get(row.returnId).payload_json, original);
  assert.throws(() => repo.saveLocalReview({ ...input, notes: 'Obsolete edit' }), { code: 'REVIEW_CONFLICT' });
  assert.equal(repo.localReview(input).review.notes, input.notes);
});

test('the shared status catalog does not couple reviews across menus or stores, and nonexistent entities cannot be reviewed', async t => {
  const { repo } = fixture(t), custom = status(repo, { menus: ['orders', 'returns'] });
  const input = { menu: 'orders', storeId: 'store-a', entityId: 'order-a', status: custom.code, notes: 'Separado', expectedVersion: 0 };
  repo.saveLocalReview(input);
  assert.equal(repo.orders({ storeId: 'store-a', reviewStatus: custom.code }).total, 1);
  assert.equal(repo.orderDetail('store-a', 'order-a').review.status, custom.code);
  assert.equal(repo.localReview({ ...input, menu: 'returns' }).review.version, 0);
  assert.equal(repo.localReview({ ...input, storeId: 'store-b' }).review.version, 0);
  assert.equal((await repo.returns({ storeId: 'store-a', reviewStatus: custom.code })).total, 0);
  repo.saveLocalReview({ ...input, menu: 'returns' });
  const returned = await repo.returns({ storeId: 'store-a', reviewStatus: custom.code });
  assert.equal(returned.total, 1); assert.equal(returned.summary.total, 1);
  assert.equal(returned.items[0].detailedStatus, 'RETURNED_TO_SELLER');
  for (const change of [{ entityId: 'missing' }, { storeId: 'missing-store' }]) {
    assert.throws(() => repo.saveLocalReview({ ...input, ...change }), { code: 'CASE_NOT_FOUND' });
  }
  assert.throws(() => repo.localReview({ menu: 'customer-returns', storeId: 'store-b', entityId: repo.customerReturns({ storeId: 'store-a' }).items[0].returnId }), { code: 'CASE_NOT_FOUND' });
  assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM local_reviews').get().n, 2);
});

test('renaming or disabling a configured status preserves history, notes and legacy filtering while blocking new assignments', t => {
  const { repo } = fixture(t), custom = status(repo);
  const [one, two] = repo.customerReturns({ storeId: 'store-a' }).items;
  const input = { menu: 'customer-returns', storeId: 'store-a', entityId: one.returnId, status: custom.code, notes: 'Original', expectedVersion: 0 };
  repo.saveLocalReview(input);
  const disabled = repo.saveReviewStatus({ code: custom.code, label: 'Conferência encerrada', color: 'good', menus: [],
    active: false, closesCase: true, expectedVersion: custom.version }).status;
  const detail = repo.localReview(input);
  assert.equal(detail.review.label, disabled.label); assert.equal(detail.review.closesCase, true);
  assert.equal(detail.review.notes, 'Original'); assert.equal(detail.reviewHistory.length, 1);
  assert.ok(!detail.reviewStatuses.some(item => item.code === custom.code));
  assert.equal(repo.customerReturns({ reviewStatus: custom.code }).total, 1);
  assert.throws(() => repo.saveLocalReview({ ...input, entityId: two.returnId }), { code: 'INVALID_REVIEW' });
  assert.equal(repo.saveLocalReview({ ...input, expectedVersion: 1, notes: 'Mais informações' }).version, 2);
  assert.ok(repo.getBootstrap().reviewStatuses.items.some(item => item.code === custom.code && !item.active));
});

test('Amazon status and manual review facets each respect the other filter before pagination', t => {
  const { repo } = fixture(t), custom = status(repo, { menus: ['orders'] });
  repo.saveLocalReview({ menu: 'orders', storeId: 'store-a', entityId: 'order-a', status: custom.code, notes: '', expectedVersion: 0 });
  const key = ['store-a', 'orders', 'order-b'];
  const row = repo.db.prepare('SELECT payload_json FROM entities WHERE store_id=? AND source=? AND source_id=?').get(...key);
  repo.db.prepare('UPDATE entities SET payload_json=? WHERE store_id=? AND source=? AND source_id=?')
    .run(JSON.stringify({ ...JSON.parse(row.payload_json), status: 'CANCELED' }), ...key);
  const manual = repo.orders({ storeId: 'store-a', reviewStatus: custom.code, limit: 1 });
  assert.equal(manual.total, 1); assert.equal(manual.statusOptions.reduce((n, option) => n + option.count, 0), 1);
  assert.equal(manual.statusOptions.some(option => option.code === 'CANCELLED'), false);
  const cancelled = repo.orders({ storeId: 'store-a', status: 'CANCELLED', limit: 1 });
  assert.deepEqual(cancelled.reviewStatusOptions.map(option => [option.code, option.count]), [['pending', 1]]);
});
