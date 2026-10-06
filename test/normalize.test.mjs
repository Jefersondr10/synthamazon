import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInventory, normalizeOrders, normalizeTransactions } from '../src/domain/normalize.mjs';

const context = { storeId: 'test-store', observedAt: '2026-09-24T20:00:00-03:00' };
function transaction(overrides = {}) {
  return { transactionId: 'test-transaction', transactionType: 'Shipment', transactionStatus: 'RELEASED', postedDate: '2026-09-01T12:00:00Z', totalAmount: { currencyAmount: '80.00', currencyCode: 'BRL' }, relatedIdentifiers: [], breakdowns: [], items: [], ...overrides };
}
const txJson = (...rows) => JSON.stringify({ payload: { transactions: rows } });
const component = (kind, amount, children = []) => ({ breakdownType: kind, breakdownAmount: { currencyAmount: amount, currencyCode: 'BRL' }, breakdowns: children });

test('cancellation requires explicit field or trusted CANCELLED query, never empty money or zero quantity', () => {
  const missing = { orderId: 'zero-quantity', orderItems: [{ orderItemId: 'item', quantityOrdered: 0 }] };
  const raw = JSON.stringify({ orders: [missing] });
  assert.equal(normalizeOrders(raw, context)[0].status, null);
  const cancelled = normalizeOrders(raw, { ...context, fulfillmentStatusesQuery: ['CANCELLED'] })[0];
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(cancelled.statusEvidence.source, 'api-filter');
  assert.equal(cancelled.grandTotalCents, null);
  const conflicting = normalizeOrders(JSON.stringify({ orders: [{ ...missing, fulfillment: { fulfillmentStatus: 'SHIPPED' } }] }), { ...context, fulfillmentStatusesQuery: ['CANCELLED'] })[0];
  assert.equal(conflicting.status, null);
  assert.ok(conflicting.warnings.some(w => w.code === 'CONFLICTING_STATUS_FILTER'));
  assert.throws(() => normalizeOrders(raw, { ...context, fulfillmentStatusesQuery: ['CANCELLED', 'SHIPPED'] }), { code: 'INVALID_SNAPSHOT' });
});

test('native token parsing preserves amounts beyond Number precision and scientific notation', () => {
  const raw = '{"payload":{"transactions":[{"transactionId":"00123","transactionType":"Shipment","totalAmount":{"currencyAmount":9007199254740993.13,"currencyCode":"BRL"},"items":[]},{"transactionId":"exp","totalAmount":{"currencyAmount":1.23e2,"currencyCode":"BRL"}},{"transactionId":"cent","totalAmount":{"currencyAmount":1e-2,"currencyCode":"BRL"}}]}}';
  const rows = normalizeTransactions(raw, context);
  assert.equal(rows[0].totalCents, '900719925474099313');
  assert.equal(rows[0].transactionId, '00123');
  assert.equal(rows[1].totalCents, '12300');
  assert.equal(rows[2].totalCents, '1');
  assert.doesNotThrow(() => JSON.stringify(rows));
});

test('fees, refunds and transfers retain signed totals without summing tree levels', () => {
  const rows = normalizeTransactions(txJson(
    transaction({ breakdowns: [component('Sales', '100.00', [component('ProductCharges', '100.00')]), component('Expenses', '-20.00', [component('Commission', '-20.00')])] }),
    transaction({ transactionId: 'refund', transactionType: 'Refund', totalAmount: { currencyAmount: '-25.50', currencyCode: 'BRL' } }),
    transaction({ transactionId: 'transfer', transactionType: 'Transfer', totalAmount: { currencyAmount: '400.00', currencyCode: 'BRL' } }),
  ), context);
  assert.equal(rows[0].totalCents, '8000');
  assert.equal(rows[0].breakdowns[0].amountCents, '10000');
  assert.equal(rows[0].breakdowns[0].children[0].amountCents, '10000');
  assert.equal(rows[0].breakdowns[1].children[0].amountCents, '-2000');
  assert.equal(rows[1].totalCents, '-2550');
  assert.equal(rows[1].countsAsSales, false);
  assert.equal(rows[2].countsAsSales, false);
  assert.equal(rows[2].totalCents, '40000');
});

