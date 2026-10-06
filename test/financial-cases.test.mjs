import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildFinancialCases, getFinancialCase, saveFinancialCaseReview, saveFinancialCaseReviews, ensureFinancialCaseSchema } from '../src/domain/financial-cases.mjs';
import { saveReviewStatus, statusDefinition } from '../src/domain/review-statuses.mjs';

const at = day => `2026-09-${String(day).padStart(2, '0')}T12:00:00.000Z`;
const tx = (transactionId, extra = {}) => ({ transactionId, storeId: 'store-a', type: 'Refund', status: 'RELEASED',
  observedAt: at(20), postedAt: at(3), orderIds: ['order-a'], totalCents: '-10000', currency: 'BRL',
  deferredTransactionIds: [], releaseTransactionIds: [], items: [], breakdowns: [], ...extra });
const order = (orderId = 'order-a', extra = {}) => ({ storeId: 'store-a', orderId, fulfillmentMode: 'DBA',
  displayStatus: { code: 'RETURNED_TO_SELLER', label: 'Devolvido ao vendedor' }, items: [{ title: 'Produto teste', sku: 'SKU-A', asin: 'ASIN-A' }], ...extra });
function fixture(t) {
  const db = new DatabaseSync(':memory:'); ensureFinancialCaseSchema(db); t.after(() => db.close());
  return { db, kind: 'refunds', transactions: [], orders: [order()], now: new Date(at(25)) };
}
const breakdown = (kind, amountCents, children = [], currency = 'BRL') => ({ kind, amountCents, currency, children });
const credit = (transactionId, extra = {}) => tx(transactionId, { type: 'Adjustment', totalCents: '1000',
  breakdowns: [breakdown('Sales', '1000', [breakdown('SAFETReimbursement', '1000')])], ...extra });
const customStatus = (db, extra = {}) => saveReviewStatus(db, { label: 'Conferência personalizada', color: 'blue', menus: ['refunds'],
  active: true, closesCase: false, expectedVersion: 0, now: at(25), ...extra });

