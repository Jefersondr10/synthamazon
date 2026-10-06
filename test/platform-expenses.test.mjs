import test from 'node:test';
import assert from 'node:assert/strict';
import { platformExpenses } from '../src/domain/platform-expenses.mjs';

const node = (kind, amountCents, children = [], currency = 'BRL') => ({ kind, amountCents, children, currency });
const tx = (transactionId, extra = {}) => ({ transactionId, storeId: 'store-a', type: 'ServiceFee',
  status: 'RELEASED', totalCents: '-1000', currency: 'BRL', breakdowns: [], items: [], ...extra });

test('exact storage and advertising evidence is separate from freight and generic fees', () => {
  const transactions = [
    tx('storage', { totalCents: '-9092', breakdowns: [node('Expenses', '-9092', [node('StorageBillingFee', '-9092')])] }),
    tx('ads', { type: 'ProductAdsPayment', totalCents: '-25179' }),
    tx('freight', { breakdowns: [node('MFNPostageFee', '-1000')] }), tx('generic'),
    tx('lookalike', { breakdowns: [node('fbastoragefee', '-1000')] }),
    tx('inventory-reimbursement', { type: 'Adjustment', totalCents: '1000', breakdowns: [node('FBAInventoryReimbursement', '1000')] }),
  ];
  const before = JSON.stringify(transactions);
  assert.deepEqual(platformExpenses(transactions), { byCurrency: [{ currency: 'BRL', fbaStorageCents: '-9092',
    adsCents: '-25179', unknownStorageCount: 0, unknownAdsCount: 0 }], counts: { fbaStorage: 1, ads: 1 }, dateBasis: 'posted' });
  assert.equal(JSON.stringify(transactions), before);
});

test('matching parents and mirrored root/item storage breakdowns are counted once', () => {
  const transactions = [tx('mirrored', {
    breakdowns: [node('Expenses', '-1000', [node('StorageBillingFee', '-1000', [node('FBAStorageFee', '-1000')])])],
    items: [{ breakdowns: [node('FBAStorageFee', '-400')] }, { breakdowns: [node('StorageBillingFee', '-600')] }],
  }), tx('item-only', { totalCents: '-300', items: [{ breakdowns: [node('FBAStorageFee', '-300')] }] })];
  const result = platformExpenses(transactions);
  assert.equal(result.byCurrency[0].fbaStorageCents, '-1300');
  assert.equal(result.counts.fbaStorage, 2);
  assert.equal(result.byCurrency[0].unknownStorageCount, 0);
});

test('advertising payment totals take precedence over their breakdown and positive reversals reduce signed expenses', () => {
  const result = platformExpenses([
    tx('ads-payment', { type: 'ProductAdsPayment', totalCents: '-500', breakdowns: [node('AdvertisingFee', '-500')],
      items: [{ breakdowns: [node('AdvertisingFee', '-500')] }] }),
    tx('ads-service', { totalCents: '-100', breakdowns: [node('AdvertisingFee', '-100')] }),
    tx('ads-credit', { type: 'ProductAdsPayment', totalCents: '200' }),
    tx('storage-debit', { breakdowns: [node('FBAStorageFee', '-1000')] }),
    tx('storage-credit', { type: 'Adjustment', totalCents: '300', breakdowns: [node('StorageBillingFee', '300')] }),
  ]);
  assert.equal(result.byCurrency[0].adsCents, '-400');
  assert.equal(result.byCurrency[0].fbaStorageCents, '-700');
  assert.deepEqual(result.counts, { fbaStorage: 2, ads: 3 });
});

test('currencies and integers beyond floating point precision remain exact', () => {
  const result = platformExpenses([
    tx('usd-storage', { currency: 'USD', totalCents: '-900719925474099313', breakdowns: [node('FBAStorageFee', '-900719925474099313', [], 'USD')] }),
    tx('usd-credit', { currency: 'USD', totalCents: '100', breakdowns: [node('FBAStorageFee', '100', [], 'USD')] }),
    tx('brl-ads', { type: 'ProductAdsPayment', totalCents: '-99' }),
  ]);
  assert.deepEqual(result.byCurrency.map(row => [row.currency, row.fbaStorageCents, row.adsCents]),
    [['BRL', '0', '-99'], ['USD', '-900719925474099213', '0']]);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('missing amounts or conflicting mirrors produce unknown category totals instead of zero or partial sums', () => {
  const result = platformExpenses([
    tx('known-storage', { breakdowns: [node('StorageBillingFee', '-1000')] }),
    tx('missing-storage', { breakdowns: [node('StorageBillingFee', null)] }),
    tx('conflicting-storage', { breakdowns: [node('StorageBillingFee', '-1000')], items: [{ breakdowns: [node('FBAStorageFee', '-900')] }] }),
    tx('missing-node-currency', { breakdowns: [node('AdvertisingFee', '-100', [], null)] }),
    tx('unknown-ads-total', { type: 'ProductAdsPayment', totalCents: null }),
    tx('unknown-currency', { type: 'ProductAdsPayment', currency: null, totalCents: '-500' }),
  ]);
  const brl = result.byCurrency.find(row => row.currency === 'BRL');
  assert.equal(brl.fbaStorageCents, null);
  assert.equal(brl.unknownStorageCount, 2);
  assert.equal(brl.adsCents, null);
  assert.equal(brl.unknownAdsCount, 2);
  const unknown = result.byCurrency.find(row => row.currency === null);
  assert.equal(unknown.adsCents, null);
  assert.equal(unknown.unknownAdsCount, 1);
  assert.deepEqual(result.counts, { fbaStorage: 3, ads: 3 });
});

test('an empty or unrelated selection does not invent a currency or an expense record', () => {
  const empty = { byCurrency: [], counts: { fbaStorage: 0, ads: 0 }, dateBasis: 'posted' };
  assert.deepEqual(platformExpenses([]), empty);
  assert.deepEqual(platformExpenses([tx('unrelated')]), empty);
  assert.throws(() => platformExpenses(null), TypeError);
  assert.throws(() => platformExpenses([null]), TypeError);
});