test('missing currency is never assumed from the store or transaction parent', () => {
  const [row] = normalizeTransactions(txJson(transaction({ totalAmount: { currencyAmount: '5.10' }, items: [{ totalAmount: { currencyAmount: '0', currencyCode: '' } }] })), context);
  assert.equal(row.totalCents, '510');
  assert.equal(row.currency, null);
  assert.equal(row.items[0].totalCents, '0');
  assert.equal(row.items[0].currency, null);
  assert.equal(row.warnings.filter(x => x.code === 'MISSING_CURRENCY').length, 2);
});

test('nonzero fractions of a cent are rejected rather than rounded or truncated', () => {
  const rows = normalizeTransactions(txJson(
    transaction({ totalAmount: { currencyAmount: '12.345', currencyCode: 'BRL' } }),
    transaction({ totalAmount: { currencyAmount: '-0.001', currencyCode: 'BRL' } }),
    transaction({ totalAmount: { currencyAmount: '12.3400', currencyCode: 'BRL' } }),
  ), context);
  assert.equal(rows[0].totalCents, null);
  assert.equal(rows[1].totalCents, null);
  assert.equal(rows[2].totalCents, '1234');
  assert.ok(rows[0].warnings.some(x => x.code === 'SUBCENT_AMOUNT'));
});

test('financial references and product contexts are retained while PII and descriptions are excluded', () => {
  const [row] = normalizeTransactions(txJson(transaction({
    description: 'PRIVATE-TEXT', buyer: { name: 'PRIVATE-NAME' },
    relatedIdentifiers: [{ relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: 'order-a' }, { relatedIdentifierName: 'SETTLEMENT_ID', relatedIdentifierValue: 'settlement-a' }, { relatedIdentifierName: 'FINANCIAL_EVENT_GROUP_ID', relatedIdentifierValue: 'group-a' }, { relatedIdentifierName: 'DEFERRED_TRANSACTION_ID', relatedIdentifierValue: 'deferred-a' }],
    items: [{ totalAmount: { currencyAmount: '80.00', currencyCode: 'BRL' }, relatedIdentifiers: [{ itemRelatedIdentifierName: 'ORDER_ADJUSTMENT_ITEM_ID', itemRelatedIdentifierValue: 'item-a' }, { itemRelatedIdentifierName: 'BUYER_EMAIL', itemRelatedIdentifierValue: 'PRIVATE-EMAIL' }], contexts: [{ contextType: 'ProductContext', sku: '0001', asin: 'asin-a', quantityShipped: 2, fulfillmentNetwork: 'AFN', buyerName: 'PRIVATE-NAME' }, { contextType: 'AddressContext', address: 'PRIVATE-ADDRESS' }] }],
  })), context);
  assert.deepEqual(row.orderIds, ['order-a']);
  assert.deepEqual(row.settlementIds, ['settlement-a']);
  assert.deepEqual(row.groupIds, ['group-a']);
  assert.deepEqual(row.deferredTransactionIds, ['deferred-a']);
  assert.equal(row.items[0].sku, '0001');
  assert.equal(row.items[0].quantityShipped, 2);
  assert.ok(row.warnings.some(x => x.code === 'UNSUPPORTED_IDENTIFIER'));
  assert.equal(JSON.stringify(row).includes('PRIVATE-'), false);
});