test('refunds group partial events by order, preserve original date and do not add the release twice', t => {
  const f = fixture(t);
  f.transactions = [
    tx('original', { totalCents: '-900719925474099313', status: 'DEFERRED_RELEASED', releaseTransactionIds: ['release'] }),
    tx('release', { totalCents: '-900719925474099313', postedAt: at(18), deferredTransactionIds: ['original'] }),
    tx('partial', { totalCents: '-87', postedAt: at(5) }),
  ];
  const originalInput = JSON.stringify(f.transactions);
  const result = buildFinancialCases(f), row = result.items[0];
  assert.equal(result.total, 1);
  assert.equal(row.refundCount, 2);
  assert.equal(row.movementCount, 3);
  assert.equal(row.totalCents, '-900719925474099400');
  assert.equal(row.firstEventAt, at(3));
  assert.equal(row.lastEventAt, at(5));
  assert.equal(row.lastMovementAt, at(18));
  assert.equal(row.eventDateKnown, true);
  assert.equal(row.transactions.find(item => item.transactionId === 'original').countsInTotal, false);
  assert.equal(row.transactions.find(item => item.transactionId === 'release').originalPostedAt, at(3));
  assert.equal(row.order.sku, 'SKU-A');
  assert.equal(row.order.mode, 'DBA');
  assert.equal(result.summary.byCurrency[0].totalCents, row.totalCents);
  assert.equal(JSON.stringify(f.transactions), originalInput);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('references to the same absent original join releases without fabricating a refund date', t => {
  const f = fixture(t);
  f.transactions = [tx('release-a', { orderIds: [], postedAt: at(10), deferredTransactionIds: ['absent-original'] }),
    tx('release-b', { orderIds: [], postedAt: at(12), deferredTransactionIds: ['absent-original'] })];
  const first = buildFinancialCases(f).items[0];
  assert.equal(first.refundCount, 1);
  assert.equal(first.totalCents, '-10000');
  assert.equal(first.firstEventAt, null);
  assert.equal(first.lastEventAt, null);
  assert.equal(first.lastMovementAt, at(12));
  assert.equal(first.eventDateKnown, false);
  const dated = buildFinancialCases({ ...f, filters: { from: '2026-09-01', to: '2026-09-30' } });
  assert.equal(dated.total, 0);
  assert.equal(dated.summary.undatedExcludedCount, 1);
  f.transactions.push(tx('absent-original', { orderIds: [], status: 'DEFERRED_RELEASED', releaseTransactionIds: ['release-a', 'release-b'] }));
  const complete = buildFinancialCases(f).items[0];
  assert.equal(complete.caseId, first.caseId);
  assert.equal(complete.firstEventAt, at(3));
  assert.equal(complete.totalCents, '-10000');
});

test('orphan and multi-order financial events stay unallocated instead of duplicating full amounts', t => {
  const f = fixture(t);
  f.orders.push(order('order-b'));
  f.transactions = [tx('multi', { orderIds: ['order-a', 'order-b'], totalCents: '-300' }), tx('orphan', { orderIds: [], totalCents: '-50' }), tx('single', { totalCents: '-100' })];
  const result = buildFinancialCases(f);
  assert.equal(result.total, 3);
  assert.equal(result.summary.byCurrency[0].totalCents, '-450');
  assert.equal(result.summary.unallocatedCaseCount, 2);
  const multi = result.items.find(item => item.orderIds.length === 2);
  assert.equal(multi.totalCents, '-300');
  assert.equal(multi.order, null);
  assert.equal(multi.allocation, 'multiple-orders-unallocated');
  assert.equal(result.items.filter(item => item.order?.orderId === 'order-a').length, 1);
});

test('same order and transaction IDs remain isolated by store and duplicate observations use the latest version', t => {
  const f = fixture(t);
  f.orders.push(order('order-a', { storeId: 'store-b', items: [{ title: 'Outra loja', sku: 'SKU-B' }] }));
  f.transactions = [tx('same', { observedAt: at(10), totalCents: '-999' }), tx('same', { observedAt: at(12), totalCents: '-100' }),
    tx('same', { observedAt: at(11), totalCents: '-500' }), tx('same', { storeId: 'store-b', totalCents: '-200' })];
  const result = buildFinancialCases(f);
  assert.equal(result.total, 2);
  assert.equal(new Set(result.items.map(item => item.caseId)).size, 2);
  assert.equal(result.summary.byCurrency[0].totalCents, '-300');
  const onlyA = buildFinancialCases({ ...f, filters: { storeId: 'store-a' } });
  assert.equal(onlyA.items[0].movementCount, 1);
  assert.equal(onlyA.items[0].totalCents, '-100');
  assert.equal(onlyA.items[0].order.sku, 'SKU-A');
});

test('charges exclude linked refunds, transfers, sales and standalone positive or unknown amounts', t => {
  const f = fixture(t); f.kind = 'charges';
  f.transactions = [
    tx('fee', { type: 'ServiceFee', totalCents: '-200' }), tx('adjustment', { type: 'Adjustment', totalCents: '-50' }),
    tx('new-type', { type: 'FutureFeeType', totalCents: '-25' }), tx('unnamed', { type: null, totalCents: '-10' }),
    tx('refund'), tx('transfer', { type: 'Transfer' }), tx('sale', { type: 'Shipment' }),
    tx('tagged-sale', { type: 'NewSalesType', countsAsSales: true }), tx('positive', { type: 'Adjustment', totalCents: '300' }),
    tx('unknown', { type: 'ServiceFee', totalCents: null }), tx('zero', { type: 'ServiceFee', totalCents: '0' }),
  ];
  const result = buildFinancialCases(f);
  assert.equal(result.total, 4);
  assert.equal(result.summary.byCurrency[0].totalCents, '-285');
  assert.deepEqual(new Set(result.typeOptions.map(item => item.code)), new Set(['ServiceFee', 'Adjustment', 'FutureFeeType', 'Unknown']));
  assert.ok(result.items.every(item => item.refundCount === 0));
  assert.equal(buildFinancialCases({ ...f, filters: { type: 'FutureFeeType' } }).items[0].type, 'FutureFeeType');
});

test('orphan refund classification follows all explicit references, including a differently typed release', t => {
  const f = fixture(t); f.kind = 'charges'; f.orders = [];
  f.transactions = [
    tx('original', { orderIds: [], status: 'DEFERRED', releaseTransactionIds: ['typed-release'] }),
    tx('typed-release', { type: 'Adjustment', orderIds: ['not-imported'], deferredTransactionIds: ['original'] }),
    tx('missing-original-a', { orderIds: [], deferredTransactionIds: ['absent'] }),
    tx('missing-original-b', { orderIds: ['also-not-imported'], deferredTransactionIds: ['absent'] }),
    tx('unrelated-orphan', { orderIds: [], totalCents: '-42' }),
  ];
  const before = JSON.stringify(f.transactions);
  const result = buildFinancialCases(f);
  assert.equal(result.total, 1);
  assert.equal(result.items[0].transactions[0].transactionId, 'unrelated-orphan');
  assert.equal(result.items[0].type, 'Refund');
  assert.equal(result.items[0].typeLabel, 'Reembolso sem pedido');
  assert.deepEqual(result.typeOptions, [{ code: 'Refund', label: 'Reembolso sem pedido', count: 1 }]);
  assert.equal(result.summary.byCurrency[0].totalCents, '-42');
  assert.equal(JSON.stringify(f.transactions), before);
});

test('orphan refunds with unknown or conflicting money remain visible without invented totals or dates', t => {
  const f = fixture(t); f.kind = 'charges'; f.orders = [];
  f.transactions = [
    tx('unknown', { orderIds: [], totalCents: null }),
    tx('unknown-currency', { orderIds: [], totalCents: '-30', currency: null }),
    tx('release-a', { orderIds: [], postedAt: at(10), deferredTransactionIds: ['absent'], totalCents: '-100' }),
    tx('release-b', { orderIds: [], postedAt: at(12), deferredTransactionIds: ['absent'], totalCents: '-200' }),
  ];
  const result = buildFinancialCases(f);
  assert.equal(result.total, 3);
  const ambiguous = result.items.find(item => item.movementCount === 2);
  assert.equal(ambiguous.typeLabel, 'Reembolso sem pedido');
  assert.equal(ambiguous.totalCents, null);
  assert.equal(ambiguous.amountUncertain, true);
  assert.equal(ambiguous.firstEventAt, null);
  assert.equal(ambiguous.lastMovementAt, at(12));
  assert.ok(ambiguous.transactions.every(item => !item.countsInTotal && item.originalPostedAt === null));
  assert.equal(result.items.find(item => item.transactions[0].transactionId === 'unknown').totalCents, null);
  assert.deepEqual(result.summary.byCurrency, [{ currency: 'BRL', totalCents: null, knownTotalCents: '0', unknownAmountCount: 2 }]);
  assert.equal(result.summary.unknownCurrencyCount, 1);
  assert.equal(buildFinancialCases({ ...f, filters: { from: '2026-09-01', to: '2026-09-30' } }).summary.undatedExcludedCount, 1);
});

test('multiple currencies and uncertain linked amounts never become a fabricated single total', t => {
  const f = fixture(t);
  f.transactions = [tx('brl', { totalCents: '-100' }), tx('usd', { currency: 'USD', totalCents: '-200' }), tx('unknown-amount', { totalCents: null })];
  const row = buildFinancialCases(f).items[0];
  assert.equal(row.totalCents, null); assert.equal(row.currency, null);
  assert.deepEqual(row.byCurrency, [
    { currency: 'BRL', totalCents: null, knownTotalCents: '-100', unknownAmountCount: 1 },
    { currency: 'USD', totalCents: '-200', knownTotalCents: '-200', unknownAmountCount: 0 },
  ]);
  f.transactions = [tx('release-a', { deferredTransactionIds: ['missing'], totalCents: '-100' }), tx('release-b', { deferredTransactionIds: ['missing'], totalCents: '-200' })];
  const ambiguous = buildFinancialCases(f).items[0];
  assert.equal(ambiguous.refundCount, 1);
  assert.equal(ambiguous.totalCents, null);
  assert.equal(ambiguous.amountUncertain, true);
  assert.ok(ambiguous.transactions.every(item => !item.countsInTotal));
});

test('a charge explicitly released as a credit keeps its stable case and exposes the credit effect', t => {
  const f = fixture(t); f.kind = 'charges';
  f.transactions = [tx('fee-original', { type: 'ServiceFee', totalCents: '-100', status: 'DEFERRED', releaseTransactionIds: ['fee-release'] })];
  const before = buildFinancialCases(f).items[0];
  assert.equal(before.financialEffect, 'debit');
  f.transactions.push(tx('fee-release', { type: 'ServiceFee', totalCents: '100', postedAt: at(10), deferredTransactionIds: ['fee-original'] }));
  const after = buildFinancialCases(f).items[0];
  assert.equal(after.caseId, before.caseId);
  assert.equal(after.totalCents, '100');
  assert.equal(after.financialEffect, 'credit');
  assert.equal(after.hasCreditMovement, true);
  assert.equal(after.transactions.find(item => item.transactionId === 'fee-original').totalCents, '-100');
  assert.equal(after.transactions.find(item => item.transactionId === 'fee-original').countsInTotal, false);
});

test('date filters use original refund events and select whole cases, never release dates', t => {
  const f = fixture(t);
  f.transactions = [tx('original', { totalCents: '-100', status: 'DEFERRED_RELEASED', releaseTransactionIds: ['release'] }),
    tx('release', { totalCents: '-100', postedAt: at(20), deferredTransactionIds: ['original'] }),
    tx('other-partial', { totalCents: '-25', postedAt: at(15) })];
  assert.equal(buildFinancialCases({ ...f, filters: { from: '2026-09-20', to: '2026-09-20' } }).total, 0);
  const selected = buildFinancialCases({ ...f, filters: { from: '2026-09-03', to: '2026-09-03' } });
  assert.equal(selected.total, 1);
  assert.equal(selected.items[0].totalCents, '-125');
  assert.equal(selected.items[0].movementCount, 3);
  assert.equal(selected.dateBasis, 'refund-original-event');
});

test('review states survive rebuilding evidence, require optimistic versions and preserve audit history', t => {
  const f = fixture(t); f.transactions = [tx('refund')];
  const first = buildFinancialCases(f).items[0];
  assert.equal(first.review.version, 0);
  const save = updates => saveFinancialCaseReview({ db: f.db, storeId: 'store-a', kind: 'refunds', caseId: first.caseId, now: at(21), ...updates });
  const one = save({ status: 'in_review', notes: 'Conferir a devolução\nComprovante pendente.', expectedVersion: 0 });
  assert.equal(one.version, 1);
  assert.throws(() => save({ status: 'resolved', notes: 'Tentativa antiga', expectedVersion: 0 }), { code: 'REVIEW_CONFLICT' });
  assert.equal(save({ status: one.status, notes: one.notes, expectedVersion: 1 }).version, 1);
  const two = save({ status: 'request_safe_t', notes: 'Solicitar pela Amazon; ainda não enviado.', expectedVersion: 1 });
  assert.equal(two.version, 2);
  f.transactions.push(tx('another-partial', { totalCents: '-20', postedAt: at(22) }));
  const detail = getFinancialCase({ ...f, storeId: 'store-a', caseId: first.caseId });
  assert.equal(detail.caseId, first.caseId);
  assert.deepEqual(detail.review, two);
  assert.equal(detail.refundCount, 2);
  assert.equal(detail.reviewHistory.length, 2);
  assert.equal(detail.reviewHistory[1].previousNotes, one.notes);
  assert.equal(detail.reviewHistory[1].status, 'request_safe_t');
  assert.equal(buildFinancialCases(f).summary.requestSafeTCount, 1);
  assert.equal(getFinancialCase({ ...f, storeId: 'store-b', caseId: first.caseId }), null);
});

test('review status and type options precede their own filter and pagination while query/store/date scope remains', t => {
  const f = fixture(t); f.kind = 'charges';
  f.transactions = [tx('a', { type: 'ServiceFee' }), tx('b', { type: 'ServiceFee', orderIds: ['order-b'] }),
    tx('c', { type: 'Adjustment' }), tx('outside-store', { storeId: 'store-b', type: 'Other' }),
    tx('outside-date', { type: 'Other', postedAt: at(18) })];
  const row = buildFinancialCases(f).items.find(item => item.transactions[0].transactionId === 'a');
  saveFinancialCaseReview({ db: f.db, storeId: row.storeId, kind: f.kind, caseId: row.caseId, status: 'resolved', notes: '', expectedVersion: 0, now: at(21) });
  const list = buildFinancialCases({ ...f, filters: { storeId: 'store-a', from: '2026-09-01', to: '2026-09-05', status: 'pending', limit: 1 } });
  assert.equal(list.total, 2); assert.equal(list.items.length, 1); assert.equal(list.hasMore, true);
  assert.deepEqual(Object.fromEntries(list.statusOptions.map(item => [item.code, item.count])), { pending: 2, resolved: 1 });
  assert.deepEqual(Object.fromEntries(list.typeOptions.map(item => [item.code, item.count])), { Adjustment: 1, ServiceFee: 1 });
  const query = buildFinancialCases({ ...f, filters: { storeId: 'store-a', from: '2026-09-01', to: '2026-09-05', query: 'SKU-A' } });
  assert.equal(query.total, 2);
});

test('invalid review input cannot write and request SAFE-T is restricted to local refund review', t => {
  const f = fixture(t); f.transactions = [tx('refund')];
  const row = buildFinancialCases(f).items[0];
  const base = { db: f.db, storeId: row.storeId, kind: f.kind, caseId: row.caseId, status: 'pending', notes: '', expectedVersion: 0 };
  for (const extra of [{ expectedVersion: undefined }, { expectedVersion: -1 }, { status: 'amazon-paid' }, { notes: 'x'.repeat(2001) }, { notes: 'hidden\u0000value' }, { now: '2026-02-30T12:00:00Z' }]) {
    assert.throws(() => saveFinancialCaseReview({ ...base, ...extra }), { code: 'INVALID_REVIEW' });
  }
  const charges = buildFinancialCases({ ...f, kind: 'charges', transactions: [tx('fee', { type: 'ServiceFee' })] }).items[0];
  assert.throws(() => saveFinancialCaseReview({ ...base, kind: 'charges', caseId: charges.caseId, status: 'request_safe_t' }), { code: 'INVALID_REVIEW' });
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM financial_case_reviews').get().count, 0);
});

test('review and audit persist after closing and reopening the database', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'synth-cases-'));
  const filename = path.join(directory, 'reviews.sqlite');
  let db = new DatabaseSync(filename);
  t.after(async () => { db?.close(); await rm(directory, { recursive: true, force: true }); });
  const input = { db, kind: 'refunds', transactions: [tx('refund')], orders: [order()] };
  const row = buildFinancialCases(input).items[0];
  saveFinancialCaseReview({ db, kind: input.kind, storeId: row.storeId, caseId: row.caseId, status: 'waiting_amazon', notes: 'Aguardando retorno.', expectedVersion: 0, now: at(22) });
  db.close(); db = new DatabaseSync(filename);
  const reopened = getFinancialCase({ ...input, db, storeId: row.storeId, caseId: row.caseId });
  assert.equal(reopened.review.status, 'waiting_amazon');
  assert.equal(reopened.review.notes, 'Aguardando retorno.');
  assert.equal(reopened.review.version, 1);
  assert.equal(reopened.reviewHistory.length, 1);
});

