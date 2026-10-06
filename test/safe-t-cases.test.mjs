import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSafeTCases } from '../src/domain/safe-t-cases.mjs';

const at = day => `2026-09-${String(day).padStart(2, '0')}T12:00:00.000Z`;
const order = (orderId, extra = {}) => ({ storeId: 'store-a', orderId, status: 'SHIPPED', fulfillmentMode: 'DBA',
  createdAt: '2026-01-01T12:00:00Z', packages: [{ packageReferenceId: 'p-a', status: 'IN_TRANSIT', detailedStatus: 'LOST' }],
  items: [{ sku: 'SKU  AZUL', asin: 'ASIN-A', title: 'Produto teste', quantityOrdered: 2 }], ...extra });
const refund = (caseId, orderIds, extra = {}) => ({ caseId, kind: 'refunds', type: 'Refund', storeId: 'store-a', orderIds,
  firstEventAt: at(3), lastEventAt: at(3), eventDateKnown: true, refundCount: 1,
  byCurrency: [{ currency: 'BRL', totalCents: '-10000' }], transactions: [{ originalPostedAt: at(3), postedAt: at(3) }], ...extra });
const report = (returnId, orderId, extra = {}) => ({ returnId, orderId, storeId: 'store-a', sku: 'SKU  AZUL', asin: 'ASIN-A',
  productName: 'Produto teste', quantity: 1, reportedRefundCents: '10000', currency: 'BRL', returnStatus: 'Approved',
  returnRequestedAt: at(2), returnReceivedAt: at(6), observedAt: at(20), reportType: 'GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE', ...extra });

test('financial and return evidence form one row per store/order without summing the same refund twice', () => {
  const input = { orders: [order('order-a'), order('order-a', { storeId: 'store-b' })],
    refundCases: [refund('refund-a', ['order-a']), refund('refund-a', ['order-a']),
      refund('refund-b', ['order-a'], { storeId: 'store-b', byCurrency: [{ currency: 'USD', totalCents: '-2500' }] }),
      refund('credit-only', ['credit-order'], { type: 'Adjustment' })],
    customerReturns: [report('r-a', 'order-a'), report('r-b', 'order-a', { asin: null }), report('r-a', 'order-a')],
    returnedToSeller: [{ storeId: 'store-a', orderId: 'order-a', detectedAt: at(8), returnStatusChanged: true }] };
  const before = JSON.stringify(input), result = buildSafeTCases(input);
  assert.equal(result.total, 2);
  const a = result.items.find(row => row.storeId === 'store-a'), b = result.items.find(row => row.storeId === 'store-b');
  assert.equal(a.refund.source, 'financial-transactions');
  assert.deepEqual(a.refund.byCurrency, [{ currency: 'BRL', totalCents: '-10000' }]);
  assert.equal(a.refund.count, 1);
  assert.deepEqual(a.refundCaseIds, ['refund-a']);
  assert.equal(a.customerReturns.length, 2);
  assert.equal(a.products.length, 1);
  assert.equal(a.products[0].quantityOrdered, 2);
  assert.equal(a.returnedToSeller.returnStatusChanged, true);
  assert.ok(!a.categoryCodes.includes('RETURNED_TO_SELLER'), 'Historical return is not the current lost status');
  assert.deepEqual(b.customerReturns, []); assert.equal(b.returnedToSeller, null);
  assert.deepEqual(b.refund.byCurrency, [{ currency: 'USD', totalCents: '-2500' }]);
  assert.equal(result.eligibilityAssessed, false);
  assert.equal(JSON.stringify(input), before);
});