function order(overrides = {}) {
  return { orderId: 'test-order', createdTime: '2026-09-01T12:00:00Z', lastUpdatedTime: '2026-09-02T12:00:00Z', programs: [], orderItems: [{ orderItemId: 'item-a', quantityOrdered: 2, product: { sellerSku: '00123', asin: 'asin-a', title: 'Produto 123.45 e \\"texto\\"', price: { unitPrice: { amount: '10.01', currencyCode: 'BRL' } } }, proceeds: { proceedsTotal: { amount: '20.02', currencyCode: 'BRL' } } }], ...overrides };
}

test('order items preserve text, quantities, proceeds and independent partial-package relationships', () => {
  const [row] = normalizeOrders(JSON.stringify({ orders: [order({
    programs: ['DELIVERY_BY_AMAZON'], buyer: { buyerName: 'PRIVATE-NAME' }, recipient: { address: 'PRIVATE-ADDRESS' },
    proceeds: { grandTotal: { amount: '20.02', currencyCode: 'BRL' } },
    packages: [{ packageReferenceId: 'package-a', trackingNumber: 'tracking-a', packageStatus: { status: 'DELIVERED', detailedStatus: 'DELIVERED' }, packageItems: [{ orderItemId: 'item-a', quantity: 1 }] }, { packageReferenceId: 'package-b', packageStatus: { status: 'IN_TRANSIT' }, packageItems: [{ orderItemId: 'item-a', quantity: 1 }] }],
  })] }), context);
  assert.equal(row.fulfillmentMode, 'DBA');
  assert.equal(row.status, null);
  assert.equal(row.grandTotalCents, '2002');
  assert.equal(row.items[0].unitPriceCents, '1001');
  assert.equal(row.items[0].sku, '00123');
  assert.equal(row.items[0].title, order().orderItems[0].product.title);
  assert.equal(row.packages.length, 2);
  assert.equal(row.packages[0].items[0].quantity, 1);
  assert.equal(JSON.stringify(row).includes('PRIVATE-'), false);
});

test('mode and order status require explicit source evidence, not package or financial assumptions', () => {
  const rows = normalizeOrders(JSON.stringify({ orders: [
    order({ fulfillment: { fulfilledBy: 'AMAZON', fulfillmentStatus: 'SHIPPED' } }),
    order({ fulfillment: { fulfilledBy: 'MERCHANT' }, programs: ['AMAZON_EASY_SHIP'] }),
    order({ packages: [{ packageStatus: { status: 'DELIVERED' } }] }),
    order({ fulfillment: { fulfilledBy: 'AMAZON' }, programs: ['DELIVERY_BY_AMAZON'] }),
  ] }), context);
  assert.equal(rows[0].fulfillmentMode, 'FBA');
  assert.equal(rows[0].status, 'SHIPPED');
  assert.equal(rows[1].fulfillmentMode, 'MFN');
  assert.equal(rows[2].fulfillmentMode, 'unknown');
  assert.equal(rows[2].status, null);
  assert.equal(rows[2].grandTotalCents, null);
  assert.equal(rows[3].fulfillmentMode, 'unknown');
  assert.ok(rows[3].warnings.some(x => x.code === 'CONFLICTING_FULFILLMENT'));
});

test('AMAZON query identifies unpriced pending FBA orders without relying on proceeds or the fulfillment dataset', () => {
  const item = { ...order().orderItems[0], proceeds: undefined };
  const rows = normalizeOrders(JSON.stringify({ orders: [
    order({ fulfillment: { fulfillmentStatus: 'PENDING' }, orderItems: [item] }),
    order({ orderItems: [item] }),
  ] }), { ...context, fulfilledByQuery: ['AMAZON'] });
  for (const row of rows) {
    assert.equal(row.fulfilledBy, 'AMAZON');
    assert.equal(row.fulfillmentMode, 'FBA');
    assert.equal(row.grandTotalCents, null);
    assert.equal(row.items[0].proceedsCents, null);
    assert.deepEqual(row.fulfillmentEvidence, { source: 'api-filter', fulfilledBy: 'AMAZON' });
  }
  assert.equal(rows[0].status, 'PENDING');
  assert.equal(rows[1].status, null);
});

