import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { saveLocalReview } from '../src/domain/local-reviews.mjs';
import {
  ensureCustomerReturnSchema, saveCustomerReturnJob, customerReturnJobs,
  importCustomerReturnReport, customerReturnsView,
} from '../src/domain/customer-returns.mjs';

const MFN = 'GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE';
const FBA = 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA';
const at = day => `2026-09-${String(day).padStart(2, '0')}T12:00:00.000Z`;
const record = (extra = {}) => ({ orderId: 'order-a', sku: 'SKU-A', asin: 'ASIN-A',
  productName: 'Produto de teste', quantity: 1, returnRequestedAt: '2026-09-02',
  returnReceivedAt: null, returnStatus: 'Approved', reasonCode: 'DEFECTIVE',
  rmaId: 'RMA-A', trackingNumber: 'RETURN-A', ...extra });
const order = (extra = {}) => ({ storeId: 'store-a', orderId: 'order-a', fulfillmentMode: 'DBA',
  trackingObservedAt: at(8), items: [{ sku: 'SKU-A', asin: 'ASIN-A', title: 'Título interno' }],
  packages: [{ trackingNumber: 'RETURN-A', status: 'DELIVERED', detailedStatus: 'RETURNED_TO_SELLER' }], ...extra });
function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  ensureCustomerReturnSchema(db);
  return db;
}
function job(db, extra = {}) {
  const value = { storeId: 'store-a', reportId: 'report-a', reportType: MFN,
    from: '2026-09-01T00:00:00Z', to: '2026-09-30T23:59:59Z',
    status: 'DONE', createdAt: at(5), checkedAt: at(6), ...extra };
  saveCustomerReturnJob(db, value); return value;
}
function ingest(db, records, extra = {}) {
  const value = job(db, extra);
  return importCustomerReturnReport(db, { storeId: value.storeId, reportId: value.reportId,
    reportType: value.reportType, records, observedAt: value.checkedAt });
}
const view = (db, extra = {}) => customerReturnsView({ db, ...extra });

test('schema and job updates are idempotent, store-scoped and do not persist arbitrary error text', t => {
  const db = fixture(t); ensureCustomerReturnSchema(db);
  job(db, { status: 'IN_QUEUE' });
  job(db, { status: 'FAILED', checkedAt: at(7), errorCode: 'Unauthorized contact person@example.invalid', recordCount: 2 });
  job(db, { storeId: 'store-b', status: 'IN_PROGRESS' });
  assert.equal(customerReturnJobs(db, 'store-a').length, 1);
  assert.equal(customerReturnJobs(db, 'store-b')[0].status, 'IN_PROGRESS');
  assert.equal(customerReturnJobs(db, 'store-a')[0].status, 'FAILED');
  assert.equal(customerReturnJobs(db, 'store-a')[0].errorCode, null);
  job(db, { status: 'FATAL', checkedAt: at(8), errorCode: 'REPORT_FAILED' });
  assert.equal(customerReturnJobs(db, 'store-a')[0].errorCode, 'REPORT_FAILED');
  assert.equal(customerReturnJobs(db, 'store-a')[0].recordCount, 2);
  assert.throws(() => customerReturnJobs(db, '../store'), { code: 'INVALID_PARAMETERS' });
  assert.throws(() => job(db, { reportType: 'UNKNOWN_REPORT' }), { code: 'INVALID_PARAMETERS' });
});