test('report-only refunds require positive evidence, keep dates unknown and never sum repeated or ambiguous amounts', () => {
  const input = { customerReturns: [report('same-a', 'same'), report('same-b', 'same'),
    report('different-a', 'different'), report('different-b', 'different', { reportedRefundCents: '9000' }),
    report('zero', 'zero', { reportedRefundCents: '0' }), report('negative', 'negative', { reportedRefundCents: '-100' }),
    report('unknown', 'unknown', { reportedRefundCents: null }), report('old', 'no-longer-reported', { observedAt: at(10) }),
    report('old', 'no-longer-reported', { reportedRefundCents: '0', observedAt: at(20) }),
    report('fba', 'fba', { reportType: 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA' })] };
  const result = buildSafeTCases(input);
  assert.equal(result.total, 3);
  const same = result.items.find(row => row.orderId === 'same'), different = result.items.find(row => row.orderId === 'different');
  assert.equal(same.refund.source, 'return-report');
  assert.deepEqual(same.refund.byCurrency, [{ currency: 'BRL', totalCents: '10000' }]);
  assert.equal(same.refund.count, null); assert.equal(same.refund.dateKnown, false); assert.equal(same.refund.latestPostedAt, null);
  assert.equal(same.products[0].quantityOrdered, null);
  assert.equal(different.refund.byCurrency[0].totalCents, null);
  assert.equal(result.summary.withoutDateCount, 3);
  assert.equal(result.items.find(row => row.orderId === 'fba').fulfillmentMode, 'FBA');
  const dated = buildSafeTCases({ ...input, filters: { from: '2026-09-01', to: '2026-09-30' } });
  assert.equal(dated.total, 0);
  assert.equal(dated.summary.withoutDateCount, 3);
  assert.equal(buildSafeTCases({ ...input, filters: { from: '2026-09-01', to: '2026-09-30', query: 'different' } }).summary.withoutDateCount, 1);
  assert.equal(buildSafeTCases({ ...input, filters: { from: '2026-09-01', to: '2026-09-30', status: 'LOST' } }).summary.withoutDateCount, 0);
});

test('multi-order financial cases establish links without allocating their totals to each order', () => {
  const result = buildSafeTCases({ refundCases: [refund('shared', ['a', 'b', 'a'], {
    byCurrency: [{ currency: 'BRL', totalCents: '-900719925474099313' }] }), refund('single', ['a'], {
    byCurrency: [{ currency: 'BRL', totalCents: '-50' }, { currency: 'USD', totalCents: '-7' }] })],
    customerReturns: [report('r-a', 'a'), report('r-b', 'b')] });
  assert.equal(result.total, 2);
  const a = result.items.find(row => row.orderId === 'a'), b = result.items.find(row => row.orderId === 'b');
  assert.deepEqual(a.refund.byCurrency, [{ currency: 'BRL', totalCents: '-50' }, { currency: 'USD', totalCents: '-7' }]);
  assert.deepEqual(b.refund.byCurrency, []);
  assert.ok(result.items.every(row => row.refund.source === 'financial-transactions' && row.refund.allocation === 'multiple-orders-unallocated'));
  assert.deepEqual(a.refundCaseIds, ['shared', 'single']);
  assert.deepEqual(b.refundCaseIds, ['shared']);
});

test('periods use original refund dates rather than order, release, request or return dates', () => {
  const input = { orders: [order('a')], refundCases: [refund('a', ['a'], { refundCount: 2, lastEventAt: at(5),
    transactions: [{ originalPostedAt: at(3), postedAt: at(20) }, { originalPostedAt: at(5), postedAt: at(25) }] }),
    refund('undated', ['undated'], { firstEventAt: null, lastEventAt: null, eventDateKnown: false,
      transactions: [{ originalPostedAt: null, postedAt: at(20) }] })], customerReturns: [report('r', 'report-only', { returnReceivedAt: at(20) })] };
  assert.equal(buildSafeTCases(input).total, 3);
  assert.equal(buildSafeTCases(input).summary.withoutDateCount, 2);
  const result = buildSafeTCases({ ...input, filters: { from: '2026-09-05', to: '2026-09-05' } });
  assert.equal(result.total, 1); assert.equal(result.items[0].refund.count, 2);
  assert.equal(result.items[0].refund.latestPostedAt, at(5));
  assert.equal(buildSafeTCases({ ...input, filters: { from: '2026-09-20', to: '2026-09-25' } }).total, 0);
  const midnight = buildSafeTCases({ refundCases: [refund('early', ['early'], { firstEventAt: '2026-09-05T02:59:59Z', lastEventAt: '2026-09-05T02:59:59Z', transactions: [] })],
    filters: { from: '2026-09-05', to: '2026-09-05' } });
  assert.equal(midnight.total, 0);
});

test('operational categories honor explicit order states and preserve partial package evidence', () => {
  const input = { orders: [order('mixed', { packages: [{ detailedStatus: 'LOST' }, { detailedStatus: 'DELIVERED' }] }),
    order('cancelled', { status: 'CANCELLED', packages: [{ detailedStatus: 'RETURNED_TO_SELLER' }] }),
    order('pending', { status: 'PENDING', packages: [{ detailedStatus: 'DELIVERED' }] }),
    order('unshipped', { status: 'UNSHIPPED', packages: [{ detailedStatus: 'RETURNING_TO_SELLER' }] }),
    order('returned', { packages: [{ detailedStatus: 'RETURNED_TO_SELLER' }, { detailedStatus: 'PICKED_UP' }] })],
    refundCases: ['mixed', 'cancelled', 'pending', 'unshipped', 'returned'].map(id => refund(id, [id])) };
  const result = buildSafeTCases(input), rows = Object.fromEntries(result.items.map(row => [row.orderId, row]));
  assert.equal(rows.mixed.displayStatus.partial, true);
  assert.deepEqual(new Set(rows.mixed.categoryCodes), new Set(['MULTIPLE_PACKAGE_STATUSES', 'LOST', 'DELIVERED']));
  assert.deepEqual(rows.cancelled.categoryCodes, ['CANCELLED']);
  assert.deepEqual(rows.pending.categoryCodes, ['PENDING']);
  assert.deepEqual(rows.unshipped.categoryCodes, ['UNSHIPPED']);
  assert.equal(rows.returned.displayStatus.partial, true);
  assert.ok(rows.returned.categoryCodes.includes('RETURNED_TO_SELLER') && rows.returned.categoryCodes.includes('PICKED_UP'));
  const packageOnly = buildSafeTCases({orders:[order('package-pending',{status:null,packages:[{status:'PENDING'}]})],refundCases:[refund('package-pending',['package-pending'])]}).items[0];
  assert.deepEqual(packageOnly.categoryCodes,['PACKAGE_PENDING']);
  assert.equal(packageOnly.financialEligibility.included,true);
});

test('status OR unions do not duplicate rows and facets precede status selection and pagination only', () => {
  const input = { orders: [order('both'), order('lost'), order('return', { packages: [{ detailedStatus: 'DELIVERED' }] }),
    order('outside-store', { storeId: 'store-b' }), order('outside-mode', { fulfillmentMode: 'FBA' }), order('outside-query', { items: [{ sku: 'OUTRO' }] }), order('outside-date')],
    refundCases: ['both', 'lost', 'return', 'outside-mode', 'outside-query'].map(id => refund(id, [id])).concat([
      refund('outside-store', ['outside-store'], { storeId: 'store-b' }), refund('outside-date', ['outside-date'], { firstEventAt: at(20), lastEventAt: at(20), transactions: [] })]),
    customerReturns: [report('both-r', 'both'), report('return-r', 'return', { returnStatus: 'Open', returnReceivedAt: null })] };
  const filters = { storeId: 'store-a', mode: 'DBA', query: 'sku azul', from: '2026-09-01', to: '2026-09-05', status: 'CUSTOMER_RETURN,LOST', limit: 1, offset: 1 };
  const result = buildSafeTCases({ ...input, filters });
  assert.equal(result.total, 3); assert.equal(result.items.length, 1); assert.equal(result.hasMore, true);
  assert.equal(result.summary.availableOrderCount, 3);
  assert.equal(result.statusOptions.find(item => item.code === 'LOST').count, 2);
  assert.equal(result.statusOptions.find(item => item.code === 'CUSTOMER_RETURN').count, 2);
  assert.equal(result.statusOptions.find(item => item.code === 'OPEN_RETURN').count, 1);
  const narrower = buildSafeTCases({ ...input, filters: { ...filters, status: 'LOST', offset: 0 } });
  assert.equal(narrower.total, 2);
  assert.deepEqual(narrower.statusOptions, result.statusOptions);
  assert.equal(input.orders[0].items[0].sku, 'SKU  AZUL');
});

test('open returns require an explicit current open status and optional facets show only available or selected variations', () => {
  const input = { customerReturns: ['Open', 'Aberta', 'Em aberto', 'Approved', 'Authorized', 'Opened', 'Concluído', null]
    .map((returnStatus, index) => report(`r-${index}`, `o-${index}`, { returnStatus, returnReceivedAt: null })) };
  const result = buildSafeTCases(input);
  assert.equal(result.statusOptions.find(option => option.code === 'OPEN_RETURN').count, 3);
  assert.equal(result.statusOptions.find(option => option.code === 'CUSTOMER_RETURN').count, 8);
  assert.ok(result.statusOptions.some(option => option.code === 'UNKNOWN'));
  assert.ok(!result.statusOptions.some(option => option.code === 'AT_ORIGIN_FC'));
  const selected = buildSafeTCases({ ...input, filters: { status: 'AT_ORIGIN_FC' } });
  assert.equal(selected.total, 0);
  assert.equal(selected.statusOptions.find(option => option.code === 'AT_ORIGIN_FC').count, 0);
  const unknown = buildSafeTCases({ orders: [order('future', { packages: [{ detailedStatus: 'Future status/v2' }] })], refundCases: [refund('future', ['future'])] });
  const option = unknown.statusOptions.find(item => item.label === 'Future status/v2');
  assert.match(option.code, /^OTHER_STATUS_[A-F0-9]{16}$/);
  assert.equal(buildSafeTCases({ orders: [order('future', { packages: [{ detailedStatus: 'Future status/v2' }] })], refundCases: [refund('future', ['future'])], filters: { status: option.code } }).total, 1);
});

test('return signals use each store latest request record and preserve current versus historical package counts', () => {
  const input = { orders: [order('same'), order('same', { storeId: 'store-b' })],
    refundCases: [refund('a', ['same']), refund('b', ['same'], { storeId: 'store-b' })],
    customerReturns: [report('shared-return', 'same', { returnStatus: 'Open', returnReceivedAt: null, observedAt: at(10) }),
      report('shared-return', 'same', { returnStatus: 'Closed', returnReceivedAt: null, observedAt: at(20) }),
      report('approved', 'same', { returnStatus: 'Approved', returnReceivedAt: null }),
      report('shared-return', 'same', { storeId: 'store-b', returnStatus: 'Open', returnReceivedAt: null })],
    returnedToSeller: [{ storeId: 'store-a', orderId: 'same', detectedAt: at(8), statusObservedAt: at(20),
      returnStatusChanged: true, currentReturnedPackageCount: 1, returnedPackageCount: 2, packageCount: 2, partialReturn: false }] };
  const result = buildSafeTCases(input), a = result.items.find(row => row.storeId === 'store-a'), b = result.items.find(row => row.storeId === 'store-b');
  assert.equal(a.returnSignals.openCustomerReturns.length, 0);
  assert.deepEqual(a.returnSignals.unknownCustomerReturns.map(row => row.returnId), ['approved']);
  assert.ok(!a.categoryCodes.includes('OPEN_RETURN'));
  assert.equal(a.returnSignals.returnedToSeller.current, true);
  assert.equal(a.returnSignals.returnedToSeller.historical, true);
  assert.equal(a.returnSignals.returnedToSeller.partial, true);
  assert.equal(a.returnSignals.returnedToSeller.returnStatusChanged, true);
  assert.equal(a.customerReturns.find(row => row.returnId === 'shared-return').returnStatus, 'Closed');
  assert.equal(a.customerReturns.find(row => row.returnId === 'shared-return').observedAt, at(20));
  assert.equal(a.customerReturns[0].reportType, 'GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE');
  assert.equal(b.returnSignals.openCustomerReturns.length, 1);
  assert.equal(b.returnSignals.returnedToSeller.historical, false);
  assert.ok(b.categoryCodes.includes('OPEN_RETURN'));
  assert.equal(result.statusOptions.find(row => row.code === 'OPEN_RETURN').count, 1);
});

test('malformed selections, dates, types and pagination fail without changing input evidence', () => {
  for (const filters of [{ status: null }, { status: {} }, { status: '' }, { status: 'LOST,LOST' }, { status: 'LOST,lost' },
    { status: 'all,LOST' }, { status: 'LOST,' }, { status: 'LOST, DELIVERED' }, { status: Array(51).fill('LOST').join(',') },
    { from: '2026-02-30' }, { from: null }, { from: '2026-09-20', to: '2026-09-03' }, { mode: null }, { mode: 'other' },
    { storeId: '../outside' }, { storeId: null }, { query: {} }, { limit: 0 }, { limit: 501 }, { offset: -1 }, { limit: null }]) {
    assert.throws(() => buildSafeTCases({ filters }), { code: 'INVALID_PARAMETERS' });
  }
  assert.deepEqual(buildSafeTCases().items, []);
  assert.equal(buildSafeTCases({ filters: { status: 'ALL', mode: 'all' } }).summary.orderCount, 0);
});