test('MERCHANT query requires an explicit program for DBA and legacy data remains unknown', () => {
  const rows = normalizeOrders(JSON.stringify({ orders: [
    order({ programs: ['DELIVERY_BY_AMAZON'] }),
    order(),
  ] }), { ...context, fulfilledByQuery: ['MERCHANT'] });
  assert.equal(rows[0].fulfillmentMode, 'DBA');
  assert.equal(rows[1].fulfillmentMode, 'MFN');
  for (const row of rows) assert.deepEqual(row.fulfillmentEvidence, { source: 'api-filter', fulfilledBy: 'MERCHANT' });
  const legacy = order();
  legacy.orderItems[0].product.sellerSku = 'FBA-labelled-but-not-evidence';
  const [unknown] = normalizeOrders(JSON.stringify({ orders: [legacy] }), context);
  assert.equal(unknown.fulfillmentMode, 'unknown');
  assert.equal(unknown.fulfilledBy, null);
  assert.equal(Object.hasOwn(unknown, 'fulfillmentEvidence'), false);
});

test('consistent explicit API fields provide evidence while field/filter and FBA/DBA contradictions remain unknown', () => {
  const [consistent] = normalizeOrders(JSON.stringify({ orders: [order({ fulfillment: { fulfilledBy: 'AMAZON' } })] }), { ...context, fulfilledByQuery: ['AMAZON'] });
  assert.deepEqual(consistent.fulfillmentEvidence, { source: 'api-field', fulfilledBy: 'AMAZON' });
  const cases = [
    { raw: { fulfilledBy: 'AMAZON' }, query: ['MERCHANT'], programs: [], code: 'CONFLICTING_FULFILLMENT_FILTER' },
    { raw: { fulfilledBy: 'MERCHANT' }, query: ['AMAZON'], programs: [], code: 'CONFLICTING_FULFILLMENT_FILTER' },
    { raw: undefined, query: ['AMAZON'], programs: ['DELIVERY_BY_AMAZON'], code: 'CONFLICTING_FULFILLMENT' },
    { raw: { fulfilledBy: 'AMAZON' }, query: undefined, programs: ['DELIVERY_BY_AMAZON'], code: 'CONFLICTING_FULFILLMENT' },
    { raw: { fulfilledBy: 'UNSUPPORTED' }, query: ['AMAZON'], programs: [], code: 'INVALID_FULFILLMENT' },
  ];
  for (const scenario of cases) {
    const [row] = normalizeOrders(JSON.stringify({ orders: [order({ fulfillment: scenario.raw, programs: scenario.programs })] }), { ...context, fulfilledByQuery: scenario.query });
    assert.equal(row.fulfilledBy, null);
    assert.equal(row.fulfillmentMode, 'unknown');
    assert.equal(Object.hasOwn(row, 'fulfillmentEvidence'), false);
    assert.ok(row.warnings.some(entry => entry.code === scenario.code));
  }
});

test('fulfilledBy query provenance rejects missing partition semantics even for empty responses', () => {
  for (const fulfilledByQuery of [null, 'AMAZON', [], ['AMAZON', 'MERCHANT'], ['AMAZON', 'AMAZON'], ['unknown'], {}]) {
    assert.throws(() => normalizeOrders('{"orders":[]}', { ...context, fulfilledByQuery }), { code: 'INVALID_SNAPSHOT' });
  }
  for (const fulfilledByQuery of [undefined, ['AMAZON'], ['MERCHANT']]) {
    assert.deepEqual(normalizeOrders('{"orders":[]}', { ...context, fulfilledByQuery }), []);
  }
});

