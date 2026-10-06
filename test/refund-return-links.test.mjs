import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Repository } from '../src/domain/repository.mjs';
import { saveCustomerReturnJob, importCustomerReturnReport } from '../src/domain/customer-returns.mjs';
import { recordTrackingObservation, returnsView } from '../src/domain/returns.mjs';

const stamp = month => `2026-${String(month).padStart(2, '0')}-15T12:00:00.000Z`;
const reportType = 'GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE';
const pkg = detailedStatus => ({ packageReferenceId: 'package-a', trackingNumber: 'TRACK-A', status: 'IN_TRANSIT', detailedStatus });
function fixture(t) {
  const repo = new Repository({ rootDir: path.resolve('test'), dbPath: ':memory:', stores: [
    { storeId: 'store-a', name: 'Loja A' }, { storeId: 'store-b', name: 'Loja B' },
  ] });
  t.after(() => repo.close());
  const entity = (source, id, item) => repo.db.prepare('INSERT OR REPLACE INTO entities VALUES(?,?,?,?,?,?,?,?,?)')
    .run(item.storeId, source, id, item.observedAt, item.observedAt, `hash-${id}`, item.status ?? null, 1, JSON.stringify(item));
  function order(orderId, storeId = 'store-a', fulfillmentMode = 'DBA', detailedStatus = 'IN_TRANSIT', observedAt = stamp(8)) {
    const item = { storeId, orderId, createdAt: stamp(1), observedAt, status: 'SHIPPED', fulfillmentMode,
      items: [{ sku: 'TEST-SKU', title: 'Produto de teste' }], packages: [pkg(detailedStatus)] };
    entity('orders', orderId, item); return item;
  }
  function transaction(transactionId, orderIds, { storeId = 'store-a', type = 'Refund', totalCents = '-1234' } = {}) {
    const item = { storeId, transactionId, type, status: 'RELEASED', postedAt: stamp(9), observedAt: stamp(9),
      orderIds, totalCents, currency: 'BRL', deferredTransactionIds: [], releaseTransactionIds: [], items: [], breakdowns: [] };
    entity('transactions', transactionId, item); return item;
  }
  let reportSequence = 0;
  function customer(records, storeId = 'store-a') {
    const reportId = `report-${++reportSequence}`;
    saveCustomerReturnJob(repo.db, { storeId, reportId, reportType, status: 'DONE', createdAt: stamp(2), checkedAt: stamp(2) });
    importCustomerReturnReport(repo.db, { storeId, reportId, reportType, observedAt: stamp(2), records:
      records.map(record => ({ sku: 'TEST-SKU', returnRequestedAt: '2026-02-01', returnStatus: 'Approved', ...record })) });
  }
  function tracking(orderId, storeId = 'store-a') {
    recordTrackingObservation(repo.db, { storeId, orderId, observedAt: stamp(2), packages: [pkg('RETURNED_TO_SELLER')] });
    recordTrackingObservation(repo.db, { storeId, orderId, observedAt: stamp(3), packages: [pkg('DELIVERED')] });
  }
  return { repo, order, transaction, customer, tracking };
}
const withoutLinks = ({ returnLinks, ...row }) => row;

test('refund lists and details link either return menu across all history without changing money or manual review', t => {
  const { repo, order, transaction, customer, tracking } = fixture(t);
  for (const id of ['both', 'customer-only', 'seller-only', 'neither']) { order(id); transaction(`refund-${id}`, [id]); }
  transaction('charge-a', ['both'], { type: 'ServiceFee', totalCents: '-235' });
  const filters = { storeId: 'store-a', from: '2026-09-01', to: '2026-09-30' };
  const both = repo.financialCases('refunds', filters).items.find(row => row.orderIds[0] === 'both');
  repo.saveFinancialReview({ kind: 'refunds', storeId: 'store-a', caseId: both.caseId, status: 'in_review',
    notes: 'Conferência manual preservada.', expectedVersion: 0, now: stamp(9) });
  const before = repo.financialCases('refunds', filters);
  const beforeDetail = repo.financialCaseDetail('refunds', 'store-a', both.caseId);
  const financialEvidence = repo.db.prepare("SELECT payload_json FROM entities WHERE source='transactions' ORDER BY source_id").all();

  const reportRecords = [{ orderId: 'both', rmaId: 'rma-first' }, { orderId: 'both', rmaId: 'rma-second' },
    { orderId: 'customer-only', rmaId: 'rma-only' }];
  customer(reportRecords); customer(reportRecords); // The same rows in another report are not duplicate links.
  tracking('both'); tracking('seller-only');
  const after = repo.financialCases('refunds', filters);
  assert.deepEqual(after.items.map(withoutLinks), before.items.map(withoutLinks));
  assert.deepEqual(after.summary, before.summary);
  assert.deepEqual(repo.db.prepare("SELECT payload_json FROM entities WHERE source='transactions' ORDER BY source_id").all(), financialEvidence);
  const rows = new Map(after.items.map(row => [row.orderIds[0], row]));
  for (const [id, customerCount, sellerCount] of [['both', 2, 1], ['customer-only', 1, 0], ['seller-only', 0, 1], ['neither', 0, 0]]) {
    const row = rows.get(id);
    assert.equal(row.returnLinks.customerReturns.length, customerCount);
    assert.equal(row.returnLinks.returnedToSeller.length, sellerCount);
    assert.ok(row.returnLinks.customerReturns.every(link => link.orderId === id));
    assert.deepEqual(repo.financialCaseDetail('refunds', 'store-a', row.caseId).returnLinks, row.returnLinks);
  }
  const historical = rows.get('both').returnLinks.returnedToSeller[0];
  assert.deepEqual(historical, { orderId: 'both', detectedAt: stamp(2), returnStatusChanged: true });
  assert.deepEqual(withoutLinks(repo.financialCaseDetail('refunds', 'store-a', both.caseId)), withoutLinks(beforeDetail));
  assert.equal(repo.financialCaseDetail('refunds', 'store-a', 'refunds-' + '0'.repeat(64)), null);
  const charge = repo.financialCases('charges', filters).items[0];
  assert.equal(Object.hasOwn(charge, 'returnLinks'), false);
  assert.equal(Object.hasOwn(repo.financialCaseDetail('charges', 'store-a', charge.caseId), 'returnLinks'), false);
});