test('overlapping reports update evidence without duplicating cases or losing identical-row multiplicity', t => {
  const db = fixture(t), repeated = [record(), record()];
  assert.deepEqual(ingest(db, repeated), { imported: true, recordCount: 2 });
  const originalIds = view(db).items.map(row => row.returnId).sort();
  assert.equal(new Set(originalIds).size, 2);
  assert.deepEqual(importCustomerReturnReport(db, { storeId: 'store-a', reportId: 'report-a', reportType: MFN,
    records: [record({ returnStatus: 'Unexpected overwrite' })], observedAt: at(9) }), { imported: false, recordCount: 2 });
  assert.ok(view(db).items.every(row => row.returnStatus === 'Approved'));
  ingest(db, [record({ returnStatus: 'Closed' }), record({ returnStatus: 'Closed' })], { reportId: 'report-b', checkedAt: at(10) });
  assert.deepEqual(view(db).items.map(row => row.returnId).sort(), originalIds);
  assert.ok(view(db).items.every(row => row.returnStatus === 'Closed' && row.observedAt === at(10)));
  ingest(db, repeated, { reportId: 'report-older', checkedAt: at(7) });
  assert.ok(view(db).items.every(row => row.returnStatus === 'Closed'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customer_return_observations').get().n, 6);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customer_return_records WHERE first_observed_at=?').get(at(6)).n, 2);
});