test('FBA totals are not recomputed from overlapping research and nested components', () => {
  const [row] = normalizeInventory(JSON.stringify({ payload: { inventorySummaries: [{
    sellerSku: 'test-sku', asin: 'test-asin', fnSku: 'test-fnsku', condition: 'NewItem', productName: 'Produto fictício', totalQuantity: 8,
    inventoryDetails: { fulfillableQuantity: 3, inboundWorkingQuantity: 0, inboundShippedQuantity: 0, inboundReceivingQuantity: 0,
      reservedQuantity: { totalReservedQuantity: 4, pendingCustomerOrderQuantity: 2, pendingTransshipmentQuantity: 1, fcProcessingQuantity: 1 },
      researchingQuantity: { totalResearchingQuantity: 2, researchingQuantityBreakdown: [{ name: 'researchingQuantityInShortTerm', quantity: 2 }] },
      unfulfillableQuantity: { totalUnfulfillableQuantity: 1, customerDamagedQuantity: 1, warehouseDamagedQuantity: 0, distributorDamagedQuantity: 0, carrierDamagedQuantity: 0, defectiveQuantity: 0, expiredQuantity: 0 },
      futureSupplyQuantity: { reservedFutureSupplyQuantity: 0, futureSupplyBuyableQuantity: 0 } },
  }] } }), context);
  assert.equal(row.totalQuantity, 8);
  assert.equal(row.inventoryDetails.reservedQuantity.totalReservedQuantity, 4);
  assert.equal(row.inventoryDetails.researchingQuantity.totalResearchingQuantity, 2);
  assert.equal(row.updatedAt, null);
  assert.equal(row.warnings.length, 0);
});

test('invalid and truncated JSON fail closed with safe errors, and absent quantities are not zero', () => {
  for (const raw of ['{"payload":{"transactions":[', '{"payload":null}', '{"payload":{"transactions":[{"transactionId":"SECRET-DUMMY",', '[1,2]']) {
    assert.throws(() => normalizeTransactions(raw, context), error => error.code === 'INVALID_SNAPSHOT' && !error.message.includes('SECRET-DUMMY'));
  }
  assert.throws(() => normalizeOrders('{"orders":[{"orderId":"x"}]}', context), { code: 'INVALID_SNAPSHOT' });
  const [row] = normalizeInventory('{"payload":{"inventorySummaries":[{"sellerSku":"dummy","totalQuantity":9007199254740993}]}}', context);
  assert.equal(row.totalQuantity, null);
  assert.equal(row.inventoryDetails.fulfillableQuantity, null);
  assert.ok(row.warnings.some(x => x.code === 'INVALID_QUANTITY'));
});

test('optional transactions list accepts only a valid payload object, never an invalid envelope', () => {
  assert.deepEqual(normalizeTransactions('{"payload":{}}', context), []);
  assert.deepEqual(normalizeTransactions('{"payload":{"nextToken":"next-page"}}', context), []);
  for (const raw of ['{}', 'null', '{"payload":[]}', '{"payload":{"transactions":null}}', '{"payload":{"transactions":{}}}']) {
    assert.throws(() => normalizeTransactions(raw, context), { code: 'INVALID_SNAPSHOT' });
  }
  assert.throws(() => normalizeOrders('{}', context), { code: 'INVALID_SNAPSHOT' });
});

test('store and observation are mandatory and calendar dates are not silently normalized', () => {
  assert.throws(() => normalizeTransactions(txJson(), { ...context, storeId: '../other' }), { code: 'INVALID_SNAPSHOT' });
  assert.throws(() => normalizeTransactions(txJson(), { ...context, observedAt: '2026-02-30T00:00:00Z' }), { code: 'INVALID_SNAPSHOT' });
  const [row] = normalizeTransactions(txJson(transaction({ postedDate: '2026-02-30T00:00:00Z' })), context);
  assert.equal(row.postedAt, null);
  assert.equal(row.storeId, context.storeId);
  assert.equal(row.observedAt, '2026-09-24T23:00:00.000Z');
  assert.ok(row.warnings.some(x => x.code === 'INVALID_DATE'));
});