test('charges hide identified freight, storage and ads while preserving unidentified or mixed expenses', t => {
  const f = fixture(t); f.kind = 'charges';
  f.transactions = [
    tx('postage', { type: 'ServiceFee', breakdowns: [breakdown('Expenses', '-10000', [breakdown('MFNPostageFee', '-10000')])] }),
    tx('chargeback', { type: 'ServiceFee', items: [{ breakdowns: [breakdown('AmazonFees', '-10000', [breakdown('MFNShippingChargeback', '-10000')])] }] }),
    tx('storage', { type: 'ServiceFee', breakdowns: [breakdown('StorageBillingFee', '-10000')] }),
    tx('advertising', { type: 'ServiceFee', breakdowns: [breakdown('AdvertisingFee', '-10000')] }),
    tx('ads-payment', { type: 'ProductAdsPayment' }),
    tx('unknown', { type: 'ServiceFee', breakdowns: [breakdown('AmazonFees', '-10000')] }),
    tx('lookalike', { type: 'ServiceFee', breakdowns: [breakdown('mfnpostagefee', '-10000')] }),
    tx('other-type', { type: 'OtherFee', breakdowns: [breakdown('MFNPostageFee', '-10000')] }),
    tx('mixed', { type: 'ServiceFee', breakdowns: [breakdown('AmazonFees', '-10000', [breakdown('MFNPostageFee', '-8000'), breakdown('StorageBillingFee', '-2000')])] }),
    tx('mixed-unknown', { type: 'ServiceFee', breakdowns: [breakdown('AmazonFees', '-10000', [breakdown('FBAStorageFee', '-8000'), breakdown('OtherFee', '-2000')])] }),
  ];
  const original = JSON.stringify(f.transactions), result = buildFinancialCases(f);
  assert.deepEqual(new Set(result.items.map(item => item.transactions[0].transactionId)), new Set(['unknown', 'lookalike', 'other-type', 'mixed-unknown']));
  assert.equal(result.summary.byCurrency[0].totalCents, '-40000');
  assert.equal(JSON.stringify(f.transactions), original);
});

