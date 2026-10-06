import test from 'node:test';
import assert from 'node:assert/strict';
import { salesRevenue } from '../src/domain/sales-revenue.mjs';
import { refundEventCount } from '../src/domain/financial-cases.mjs';

const node = (kind, amountCents, children = [], currency = 'BRL') => ({ kind, amountCents, children, currency });
const order = (orderId = 'a', extra = {}) => ({ storeId: 'store-a', orderId, status: 'SHIPPED', currency: 'BRL',
  grandTotalCents: '22000', breakdowns: [node('ITEM', '20000'), node('SHIPPING', '2000')],
  items: [{ quantityOrdered: 2, unitPriceCents: '10000', unitPriceCurrency: 'BRL', breakdowns: [node('ITEM', '20000')] }], ...extra });
const tx = (type = 'Shipment', extra = {}) => ({ storeId: 'store-a', type, transactionId: 'sale', orderIds: ['a'], status: 'RELEASED',
  currency: 'BRL', totalCents: '18000', breakdowns: [], items: [], ...extra });

test('merchandise excludes buyer freight, net counts sale totals once and subtracts only linked selling fees and freight', () => {
  const result = salesRevenue([order()], [
    tx('Shipment', { breakdowns: [node('Sales', '22000'), node('Expenses', '-4000', [node('Commission', '-4000')])] }),
    tx('ServiceFee', { transactionId: 'freight', totalCents: '-2000', breakdowns: [node('MFNPostageFee', '-2000', [node('Base', '-1500'), node('Tax', '-500')])], items: [{ breakdowns: [node('MFNPostageFee', '-2000')] }] }),
    tx('Refund', { totalCents: '-5000' }), tx('ProductAdsPayment', { totalCents: '-3000' }),
    tx('ServiceFee', { breakdowns: [node('FBAStorageFee', '-1000')] }),
    tx('Adjustment', { totalCents: '1000', breakdowns: [node('SAFETReimbursement', '1000')] }),
    tx('Transfer', { totalCents: '-9000' }), tx('Shipment', { storeId: 'store-b', totalCents: '99999' }),
    tx('ServiceFee', { orderIds: [], breakdowns: [node('MFNPostageFee', '-999')] }),
  ]);
  assert.deepEqual(result.grossByCurrency, [{ currency: 'BRL', grossCents: '20000' }]);
  assert.deepEqual(result.netByCurrency, [{ currency: 'BRL', netCents: '16000' }]);
  assert.equal(result.netOrderCount, 1); assert.equal(result.orderCount, 1); assert.equal(result.unclassifiedFeeCount, 0);
  assert.equal(result.cashReceivedCents, null);
});

test('payment-pending, canceled and other-store orders never enter revenue; missing values stay missing', () => {
  const result = salesRevenue([order('pending', { status: 'PENDING' }), order('canceled', { status: 'CANCELLED' }),
    order('a', { breakdowns: [], items: [{ quantityOrdered: 2, unitPriceCents: '101', unitPriceCurrency: 'BRL' }] }),
    order('missing', { breakdowns: [], items: [] })], [tx(), tx('Shipment', { orderIds: ['pending'] }), tx('Shipment', { orderIds: ['canceled'] }), tx('Shipment', { orderIds: ['a', 'foreign'] })]);
  assert.equal(result.orderCount, 2); assert.equal(result.knownGrossOrderCount, 1); assert.equal(result.missingGrossOrderCount, 1);
  assert.deepEqual(result.grossByCurrency, [{ currency: 'BRL', grossCents: '202' }]);
  assert.deepEqual(result.netByCurrency, [{ currency: 'BRL', netCents: '18000' }]);
  assert.equal(result.missingNetOrderCount, 1);
});

test('large integers and different currencies remain exact; ambiguous fee breakdowns never become zero', () => {
  const result = salesRevenue([order(), order('usd', { currency: 'USD', breakdowns: [node('ITEM', '900719925474099313', [], 'USD')], items: [] })],
    [tx(), tx('ServiceFee', { breakdowns: [node('MFNPostageFee', '-1000')], items: [{ breakdowns: [node('MFNPostageFee', '-2000')] }] }),
      tx('Shipment', { orderIds: ['usd'], currency: 'USD', totalCents: '900719925474099300', status: 'DEFERRED' })]);
  assert.equal(result.grossByCurrency[1].grossCents, '900719925474099313');
  assert.deepEqual(result.netByCurrency, [{ currency: 'USD', netCents: '900719925474099300' }]);
  assert.equal(result.missingNetOrderCount, 1); assert.equal(result.deferredSaleCount, 1);
});

test('refund releases tied to one original count once, while other events and stores remain distinct', () => {
  const refund = (id, extra = {}) => tx('Refund', { transactionId: id, observedAt: '2026-09-28T12:00:00Z', postedAt: '2026-09-27T12:00:00Z', ...extra });
  assert.equal(refundEventCount([refund('release-one', { deferredTransactionIds: ['original'] }), refund('release-two', { deferredTransactionIds: ['original'] }),
    refund('separate'), refund('release-one', { storeId: 'store-b', deferredTransactionIds: ['original'] })]), 3);
});