test('an invalid record prevents partial report persistence and leaves the job available for retry', t => {
  const db = fixture(t); job(db);
  assert.throws(() => importCustomerReturnReport(db, { storeId: 'store-a', reportId: 'report-a', reportType: MFN,
    records: [record(), { sku: 'SKU-WITHOUT-IDENTITY' }], observedAt: at(6) }), { code: 'INVALID_PARAMETERS' });
  assert.equal(view(db).total, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customer_return_observations').get().n, 0);
  assert.equal(customerReturnJobs(db, 'store-a')[0].status, 'DONE');
  assert.equal(importCustomerReturnReport(db, { storeId: 'store-a', reportId: 'report-a', reportType: MFN,
    records: [record()], observedAt: at(6) }).recordCount, 1);
});

test('the same order and report identifiers cannot cross stores in enrichment, refunds or detail lookup', t => {
  const db = fixture(t);
  ingest(db, [record({ productName: null })]);
  ingest(db, [record({ productName: null })], { storeId: 'store-b' });
  const orders = [order(), order({ storeId: 'store-b', fulfillmentMode: 'MFN', items: [{ sku: 'SKU-A', title: 'Outra loja' }] })];
  const refundCases = [{ storeId: 'store-b', orderIds: ['order-a'], refundCount: 1, lastEventAt: at(3), eventDateKnown: true,
    byCurrency: [{ currency: 'BRL', totalCents: '-100' }] }];
  const a = view(db, { orders, refundCases, filters: { storeId: 'store-a' } }).items[0];
  const b = view(db, { orders, refundCases, filters: { storeId: 'store-b' } }).items[0];
  assert.equal(a.productName, 'Título interno'); assert.equal(a.fulfillmentMode, 'DBA');
  assert.equal(b.productName, 'Outra loja'); assert.equal(b.fulfillmentMode, 'MFN');
  assert.equal(a.refund.status, 'not_found'); assert.equal(b.refund.status, 'recorded');
  assert.notEqual(a.returnId, b.returnId);
  assert.equal(view(db, { orders, filters: { storeId: 'store-a' }, returnId: b.returnId }), null);
  assert.equal(view(db, { filters: { storeId: 'all' } }).total, 2);
  assert.throws(() => view(db, { returnId: a.returnId }), { code: 'INVALID_PARAMETERS' });
});

test('FBA is evidenced by its report while merchant returns require explicit local DBA or MFN evidence', t => {
  const db = fixture(t);
  ingest(db, ['dba', 'own', 'fba-local', 'missing'].map(id => record({ orderId: id, rmaId: `RMA-${id}` })));
  ingest(db, [record({ orderId: 'fba-report', returnReceivedAt: '2026-09-04' })], { reportId: 'fba-report', reportType: FBA });
  const orders = [order({ orderId: 'dba' }), order({ orderId: 'own', fulfillmentMode: 'MFN' }),
    order({ orderId: 'fba-local', fulfillmentMode: 'FBA' }), order({ orderId: 'fba-report', fulfillmentMode: 'DBA' })];
  const rows = view(db, { orders }).items;
  const modes = Object.fromEntries(rows.map(row => [row.orderId, row.fulfillmentMode]));
  assert.deepEqual(modes, { 'fba-report': 'FBA', dba: 'DBA', own: 'MFN', 'fba-local': 'unknown', missing: 'unknown' });
  assert.equal(view(db, { orders, filters: { mode: 'DBA' } }).total, 1);
  assert.equal(view(db, { orders, filters: { mode: 'unknown' } }).total, 2);
});

test('reverse tracking requires an exact code match and never adopts outbound status by order alone', t => {
  const db = fixture(t);
  ingest(db, [record(), record({ rmaId: 'RMA-OUTBOUND', trackingNumber: 'OTHER-RETURN' }),
    record({ rmaId: 'RMA-NO-CODE', trackingNumber: null }), record({ rmaId: 'RMA-CASE', trackingNumber: 'return-a' })]);
  const rows = view(db, { orders: [order({ packages: [{ trackingNumber: 'RETURN-A', status: 'DELIVERED', detailedStatus: 'RETURNED_TO_SELLER' },
    { trackingNumber: 'OUTBOUND', status: 'DELIVERED' }] })] }).items;
  const matched = rows.find(row => row.rmaId === 'RMA-A');
  assert.equal(matched.tracking.status, 'RETURNED_TO_SELLER');
  assert.equal(matched.tracking.source, 'order-package-match');
  assert.equal(matched.tracking.updatedAt, null);
  assert.equal(matched.tracking.observedAt, at(8));
  for (const row of rows.filter(row => row !== matched)) {
    assert.equal(row.returnStatus, 'Approved');
    assert.equal(row.tracking.status, null); assert.equal(row.tracking.label, null);
    assert.equal(row.tracking.observedAt, null); assert.equal(row.tracking.source, 'not_available');
  }
  const conflict = view(db, { orders: [order({ packages: [{ trackingNumber: 'RETURN-A', status: 'DELIVERED' },
    { trackingNumber: 'RETURN-A', status: 'IN_TRANSIT' }] })] }).items.find(row => row.rmaId === 'RMA-A');
  assert.equal(conflict.tracking.status, null);
});

test('unknown columns, comments and contact data never reach records or observation history', t => {
  const db = fixture(t);
  const sentinels = ['person@example.invalid', 'PRIVATE-CUSTOMER-COMMENT', 'PRIVATE-BUYER-NAME', 'PRIVATE-ADDRESS'];
  ingest(db, [record({ buyerEmail: sentinels[0], customerComments: sentinels[1], buyerName: sentinels[2],
    shippingAddress: { street: sentinels[3] }, unknownField: sentinels.join('|') })]);
  const records = db.prepare('SELECT payload_json FROM customer_return_records').all();
  const observations = db.prepare('SELECT payload_json FROM customer_return_observations').all();
  for (const value of [...records, ...observations, ...view(db).items]) {
    const serialized = JSON.stringify(value);
    for (const secret of sentinels) assert.equal(serialized.includes(secret), false);
  }
  assert.equal(view(db).items[0].reasonCode, 'DEFECTIVE');
});

test('reason fields retain only bounded uppercase operational codes, never free-form customer text', t => {
  const db = fixture(t);
  const cases = ['CUSTOMER_DAMAGED', 'OTHER_42', 'CR-DEFECTIVE', 'RETURN:OTHER', 'Customer said call 555-0100', 'buyer@example.invalid', 'x'.repeat(121), 'OTHER\nCOMMENT'];
  ingest(db, cases.map((reasonCode, i) => record({ orderId: `reason-${i}`, rmaId: `RMA-${i}`, reasonCode })));
  const byOrder = Object.fromEntries(view(db).items.map(row => [row.orderId, row.reasonCode]));
  assert.equal(byOrder['reason-0'], 'CUSTOMER_DAMAGED'); assert.equal(byOrder['reason-1'], 'OTHER_42');
  assert.equal(byOrder['reason-2'], 'CR-DEFECTIVE'); assert.equal(byOrder['reason-3'], 'RETURN:OTHER');
  for (let i = 4; i < cases.length; i++) assert.equal(byOrder[`reason-${i}`], null);
});

test('financial refund projections use original event counts and dates without adding release movements', t => {
  const db = fixture(t); ingest(db, [record()]);
  const refundCases = [{ storeId: 'store-a', orderIds: ['order-a'], refundCount: 1, movementCount: 2,
    lastEventAt: at(3), lastMovementAt: at(20), eventDateKnown: true,
    byCurrency: [{ currency: 'BRL', totalCents: '-900719925474099313' }],
    transactions: [{ transactionId: 'original', postedAt: at(3) }, { transactionId: 'release', postedAt: at(20), isReleaseMovement: true }] },
  { storeId: 'store-a', orderIds: ['order-a', 'order-b'], refundCount: 10, lastEventAt: at(22), eventDateKnown: true, byCurrency: [] }];
  const before = JSON.stringify(refundCases), row = view(db, { refundCases }).items[0];
  assert.equal(row.refund.status, 'recorded'); assert.equal(row.refund.source, 'financial-transactions');
  assert.equal(row.refund.count, 1); assert.equal(row.refund.latestPostedAt, at(3));
  assert.equal(row.refund.byCurrency[0].totalCents, '-900719925474099313');
  assert.equal(JSON.stringify(refundCases), before);
  const undated = view(db, { refundCases: [{ ...refundCases[0], lastEventAt: null, eventDateKnown: false }] }).items[0];
  assert.equal(undated.refund.latestPostedAt, null); assert.equal(undated.refund.hasUnknownOriginalDate, true);
});

test('a positive report refund is evidence without fabricating a financial event or date, and finance takes precedence', t => {
  const db = fixture(t);
  ingest(db, [record({ reportedRefundCents: '12345', currency: 'BRL' }),
    record({ orderId: 'unknown-currency', rmaId: 'RMA-UNKNOWN', reportedRefundCents: '120', currency: null }),
    record({ orderId: 'zero', rmaId: 'RMA-ZERO', reportedRefundCents: '0', currency: 'BRL' }),
    record({ orderId: 'negative', rmaId: 'RMA-NEGATIVE', reportedRefundCents: '-10', currency: 'BRL' })]);
  const rows = view(db).items;
  const positive = rows.find(row => row.orderId === 'order-a').refund;
  assert.equal(positive.status, 'recorded'); assert.equal(positive.source, 'return-report');
  assert.equal(positive.count, null); assert.equal(positive.latestPostedAt, null); assert.equal(positive.hasUnknownOriginalDate, true);
  assert.equal(positive.byCurrency[0].totalCents, '12345'); assert.equal(positive.byCurrency[0].currency, 'BRL');
  const unknown = rows.find(row => row.orderId === 'unknown-currency').refund;
  assert.equal(unknown.status, 'recorded'); assert.deepEqual(unknown.byCurrency, []);
  for (const id of ['zero', 'negative']) assert.equal(rows.find(row => row.orderId === id).refund.status, 'not_found');
  assert.equal(view(db, { filters: { refund: 'recorded' } }).total, 2);
  const finance = view(db, { refundCases: [{ storeId: 'store-a', orderIds: ['order-a'], refundCount: 1,
    lastEventAt: at(4), eventDateKnown: true, byCurrency: [{ currency: 'BRL', totalCents: '-5432' }] }] }).items.find(row => row.orderId === 'order-a').refund;
  assert.equal(finance.source, 'financial-transactions'); assert.equal(finance.byCurrency[0].totalCents, '-5432');
  assert.equal(finance.reportedRefundCents, '12345');
});

test('date filters preserve report dates, use Brasília for instants and expose missing dates explicitly', t => {
  const db = fixture(t);
  ingest(db, [record({ orderId: 'date-only', rmaId: 'RMA-DATE', returnRequestedAt: '2026-09-01' }),
    record({ orderId: 'brt-last-minute', rmaId: 'RMA-BRT', returnRequestedAt: '2026-09-02T02:59:59Z' }),
    record({ orderId: 'next-day', rmaId: 'RMA-NEXT', returnRequestedAt: '2026-09-02T03:00:00Z' }),
    record({ orderId: 'undated', rmaId: 'RMA-UNDATED', returnRequestedAt: null })]);
  ingest(db, [record({ orderId: 'fba-date', returnRequestedAt: '2026-09-01', returnReceivedAt: '2026-09-03' })], { reportId: 'fba', reportType: FBA });
  const first = view(db, { filters: { from: '2026-09-01', to: '2026-09-01' } });
  assert.deepEqual(first.items.map(row => row.orderId).sort(), ['brt-last-minute', 'date-only']);
  assert.equal(first.summary.undatedExcludedCount, 1);
  assert.equal(view(db, { filters: { from: '2026-09-03', to: '2026-09-03' } }).items[0].orderId, 'fba-date');
  assert.equal(view(db).total, 5); assert.equal(view(db).summary.undatedExcludedCount, 0);
  const paged = view(db, { filters: { offset: 1, limit: 2 } }); assert.equal(paged.items.length, 2); assert.equal(paged.total, 5); assert.equal(paged.hasMore, true);
  assert.equal(view(db, { filters: { query: ' sku-a ' } }).total, 5);
});

test('pending payments keep return evidence and notes but cannot enter refund counts or filters', t => {
  const db = fixture(t);
  const reported = record({ reportedRefundCents: '900719925474099313', currency: 'BRL' });
  ingest(db, [reported, record({ orderId: 'preorder', rmaId: 'RMA-PREORDER', reportedRefundCents: '500', currency: 'BRL' }),
    record({ orderId: 'unpaid-no-refund', rmaId: 'RMA-NONE' }), record({ orderId: 'ship-wait', rmaId: 'RMA-SHIP', reportedRefundCents: '300', currency: 'BRL' })]);
  ingest(db, [reported], { storeId: 'store-b' });
  const orders = [order({ status: ' pending ' }), order({ orderId: 'preorder', status: 'PENDING_AVAILABILITY' }),
    order({ orderId: 'unpaid-no-refund', status: 'PENDING' }), order({ orderId: 'ship-wait', status: 'UNSHIPPED' }),
    order({ storeId: 'store-b', status: 'SHIPPED' })];
  const refundCases = [{ storeId: 'store-a', orderIds: ['order-a'], refundCount: 1, lastEventAt: at(4), eventDateKnown: true,
    byCurrency: [{ currency: 'BRL', totalCents: '-900719925474099313' }] }];
  const initial = view(db, { orders, refundCases }), excluded = initial.items.find(row => row.storeId === 'store-a' && row.orderId === 'order-a');
  saveLocalReview(db, { menu: 'customer-returns', storeId: 'store-a', entityId: excluded.returnId,
    status: 'in_review', notes: 'Conferência preservada.', expectedVersion: 0, now: at(9) });
  const before = JSON.stringify(db.prepare('SELECT * FROM customer_return_records').all());
  const result = view(db, { orders, refundCases, filters: { limit: 1 } });
  assert.equal(result.total, 5); assert.equal(result.items.length, 1);
  assert.equal(result.summary.excludedPaymentPendingCount, 3);
  assert.equal(result.summary.refundedCount, 2); assert.equal(result.summary.withoutRefundCount, 0);
  const detail = view(db, { orders, refundCases, filters: { storeId: 'store-a' }, returnId: excluded.returnId });
  assert.deepEqual(detail.financialEligibility, { included: false, reason: 'payment-pending' });
  assert.deepEqual(detail.refund.financialEligibility, detail.financialEligibility);
  assert.equal(detail.refund.status, 'recorded');
  assert.equal(detail.refund.byCurrency[0].totalCents, '-900719925474099313');
  assert.equal(detail.refund.reportedRefundCents, '900719925474099313');
  assert.equal(detail.returnStatus, 'Approved'); assert.equal(detail.tracking.status, 'RETURNED_TO_SELLER');
  assert.equal(detail.review.notes, 'Conferência preservada.'); assert.equal(detail.reviewHistory.length, 1);
  assert.equal(view(db, { orders, refundCases, filters: { refund: 'recorded' } }).total, 2);
  assert.equal(view(db, { orders, refundCases, filters: { refund: 'not_found' } }).total, 0);
  assert.equal(view(db, { orders, refundCases, filters: { storeId: 'store-a' } }).summary.refundedCount, 1);
  assert.equal(view(db, { orders, refundCases, filters: { storeId: 'store-b' } }).summary.refundedCount, 1);
  const released = view(db, { orders: orders.map(row => ({ ...row, status: 'UNSHIPPED' })), refundCases });
  assert.equal(released.summary.excludedPaymentPendingCount, 0); assert.equal(released.summary.refundedCount, 4);
  assert.equal(released.summary.withoutRefundCount, 1);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM customer_return_records').all()), before);
});

test('an excluded mixed-order refund cannot re-enter via a report amount on an eligible order', t => {
  const db = fixture(t);
  ingest(db, [record({ reportedRefundCents: '5000', currency: 'BRL' })]);
  ingest(db, [record({ reportedRefundCents: '5000', currency: 'BRL' })], { storeId: 'store-b' });
  const orders = [order({ status: 'SHIPPED' }), order({ storeId: 'store-b', status: 'SHIPPED' })];
  const refundCases = [{ storeId: 'store-a', orderIds: ['order-a', 'pending-other'],
    financialEligibility: { included: false, reason: 'payment-pending' }, byCurrency: [{ currency: 'BRL', totalCents: '-10000' }] }];
  const before = JSON.stringify({ orders, refundCases });
  const result = view(db, { orders, refundCases });
  const excluded = result.items.find(row => row.storeId === 'store-a');
  assert.equal(excluded.financialEligibility.included, false);
  assert.equal(excluded.refund.source, 'return-report'); assert.equal(excluded.refund.byCurrency[0].totalCents, '5000');
  assert.equal(result.summary.excludedPaymentPendingCount, 1); assert.equal(result.summary.refundedCount, 1);
  assert.equal(result.items.find(row => row.storeId === 'store-b').financialEligibility.included, true);
  assert.equal(JSON.stringify({ orders, refundCases }), before);
});

test('impossible calendar dates and ISO clock or zone values are not silently normalized', t => {
  const db = fixture(t);
  for (const value of ['2026-02-30T12:00:00Z', '2026-09-01T24:00:00Z', '2026-09-01T12:00:00+24:00']) {
    assert.throws(() => job(db, { createdAt: value }), { code: 'INVALID_PARAMETERS' });
  }
  ingest(db, [record({ returnRequestedAt: '2026-02-30' }), record({ rmaId: 'RMA-BAD-INSTANT', returnRequestedAt: '2026-02-30T12:00:00Z' })]);
  assert.ok(view(db).items.every(row => row.requestedAt === null));
  assert.throws(() => view(db, { filters: { from: '2026-02-30' } }), { code: 'INVALID_PARAMETERS' });
});

test('coverage distinguishes missing, queued, imported and failed sources without discarding prior records', t => {
  const db = fixture(t);
  assert.equal(view(db).coverage.state, 'missing');
  assert.ok(view(db).coverage.sources.every(source => source.status === 'NOT_COLLECTED'));
  job(db, { status: 'IN_QUEUE' });
  assert.equal(view(db).coverage.state, 'partial');
  assert.equal(view(db).total, 0);
  importCustomerReturnReport(db, { storeId: 'store-a', reportId: 'report-a', reportType: MFN, records: [record()], observedAt: at(6) });
  ingest(db, [], { reportId: 'fba-empty', reportType: FBA });
  assert.equal(view(db, { filters: { storeId: 'store-a' } }).coverage.state, 'available');
  job(db, { reportId: 'latest-failed', status: 'FATAL', checkedAt: at(9), errorCode: 'REPORT_FAILED' });
  const result = view(db, { filters: { storeId: 'store-a' } });
  assert.equal(result.coverage.state, 'partial'); assert.equal(result.total, 1);
  const mfn = result.coverage.sources.find(source => source.reportType === MFN);
  assert.equal(mfn.status, 'FATAL'); assert.equal(mfn.errorCode, 'REPORT_FAILED'); assert.equal(mfn.observedAt, at(6));
  assert.equal(view(db, { filters: { storeId: 'store-b' } }).coverage.state, 'missing');
});