test('links require exact store and order identity and include every unallocated multi-order reference', t => {
  const { repo, order, transaction, customer, tracking } = fixture(t);
  for (const storeId of ['store-a', 'store-b']) { order('shared', storeId); transaction('same-refund-id', ['shared'], { storeId }); }
  order('shared-extra'); customer([{ orderId: 'shared-extra', rmaId: 'prefix-only' }]); tracking('shared-extra');
  customer([{ orderId: 'shared', rmaId: 'other-store' }], 'store-b'); tracking('shared', 'store-b');
  const a = repo.financialCases('refunds', { storeId: 'store-a' }).items[0];
  const b = repo.financialCases('refunds', { storeId: 'store-b' }).items[0];
  assert.deepEqual(a.returnLinks, { customerReturns: [], returnedToSeller: [] });
  assert.equal(b.returnLinks.customerReturns.length, 1); assert.equal(b.returnLinks.returnedToSeller.length, 1);

  order('left'); order('right'); order('fba-evidence', 'store-a', 'FBA', 'RETURNED_TO_SELLER');
  transaction('multi-refund', ['left', 'right', 'left', 'fba-evidence'], { totalCents: '-9900' });
  transaction('unlinked-refund', []);
  customer([{ orderId: 'left', rmaId: 'left-a' }, { orderId: 'left', rmaId: 'left-b' }, { orderId: 'right', rmaId: 'right-a' }]);
  tracking('right');
  const all = repo.financialCases('refunds', { storeId: 'all' });
  const multi = all.items.find(row => row.orderIds.includes('left'));
  assert.equal(multi.allocation, 'multiple-orders-unallocated'); assert.equal(multi.order, null);
  assert.equal(multi.totalCents, '-9900'); assert.equal(multi.refundCount, 1);
  assert.equal(multi.returnLinks.customerReturns.length, 3);
  assert.deepEqual(multi.returnLinks.returnedToSeller.map(link => link.orderId), ['right']);
  const unrelated = all.items.find(row => !row.orderIds.length);
  assert.deepEqual(unrelated.returnLinks, { customerReturns: [], returnedToSeller: [] });
  assert.deepEqual(all.items.find(row => row.caseId === a.caseId).returnLinks, a.returnLinks);
  assert.deepEqual(all.items.find(row => row.caseId === b.caseId).returnLinks, b.returnLinks);
});

test('returned-to-seller links include historical order observations beyond the first 500 menu rows', t => {
  const { repo, order, transaction } = fixture(t);
  for (let index = 0; index < 500; index++) order(`order-${String(index).padStart(3, '0')}`, 'store-a', 'DBA', 'RETURNED_TO_SELLER', stamp(2));
  const target = order('order-500', 'store-a', 'DBA', 'DELIVERED');
  const old = { ...target, observedAt: stamp(2), packages: [pkg('RETURNED_TO_SELLER')] };
  repo.db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?)').run('store-a', 'older-run', 'manifest-hash', stamp(2), stamp(2), 'collected');
  repo.db.prepare('INSERT INTO observations VALUES(?,?,?,?,?,?,?,?)')
    .run('store-a', 'orders', target.orderId, 'older-run', old.observedAt, 'page-hash', 'record-hash', JSON.stringify(old));
  transaction('last-page-refund', [target.orderId]);
  const firstPage = returnsView({ db: repo.db, filters: { storeId: 'store-a', limit: 500 } });
  assert.equal(firstPage.total, 501); assert.equal(firstPage.hasMore, true);
  assert.ok(!firstPage.items.some(row => row.orderId === target.orderId));
  const row = repo.financialCases('refunds', { storeId: 'store-a', limit: 1 }).items[0];
  assert.deepEqual(row.returnLinks.returnedToSeller, [{ orderId: target.orderId, detectedAt: stamp(2), returnStatusChanged: true }]);
});