test('reimbursements use exact positive released evidence and a single explicit order within the same store', t => {
  const f = fixture(t);
  f.transactions = [tx('refund'), credit('safe'), credit('deferred', { status: 'DEFERRED' }),
    credit('negative', { totalCents: '-1000', breakdowns: [breakdown('SAFETReimbursement', '-1000')] }),
    credit('unknown-value', { breakdowns: [breakdown('SAFETReimbursement', null)] }),
    credit('unknown-currency', { currency: null }), credit('other-store', { storeId: 'store-b' }),
    credit('orphan', { orderIds: [] }), credit('multiple-orders', { orderIds: ['order-a', 'order-b'] }),
    credit('generic', { breakdowns: [breakdown('Adjustment', '1000')] }),
    credit('unsupported-alias', { breakdowns: [breakdown('EasyShipReimbursement', '1000')] }),
    credit('clawback', { breakdowns: [breakdown('ReimbursementClawback', '1000')] })];
  const row = buildFinancialCases(f).items[0];
  assert.equal(row.reimbursement.identified, true);
  assert.deepEqual(row.reimbursement.types, [{ code: 'safe_t', label: 'SAFE-T' }]);
  assert.equal(row.reimbursement.credits.length, 1);
  assert.equal(row.reimbursement.credits[0].transactionId, 'safe');
  assert.equal(row.reimbursement.credits[0].totalCents, '1000');
  assert.equal(row.totalCents, '-10000');
  assert.equal(row.review.status, 'pending');
  assert.equal(row.reimbursement.lastCreditAt, at(3));
});

test('explicit references and mirrored breakdowns count reimbursement once without adding children', t => {
  const f = fixture(t);
  const root = [breakdown('Sales', '1000', [breakdown('SAFETReimbursement', '1000', [breakdown('Base', '900'), breakdown('Tax', '100')])])];
  f.transactions = [tx('refund'), credit('original-credit', { status: 'DEFERRED_RELEASED', releaseTransactionIds: ['released-credit'], breakdowns: root }),
    credit('released-credit', { postedAt: at(12), deferredTransactionIds: ['original-credit'], breakdowns: root,
      items: [{ breakdowns: [breakdown('SAFETReimbursement', '600')] }, { breakdowns: [breakdown('SAFETReimbursement', '400')] }] })];
  const before = JSON.stringify(f.transactions), row = buildFinancialCases(f).items[0];
  assert.equal(row.reimbursement.credits.length, 1);
  assert.equal(row.reimbursement.credits[0].transactionId, 'released-credit');
  assert.equal(row.reimbursement.byCurrency[0].totalCents, '1000');
  assert.equal(row.reimbursement.lastCreditAt, at(12));
  assert.equal(JSON.stringify(f.transactions), before);
  const eventId = row.reimbursement.credits[0].eventId;
  f.transactions = f.transactions.filter(item => item.transactionId !== 'original-credit');
  assert.equal(buildFinancialCases(f).items[0].reimbursement.credits[0].eventId, eventId);
});

test('conflicting type, currency, amount and mirrored reimbursement evidence is not allocated', t => {
  const f = fixture(t);
  f.transactions = [tx('refund'),
    credit('mixed-types', { breakdowns: [breakdown('SAFETReimbursement', '500'), breakdown('LostOrDamagedReimbursement', '500')] }),
    credit('mismatched-mirror', { items: [{ breakdowns: [breakdown('SAFETReimbursement', '500')] }] }),
    credit('mismatched-currency', { breakdowns: [breakdown('SAFETReimbursement', '1000', [], 'USD')] }),
    credit('release-one', { deferredTransactionIds: ['absent'], totalCents: '1000' }),
    credit('release-two', { deferredTransactionIds: ['absent'], totalCents: '2000', breakdowns: [breakdown('SAFETReimbursement', '2000')] })];
  const evidence = buildFinancialCases(f).items[0].reimbursement;
  assert.equal(evidence.identified, false);
  assert.deepEqual(evidence.credits, []);
  assert.deepEqual(evidence.byCurrency, []);
});

test('reimbursement currencies remain separate and newly recorded credits never change manual review', t => {
  const f = fixture(t); f.transactions = [tx('refund')];
  const initial = buildFinancialCases(f).items[0];
  const reviewed = saveFinancialCaseReview({ db: f.db, kind: 'refunds', storeId: 'store-a', caseId: initial.caseId,
    status: 'in_review', notes: 'Conferir cobertura parcial.', expectedVersion: 0, now: at(20) });
  f.transactions.push(credit('safe', { totalCents: '900719925474099313', breakdowns: [breakdown('SAFETReimbursement', '900719925474099313')] }),
    credit('easy', { status: 'DEFERRED_RELEASED', currency: 'USD', totalCents: '200', postedAt: at(22), breakdowns: [],
      items: [{ breakdowns: [breakdown('LostOrDamagedReimbursement', '200', [], 'USD')] }] }));
  const row = getFinancialCase({ ...f, storeId: 'store-a', caseId: initial.caseId });
  assert.deepEqual(row.review, reviewed);
  assert.equal(row.reviewHistory.length, 1);
  assert.deepEqual(row.reimbursement.types.map(item => item.code), ['easy_ship', 'safe_t']);
  assert.deepEqual(row.reimbursement.byCurrency.map(item => [item.currency, item.totalCents]), [['BRL', '900719925474099313'], ['USD', '200']]);
  assert.equal(row.reimbursement.lastCreditAt, at(22));
  assert.equal(row.totalCents, initial.totalCents);
});

test('reimbursement facets precede their own selection and pagination but respect other scope filters', t => {
  const f = fixture(t); f.orders.push(order('order-b'), order('order-c'));
  f.transactions = [tx('a'), tx('b', { orderIds: ['order-b'] }), tx('c', { orderIds: ['order-c'] }), credit('safe'),
    credit('easy', { orderIds: ['order-b'], breakdowns: [breakdown('LostOrDamagedReimbursement', '1000')] }),
    tx('other-store', { storeId: 'store-b' }), credit('other-store-credit', { storeId: 'store-b' }),
    tx('outside-date', { orderIds: ['old-order'], postedAt: at(18) }), credit('outside-date-credit', { orderIds: ['old-order'] })];
  const filters = { storeId: 'store-a', from: '2026-09-01', to: '2026-09-05', query: 'SKU-A', limit: 1, reimbursement: 'identified' };
  const list = buildFinancialCases({ ...f, filters });
  assert.equal(list.total, 2); assert.equal(list.items.length, 1); assert.equal(list.hasMore, true);
  assert.equal(list.summary.reimbursementCount, 2);
  assert.deepEqual(Object.fromEntries(list.reimbursementOptions.map(item => [item.code, item.count])), { identified: 2, unidentified: 1, safe_t: 1, easy_ship: 1 });
  assert.equal(buildFinancialCases({ ...f, filters: { ...filters, reimbursement: 'safe_t' } }).total, 1);
  assert.equal(buildFinancialCases({ ...f, filters: { ...filters, reimbursement: 'unidentified' } }).items[0].orderIds[0], 'order-c');
  assert.equal(list.statusOptions[0].count, 2);
  for (const bad of ['paid', null, {}]) assert.throws(() => buildFinancialCases({ ...f, filters: { reimbursement: bad } }), { code: 'INVALID_PARAMETERS' });
  assert.throws(() => buildFinancialCases({ ...f, kind: 'charges', filters: { reimbursement: 'all' } }), { code: 'INVALID_PARAMETERS' });
});

test('reimbursement selections are an OR union with exact totals and independent facets before pagination', t => {
  const f = fixture(t);
  const safe = (id, orderId, extra = {}) => credit(id, { orderIds: [orderId], ...extra });
  const easy = (id, orderId, extra = {}) => credit(id, { orderIds: [orderId],
    breakdowns: [breakdown('LostOrDamagedReimbursement', '1000')], ...extra });
  f.orders = ['a', 'b', 'c', 'd', 'resolved', 'outside-date'].map(id => order(id));
  f.orders.push(order('outside-query', { items: [{ sku: 'SKU-OTHER' }] }), order('outside-store', { storeId: 'store-b' }));
  f.transactions = [
    tx('refund-a', { orderIds: ['a'], totalCents: '-900719925474099313' }), safe('safe-a', 'a'),
    tx('refund-b', { orderIds: ['b'], totalCents: '-200', currency: 'USD' }), easy('easy-b', 'b'),
    tx('refund-c', { orderIds: ['c'], totalCents: '-300' }), safe('safe-c', 'c'), easy('easy-c', 'c'),
    tx('refund-d', { orderIds: ['d'], totalCents: '-400', currency: 'USD' }),
    tx('refund-resolved', { orderIds: ['resolved'], totalCents: '-700' }), safe('safe-resolved', 'resolved'),
    tx('refund-outside-date', { orderIds: ['outside-date'], postedAt: at(18) }), safe('safe-outside-date', 'outside-date'),
    tx('refund-outside-query', { orderIds: ['outside-query'] }), safe('safe-outside-query', 'outside-query'),
    tx('refund-outside-store', { orderIds: ['outside-store'], storeId: 'store-b' }), safe('safe-outside-store', 'outside-store', { storeId: 'store-b' }),
  ];
  const resolved = buildFinancialCases(f).items.find(item => item.orderIds[0] === 'resolved');
  saveFinancialCaseReview({ db: f.db, kind: 'refunds', storeId: 'store-a', caseId: resolved.caseId,
    status: 'resolved', notes: 'Conferência concluída.', expectedVersion: 0, now: at(20) });
  const scope = { storeId: 'store-a', from: '2026-09-01', to: '2026-09-05', query: 'SKU-A', status: 'pending' };
  const overlap = buildFinancialCases({ ...f, filters: { ...scope, reimbursement: 'identified,safe_t,easy_ship', limit: 1, offset: 1 } });
  assert.equal(overlap.total, 3);
  assert.equal(overlap.items.length, 1);
  assert.equal(overlap.hasMore, true);
  assert.equal(overlap.summary.caseCount, 3);
  assert.equal(overlap.summary.eventCount, 3);
  assert.equal(overlap.summary.reimbursementCount, 3);
  assert.deepEqual(overlap.summary.byCurrency.map(item => [item.currency, item.totalCents]), [['BRL', '-900719925474099613'], ['USD', '-200']]);
  assert.deepEqual(Object.fromEntries(overlap.reimbursementOptions.map(item => [item.code, item.count])),
    { identified: 3, unidentified: 1, safe_t: 2, easy_ship: 2 });

  const mixed = buildFinancialCases({ ...f, filters: { ...scope, reimbursement: 'safe_t,unidentified' } });
  assert.deepEqual(new Set(mixed.items.map(item => item.orderIds[0])), new Set(['a', 'c', 'd']));
  assert.equal(mixed.summary.reimbursementCount, 2);
  assert.deepEqual(mixed.summary.byCurrency.map(item => [item.currency, item.totalCents]), [['BRL', '-900719925474099613'], ['USD', '-400']]);
  assert.deepEqual(mixed.reimbursementOptions, overlap.reimbursementOptions);
  assert.deepEqual(Object.fromEntries(mixed.statusOptions.map(item => [item.code, item.count])), { pending: 3, resolved: 1 });
  const allSelections = buildFinancialCases({ ...f, filters: { ...scope, reimbursement: 'identified,unidentified,safe_t,easy_ship' } });
  assert.equal(allSelections.total, 4);
  assert.equal(new Set(allSelections.items.map(item => item.caseId)).size, 4);
  assert.deepEqual(allSelections.summary, buildFinancialCases({ ...f, filters: { ...scope, reimbursement: 'all' } }).summary);
  assert.equal(buildFinancialCases({ ...f, filters: { ...scope, reimbursement: 'safe_t' } }).total, 2);
});

test('reimbursement CSV rejects malformed or oversized input and manual review status remains single-select', t => {
  const f = fixture(t);
  for (const reimbursement of [null, {}, [], ['safe_t'], 4, '', ' ', ',safe_t', 'safe_t,',
    'safe_t,,unidentified', 'safe_t, unidentified', 'safe_t,safe_t', 'SAFE_T', 'all,safe_t', 'all,all',
    'identified,unidentified,safe_t,easy_ship,extra', 'toString', 'x'.repeat(52)]) {
    assert.throws(() => buildFinancialCases({ ...f, filters: { reimbursement } }), { code: 'INVALID_PARAMETERS' });
  }
  for (const status of ['pending,resolved', null, {}, ['pending']]) {
    assert.throws(() => buildFinancialCases({ ...f, filters: { status } }), { code: 'INVALID_PARAMETERS' });
  }
  assert.equal(buildFinancialCases({ ...f, filters: { reimbursement: 'identified,unidentified,safe_t,easy_ship' } }).total, 0);
  assert.equal(buildFinancialCases({ ...f, filters: { reimbursement: 'all' } }).total, 0);
  assert.equal(buildFinancialCases(f).total, 0);
});

test('financial search normalizes whitespace in order and transaction SKUs without changing evidence or scope', t => {
  const f = fixture(t);
  const orderSku = 'KIT  Cabo\tUSB', transactionSku = 'Peça\t  Azul';
  f.orders = [order('order-a', { items: [{ sku: orderSku }] }), order('old-order', { items: [{ sku: orderSku }] }),
    order('other-store', { storeId: 'store-b', items: [{ sku: orderSku }] })];
  for (const kind of ['refunds', 'charges']) {
    const type = kind === 'refunds' ? 'Refund' : 'ServiceFee';
    f.transactions = [tx('wanted', { type }), tx('old', { type, orderIds: ['old-order'], postedAt: at(18) }),
      tx('another-store', { type, storeId: 'store-b', orderIds: ['other-store'] }),
      tx('unlinked-item', { type, orderIds: [], items: [{ sku: transactionSku }] })];
    const before = JSON.stringify({ orders: f.orders, transactions: f.transactions });
    const scope = { storeId: 'store-a', from: '2026-09-01', to: '2026-09-05', status: 'pending' };
    for (const query of ['kit cabo usb', '  KIT\tCABO   USB  ']) {
      const found = buildFinancialCases({ ...f, kind, filters: { ...scope, query } });
      assert.equal(found.total, 1);
      assert.equal(found.items[0].transactions[0].transactionId, 'wanted');
      assert.equal(found.items[0].order.sku, orderSku);
      assert.equal(found.summary.byCurrency[0].totalCents, '-10000');
    }
    const itemMatch = buildFinancialCases({ ...f, kind, filters: { ...scope, query: ' PEÇA azul ' } });
    assert.equal(itemMatch.total, 1);
    assert.equal(itemMatch.items[0].transactions[0].items[0].sku, transactionSku);
    assert.equal(buildFinancialCases({ ...f, kind, filters: { ...scope, query: 'peca azul' } }).total, 0);
    assert.equal(JSON.stringify({ orders: f.orders, transactions: f.transactions }), before);
  }
});

test('bulk refund status preserves each note and history across stores, including unchanged selections', t => {
  const f = fixture(t);
  f.transactions = [tx('shared-refund'), tx('shared-refund', { storeId: 'store-b' }),
    tx('new-refund', { orderIds: ['order-new'] }), tx('untouched-refund', { orderIds: ['order-untouched'] })];
  const rows = buildFinancialCases(f).items;
  const a = rows.find(item => item.storeId === 'store-a' && item.orderIds[0] === 'order-a');
  const b = rows.find(item => item.storeId === 'store-b');
  const fresh = rows.find(item => item.orderIds[0] === 'order-new');
  const untouched = rows.find(item => item.orderIds[0] === 'order-untouched');
  const single = (item, status, notes) => saveFinancialCaseReview({ db: f.db, kind: 'refunds', storeId: item.storeId,
    caseId: item.caseId, status, notes, expectedVersion: 0, now: at(20) });
  single(a, 'in_review', 'Loja A: manter comprovante.\nConferir valor.');
  const savedB = single(b, 'waiting_amazon', 'Loja B: solicitação já enviada.');
  const items = [a, b, fresh].map(item => ({ storeId: item.storeId, caseId: item.caseId, expectedVersion: item === fresh ? 0 : 1 }));
  const result = saveFinancialCaseReviews({ db: f.db, kind: 'refunds', items, status: 'waiting_amazon', now: at(21),
    notes: 'Este campo não faz parte da edição em massa.' });
  assert.equal(result.updatedCount, 2);
  assert.equal(result.unchangedCount, 1);
  assert.deepEqual(result.reviews.map(item => item.caseId), items.map(item => item.caseId));
  assert.equal(result.reviews[0].review.notes, 'Loja A: manter comprovante.\nConferir valor.');
  assert.deepEqual(result.reviews[1].review, savedB);
  assert.equal(result.reviews[2].review.notes, '');
  assert.deepEqual(result.reviews.map(item => item.review.version), [2, 1, 1]);
  const detailA = getFinancialCase({ ...f, storeId: a.storeId, caseId: a.caseId });
  assert.equal(detailA.reviewHistory.length, 2);
  assert.equal(detailA.reviewHistory[1].previousNotes, detailA.review.notes);
  assert.equal(detailA.reviewHistory[1].notes, detailA.review.notes);
  assert.equal(detailA.reimbursement.identified, false);
  assert.equal(getFinancialCase({ ...f, storeId: untouched.storeId, caseId: untouched.caseId }).review.version, 0);
  const auditCount = f.db.prepare('SELECT COUNT(*) AS n FROM financial_case_review_history').get().n;
  const again = saveFinancialCaseReviews({ db: f.db, kind: 'refunds', status: 'waiting_amazon', now: at(22),
    items: result.reviews.map(item => ({ storeId: item.storeId, caseId: item.caseId, expectedVersion: item.review.version })) });
  assert.equal(again.updatedCount, 0);
  assert.equal(again.unchangedCount, 3);
  assert.deepEqual(again.reviews, result.reviews);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM financial_case_review_history').get().n, auditCount);
});

test('a stale or missing version aborts every item before any bulk status or history changes', t => {
  const f = fixture(t); f.transactions = [tx('first'), tx('second', { orderIds: ['order-b'] })];
  const [a, b] = buildFinancialCases(f).items;
  const saved = saveFinancialCaseReview({ db: f.db, kind: 'refunds', storeId: b.storeId, caseId: b.caseId,
    status: 'in_review', notes: 'Outra tela fez esta alteração.', expectedVersion: 0, now: at(20) });
  const selection = [a, b].map(item => ({ storeId: item.storeId, caseId: item.caseId, expectedVersion: 0 }));
  assert.throws(() => saveFinancialCaseReviews({ db: f.db, kind: 'refunds', items: selection, status: 'resolved', now: at(21) }),
    { code: 'REVIEW_CONFLICT' });
  assert.throws(() => saveFinancialCaseReviews({ db: f.db, kind: 'refunds',
    items: [selection[0], { storeId: b.storeId, caseId: b.caseId }], status: 'resolved', now: at(21) }),
  { code: 'INVALID_REVIEW' });
  const first = getFinancialCase({ ...f, storeId: a.storeId, caseId: a.caseId });
  assert.equal(first.review.version, 0);
  assert.deepEqual(first.reviewHistory, []);
  assert.deepEqual(getFinancialCase({ ...f, storeId: b.storeId, caseId: b.caseId }).review, saved);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM financial_case_review_history').get().n, 1);
});

test('bulk validates unique refund identities, strict versions and the one hundred item boundary', t => {
  const f = fixture(t);
  f.transactions = Array.from({ length: 101 }, (_, index) => tx(`refund-${index}`, { orderIds: [`order-${index}`] }));
  const items = buildFinancialCases({ ...f, filters: { limit: 500 } }).items
    .map(item => ({ storeId: item.storeId, caseId: item.caseId, expectedVersion: 0 }));
  const base = { db: f.db, kind: 'refunds', items: items.slice(0, 1), status: 'pending', now: at(20) };
  for (const extra of [{ items: [] }, { items: null }, { items: {} }, { items: items.slice(0, 101) },
    { items: [items[0], items[0]] }, { items: [null] }, { items: [['store-a', items[0].caseId, 0]] },
    { items: [{ ...items[0], expectedVersion: -1 }] }, { items: [{ ...items[0], expectedVersion: '0' }] },
    { items: [{ ...items[0], expectedVersion: 0.5 }] }, { items: [{ ...items[0], expectedVersion: Number.MAX_SAFE_INTEGER + 1 }] },
    { items: [{ ...items[0], storeId: '../store-a' }] }, { items: [{ ...items[0], storeId: ['store-a'] }] },
    { items: [{ ...items[0], caseId: items[0].caseId.replace('refunds-', 'charges-') }] },
    { kind: 'charges' }, { kind: null }, { status: 'SAFE-T RECEBIDO' }, { status: 'pending,resolved' },
    { status: ['pending'] }, { now: '2026-02-30T12:00:00Z' }]) {
    assert.throws(() => saveFinancialCaseReviews({ ...base, ...extra }), { code: 'INVALID_REVIEW' });
  }
  const allowed = saveFinancialCaseReviews({ ...base, items: items.slice(0, 100) });
  assert.equal(allowed.updatedCount, 0);
  assert.equal(allowed.unchangedCount, 100);
  assert.equal(allowed.reviews.length, 100);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM financial_case_reviews').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM financial_case_review_history').get().n, 0);
});

test('an audit write failure rolls back every status update and leaves no transaction open', t => {
  const f = fixture(t); f.transactions = [tx('a'), tx('a', { storeId: 'store-b' })];
  const items = buildFinancialCases(f).items.sort((a, b) => a.storeId.localeCompare(b.storeId))
    .map(item => ({ storeId: item.storeId, caseId: item.caseId, expectedVersion: 0 }));
  f.db.exec(`CREATE TRIGGER fail_second_audit BEFORE INSERT ON financial_case_review_history
    WHEN NEW.store_id = 'store-b' BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END;`);
  const input = { db: f.db, kind: 'refunds', items, status: 'request_safe_t', now: at(20) };
  assert.throws(() => saveFinancialCaseReviews(input), /fixture audit failure/);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM financial_case_reviews').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM financial_case_review_history').get().n, 0);
  f.db.exec('DROP TRIGGER fail_second_audit');
  assert.equal(saveFinancialCaseReviews(input).updatedCount, 2);
});

test('custom catalog statuses drive review labels, colors, filters and closing summaries without changing finance', t => {
  const f = fixture(t);
  f.transactions = [tx('a'), tx('b', { orderIds: ['order-b'], totalCents: '-2000' })];
  const evidence = JSON.stringify(f.transactions), rows = buildFinancialCases(f).items;
  const open = customStatus(f.db), closed = customStatus(f.db, { label: 'Conferência concluída', color: 'good', closesCase: true });
  const one = saveFinancialCaseReview({ db: f.db, kind: f.kind, storeId: rows[0].storeId, caseId: rows[0].caseId,
    status: open.code, notes: 'Documento solicitado.', expectedVersion: 0, now: at(25) });
  const two = saveFinancialCaseReview({ db: f.db, kind: f.kind, storeId: rows[1].storeId, caseId: rows[1].caseId,
    status: closed.code, notes: 'Análise encerrada.', expectedVersion: 0, now: at(25) });
  assert.equal(one.label, open.label); assert.equal(one.color, 'blue'); assert.equal(one.closesCase, false);
  assert.equal(two.label, closed.label); assert.equal(two.color, 'good'); assert.equal(two.closesCase, true);
  const list = buildFinancialCases(f);
  assert.equal(list.summary.inReviewCount, 1);
  assert.equal(list.summary.resolvedCount, 1);
  assert.equal(list.summary.byCurrency[0].totalCents, '-12000');
  assert.ok(list.reviewStatuses.some(item => item.code === open.code));
  const filtered = buildFinancialCases({ ...f, filters: { status: closed.code, limit: 1 } });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0].caseId, rows[1].caseId);
  assert.deepEqual(new Set(filtered.statusOptions.map(item => item.code)), new Set([open.code, closed.code]));
  assert.equal(filtered.statusOptions.find(item => item.code === closed.code).color, 'good');
  const detail = getFinancialCase({ ...f, storeId: rows[0].storeId, caseId: rows[0].caseId });
  assert.ok(detail.reviewStatuses.some(item => item.code === closed.code));
  assert.equal(JSON.stringify(f.transactions), evidence);
});

test('catalog edits preserve existing review notes, versions, history and inactive status filtering', t => {
  const f = fixture(t); f.transactions = [tx('a'), tx('b', { orderIds: ['order-b'] })];
  const rows = buildFinancialCases(f).items, custom = customStatus(f.db);
  const saved = saveFinancialCaseReview({ db: f.db, kind: f.kind, storeId: rows[0].storeId, caseId: rows[0].caseId,
    status: custom.code, notes: 'Nota anterior preservada.', expectedVersion: 0, now: at(22) });
  const before = JSON.stringify(f.db.prepare('SELECT * FROM financial_case_reviews').all());
  const historyBefore = JSON.stringify(f.db.prepare('SELECT * FROM financial_case_review_history').all());
  const disabled = saveReviewStatus(f.db, { ...custom, expectedVersion: custom.version, active: false, menus: [], label: 'Arquivado para novas análises', now: at(25) });
  ensureFinancialCaseSchema(f.db);
  assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM financial_case_reviews').all()), before);
  assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM financial_case_review_history').all()), historyBefore);
  const list = buildFinancialCases({ ...f, filters: { status: custom.code } });
  assert.equal(list.total, 1);
  assert.equal(list.items[0].review.label, disabled.label);
  assert.equal(list.items[0].review.notes, saved.notes);
  assert.equal(list.items[0].review.version, 1);
  assert.ok(!list.reviewStatuses.some(item => item.code === custom.code));
  const edit = saveFinancialCaseReview({ db: f.db, kind: f.kind, storeId: rows[0].storeId, caseId: rows[0].caseId,
    status: custom.code, notes: 'Nota posterior permitida.', expectedVersion: 1, now: at(25) });
  assert.equal(edit.version, 2);
  assert.throws(() => saveFinancialCaseReview({ db: f.db, kind: f.kind, storeId: rows[1].storeId, caseId: rows[1].caseId,
    status: custom.code, notes: '', expectedVersion: 0, now: at(25) }), { code: 'INVALID_REVIEW' });
  assert.equal(getFinancialCase({ ...f, storeId: rows[0].storeId, caseId: rows[0].caseId }).reviewHistory[0].notes, saved.notes);
});

test('dynamic bulk review is atomic across assignments, disabled statuses and stale versions', t => {
  const f = fixture(t); f.transactions = [tx('a'), tx('b', { orderIds: ['order-b'] })];
  const rows = buildFinancialCases(f).items, custom = customStatus(f.db);
  const targets = rows.map(row => ({ storeId: row.storeId, caseId: row.caseId, expectedVersion: 0 }));
  const saved = saveFinancialCaseReviews({ db: f.db, kind: f.kind, items: targets, status: custom.code, now: at(25) });
  assert.equal(saved.updatedCount, 2);
  assert.ok(saved.reviews.every(item => item.review.label === custom.label));
  const histories = JSON.stringify(f.db.prepare('SELECT * FROM financial_case_review_history').all());
  assert.throws(() => saveFinancialCaseReviews({ db: f.db, kind: f.kind,
    items: targets.map((item, index) => ({ ...item, expectedVersion: index ? 0 : 1 })), status: 'resolved' }), { code: 'REVIEW_CONFLICT' });
  assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM financial_case_review_history').all()), histories);
  saveReviewStatus(f.db, { ...custom, expectedVersion: custom.version, active: false, menus: [] });
  const same = saveFinancialCaseReviews({ db: f.db, kind: f.kind, items: targets.map(item => ({ ...item, expectedVersion: 1 })), status: custom.code });
  assert.equal(same.updatedCount, 0); assert.equal(same.unchangedCount, 2);
  const changed = saveFinancialCaseReview({ db: f.db, kind: f.kind, ...targets[1], expectedVersion: 1, status: 'pending', notes: 'Keep note' });
  assert.equal(changed.version, 2);
  const before = JSON.stringify(f.db.prepare('SELECT * FROM financial_case_review_history').all());
  assert.throws(() => saveFinancialCaseReviews({ db: f.db, kind: f.kind,
    items: targets.map((item, index) => ({ ...item, expectedVersion: index ? 2 : 1 })), status: custom.code }), { code: 'INVALID_REVIEW' });
  assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM financial_case_review_history').all()), before);
  assert.equal(getFinancialCase({ ...f, ...targets[1] }).review.notes, 'Keep note');
});

test('seed definitions and menu assignment edits apply to new reviews while preserving original financial audit', t => {
  const f = fixture(t); f.kind = 'charges'; f.transactions = [tx('fee', { type: 'ServiceFee' })];
  const row = buildFinancialCases(f).items[0];
  const saved = saveFinancialCaseReview({ db: f.db, kind: f.kind, storeId: row.storeId, caseId: row.caseId,
    status: 'in_review', notes: 'Conferência existente.', expectedVersion: 0, now: at(22) });
  const originalAudit = getFinancialCase({ ...f, storeId: row.storeId, caseId: row.caseId }).reviewHistory;
  const definition = statusDefinition(f.db, 'in_review');
  saveReviewStatus(f.db, { ...definition, expectedVersion: definition.version, label: 'Análise da cobrança', color: 'red', menus: ['orders'] });
  const detail = getFinancialCase({ ...f, storeId: row.storeId, caseId: row.caseId });
  assert.equal(detail.review.label, 'Análise da cobrança');
  assert.equal(detail.review.color, 'red');
  assert.equal(detail.review.version, saved.version);
  assert.equal(detail.review.notes, saved.notes);
  assert.deepEqual(detail.reviewHistory, originalAudit);
  assert.equal(buildFinancialCases({ ...f, filters: { status: 'in_review' } }).total, 1);
  const note = saveFinancialCaseReview({ db: f.db, kind: f.kind, storeId: row.storeId, caseId: row.caseId,
    status: 'in_review', notes: 'Mais contexto.', expectedVersion: 1 });
  assert.equal(note.version, 2);
  const assigned = customStatus(f.db, { label: 'Cobrança esclarecida', menus: ['charges'], color: 'good', closesCase: true });
  saveFinancialCaseReview({ db: f.db, kind: f.kind, storeId: row.storeId, caseId: row.caseId,
    status: assigned.code, notes: note.notes, expectedVersion: 2 });
  assert.equal(buildFinancialCases(f).summary.resolvedCount, 1);
  assert.throws(() => saveFinancialCaseReview({ db: f.db, kind: f.kind, storeId: row.storeId, caseId: row.caseId,
    status: 'in_review', notes: '', expectedVersion: 3 }), { code: 'INVALID_REVIEW' });
});

test('initializing the catalog over a legacy review database preserves existing versions, notes and audit', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE financial_case_reviews (
    store_id TEXT NOT NULL,kind TEXT NOT NULL,case_id TEXT NOT NULL,status TEXT NOT NULL,notes TEXT NOT NULL,
    version INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(store_id,kind,case_id));
    CREATE TABLE financial_case_review_history (
    store_id TEXT NOT NULL,kind TEXT NOT NULL,case_id TEXT NOT NULL,version INTEGER NOT NULL,
    previous_status TEXT NOT NULL,status TEXT NOT NULL,previous_notes TEXT NOT NULL,notes TEXT NOT NULL,
    changed_at TEXT NOT NULL,PRIMARY KEY(store_id,kind,case_id,version));`);
  const caseId = `refunds-${'a'.repeat(64)}`;
  db.prepare('INSERT INTO financial_case_reviews VALUES(?,?,?,?,?,?,?)')
    .run('store-a', 'refunds', caseId, 'request_safe_t', 'Solicitação anterior.', 1, at(22));
  db.prepare('INSERT INTO financial_case_review_history VALUES(?,?,?,?,?,?,?,?,?)')
    .run('store-a', 'refunds', caseId, 1, 'pending', 'request_safe_t', '', 'Solicitação anterior.', at(22));
  const before = JSON.stringify(db.prepare('SELECT * FROM financial_case_reviews').all());
  const history = JSON.stringify(db.prepare('SELECT * FROM financial_case_review_history').all());
  ensureFinancialCaseSchema(db); ensureFinancialCaseSchema(db);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM financial_case_reviews').all()), before);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM financial_case_review_history').all()), history);
  assert.equal(statusDefinition(db, 'request_safe_t').label, 'Solicitar SAFE-T');
  const next = saveFinancialCaseReview({ db, storeId: 'store-a', kind: 'refunds', caseId,
    status: 'request_safe_t', notes: 'Protocolo acrescentado.', expectedVersion: 1, now: at(25) });
  assert.equal(next.version, 2);
  assert.equal(next.color, 'amber');
  assert.equal(db.prepare('SELECT previous_notes FROM financial_case_review_history WHERE version=2').get().previous_notes, 'Solicitação anterior.');
});
