import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Repository } from '../src/domain/repository.mjs';
import { SnapshotStore } from '../src/storage.mjs';

const at = day => `2026-09-${String(day).padStart(2, '0')}T12:00:00.000Z`;
const order = (orderId = 'order-shared') => ({
  orderId, createdTime: at(1), lastUpdatedTime: at(2),
  programs: ['DELIVERY_BY_AMAZON'],
  proceeds: { grandTotal: { amount: '100.00', currencyCode: 'BRL' } },
  orderItems: [{ orderItemId: 'item-a', quantityOrdered: 1,
    product: { sellerSku: 'SKU-TEST', title: 'Produto de teste', asin: 'ASIN-TEST' } }],
});
const refund = (transactionId = 'refund-shared', amount = '-80.00', extra = {}) => ({
  transactionId, transactionType: 'Refund', transactionStatus: 'DEFERRED', postedDate: at(3),
  totalAmount: { currencyAmount: amount, currencyCode: 'BRL' },
  relatedIdentifiers: [{ relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: 'order-shared' }],
  ...extra,
});
const breakdown = (breakdownType, amount, children = []) => ({ breakdownType,
  breakdownAmount: { currencyAmount: amount, currencyCode: 'BRL' }, breakdowns: children });

async function fixture(t) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'synth-financial-integration-'));
  const repo = new Repository({ rootDir, dbPath: path.join(rootDir, 'fixture.sqlite'), stores: [
    { storeId: 'store-a', name: 'Loja de teste A' },
    { storeId: 'store-b', name: 'Loja de teste B' },
  ] });
  t.after(async () => {
    repo.close();
    await rm(rootDir, { recursive: true, force: true });
  });
  async function snapshot(storeId, transactions, observedAt = at(10)) {
    const store = new SnapshotStore({ rootDir, storeId });
    const manifest = { id: randomUUID(), storeId, startedAt: observedAt, finishedAt: observedAt,
      status: 'collected-awaiting-validation', sources: [] };
    for (const [source, body] of [
      ['orders', JSON.stringify({ orders: [order()] })],
      ['transactions', JSON.stringify({ payload: { transactions } })],
    ]) {
      const saved = await store.savePage({ source, body });
      manifest.sources.push({ source, startedAt: observedAt, finishedAt: observedAt,
        status: 'api-pages-complete', dateBasis: source === 'orders' ? 'created' : 'posted',
        requestedWindow: { from: at(1), to: at(20) },
        pages: [{ ...saved, observedAt, page: 1, hasNextPage: false }],
      });
    }
    await store.saveRun(manifest);
    return manifest;
  }
  return { repo, snapshot };
}

test('refund review and history survive repeated imports, releases, and another refund for the same order', async t => {
  const { repo, snapshot } = await fixture(t);
  const initial = await snapshot('store-a', [refund()]);
  assert.equal((await repo.importRun(initial)).imported, true);
  const originalCase = repo.financialCases('refunds', { storeId: 'store-a' }).items[0];
  assert.equal(originalCase.totalCents, '-8000');
  assert.equal(originalCase.review.version, 0);
  const input = { kind: 'refunds', storeId: 'store-a', caseId: originalCase.caseId,
    status: 'request_safe_t', notes: 'Conferir comprovante de devolução.', expectedVersion: 0, now: at(11) };
  const saved = repo.saveFinancialReview(input);
  assert.equal(saved.version, 1);
  assert.equal(saved.status, 'request_safe_t');

  assert.equal((await repo.importRun(initial)).imported, false);
  await repo.importRun(await snapshot('store-a', [refund()], at(12)));
  const unchanged = repo.financialCaseDetail('refunds', 'store-a', originalCase.caseId);
  assert.deepEqual(unchanged.review, saved);
  assert.equal(unchanged.reviewHistory.length, 1);
  assert.equal(unchanged.reviewHistory[0].notes, input.notes);

  const original = refund('refund-shared', '-80.00', { transactionStatus: 'DEFERRED_RELEASED',
    relatedIdentifiers: [
      { relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: 'order-shared' },
      { relatedIdentifierName: 'RELEASE_TRANSACTION_ID', relatedIdentifierValue: 'refund-release' },
    ] });
  const released = refund('refund-release', '-80.00', { transactionStatus: 'RELEASED', postedDate: at(14),
    relatedIdentifiers: [
      { relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: 'order-shared' },
      { relatedIdentifierName: 'DEFERRED_TRANSACTION_ID', relatedIdentifierValue: 'refund-shared' },
    ] });
  await repo.importRun(await snapshot('store-a', [original, released,
    refund('refund-additional', '-5.00', { postedDate: at(15) })], at(16)));
  const updated = repo.financialCaseDetail('refunds', 'store-a', originalCase.caseId);
  assert.equal(repo.financialCases('refunds', { storeId: 'store-a' }).total, 1);
  assert.equal(updated.totalCents, '-8500');
  assert.equal(updated.refundCount, 2);
  assert.equal(updated.movementCount, 3);
  assert.equal(updated.lastEventAt, at(15));
  assert.deepEqual(updated.review, saved);
  assert.deepEqual(updated.reviewHistory, unchanged.reviewHistory);

  const second = repo.saveFinancialReview({ ...input, status: 'waiting_amazon',
    notes: 'Solicitação registrada para acompanhamento.', expectedVersion: 1, now: at(17) });
  assert.equal(second.version, 2);
  assert.throws(() => repo.saveFinancialReview({ ...input, notes: 'Edição de uma tela antiga.' }),
    { code: 'REVIEW_CONFLICT' });
  const final = repo.financialCaseDetail('refunds', 'store-a', originalCase.caseId);
  assert.deepEqual(final.review, second);
  assert.equal(final.reviewHistory.length, 2);
  assert.equal(final.reviewHistory[0].notes, input.notes);
  assert.equal(final.reviewHistory[1].previousNotes, input.notes);
  assert.equal(final.reviewHistory[1].notes, second.notes);
  assert.equal(final.totalCents, '-8500');
});

test('identical Amazon IDs in different stores keep independent reviews and unknown cases cannot be written', async t => {
  const { repo, snapshot } = await fixture(t);
  await snapshot('store-a', [refund()]);
  await snapshot('store-b', [refund('refund-shared', '-25.00')]);
  assert.deepEqual(await repo.loadWorkspace(), { imported: 2, skipped: 0, errors: [] });
  const a = repo.financialCases('refunds', { storeId: 'store-a' }).items[0];
  const b = repo.financialCases('refunds', { storeId: 'store-b' }).items[0];
  assert.notEqual(a.caseId, b.caseId);
  const savedA = repo.saveFinancialReview({ kind: 'refunds', storeId: 'store-a', caseId: a.caseId,
    status: 'in_review', notes: 'Observação exclusiva da loja A.', expectedVersion: 0, now: at(11) });
  assert.equal(repo.financialCaseDetail('refunds', 'store-b', b.caseId).review.version, 0);
  assert.equal(repo.financialCaseDetail('refunds', 'store-b', b.caseId).review.notes, '');
  const savedB = repo.saveFinancialReview({ kind: 'refunds', storeId: 'store-b', caseId: b.caseId,
    status: 'resolved', notes: 'Conferência da loja B encerrada.', expectedVersion: 0, now: at(12) });

  const unknownCase = `refunds-${'0'.repeat(64)}`;
  assert.equal(repo.financialCaseDetail('refunds', 'store-a', unknownCase), null);
  const changesBefore = repo.db.prepare('SELECT total_changes() AS count').get().count;
  for (const [storeId, caseId] of [['store-b', a.caseId], ['store-a', unknownCase]]) {
    assert.throws(() => repo.saveFinancialReview({ kind: 'refunds', storeId, caseId,
      status: 'resolved', notes: 'Não deve ser gravado.', expectedVersion: 0, now: at(13) }),
    { code: 'CASE_NOT_FOUND' });
  }
  assert.equal(repo.db.prepare('SELECT total_changes() AS count').get().count, changesBefore);
  assert.deepEqual(repo.financialCaseDetail('refunds', 'store-a', a.caseId).review, savedA);
  assert.deepEqual(repo.financialCaseDetail('refunds', 'store-b', b.caseId).review, savedB);
  assert.equal(repo.financialCases('refunds', { storeId: 'store-a', status: 'in_review' }).total, 1);
  assert.equal(repo.financialCases('refunds', { storeId: 'store-b', status: 'in_review' }).total, 0);
  assert.equal(repo.financialCaseDetail('refunds', 'store-a', a.caseId).totalCents, '-8000');
  assert.equal(repo.financialCaseDetail('refunds', 'store-b', b.caseId).totalCents, '-2500');
});

test('charge review accepts operational statuses without altering the imported financial evidence', async t => {
  const { repo, snapshot } = await fixture(t);
  const charge = refund('charge-a', '-2.35', { transactionType: 'ServiceFee', transactionStatus: 'RELEASED', relatedIdentifiers: [] });
  await repo.importRun(await snapshot('store-a', [charge, refund()]));
  const item = repo.financialCases('charges', { storeId: 'store-a' }).items[0];
  const financialBefore = repo.dashboard({ storeId: 'store-a' }).financeByCurrency;
  const evidenceBefore = repo.getEntityHistory('store-a', 'transactions', 'charge-a');
  assert.equal(item.totalCents, '-235');
  assert.equal(item.allocation, 'unlinked');
  assert.throws(() => repo.saveFinancialReview({ kind: 'charges', storeId: 'store-a', caseId: item.caseId,
    status: 'request_safe_t', notes: 'Status exclusivo de reembolso.', expectedVersion: 0, now: at(11) }),
  { code: 'INVALID_REVIEW' });
  const saved = repo.saveFinancialReview({ kind: 'charges', storeId: 'store-a', caseId: item.caseId,
    status: 'waiting_amazon', notes: 'Solicitada explicação da cobrança.', expectedVersion: 0, now: at(11) });
  assert.equal(saved.version, 1);
  assert.deepEqual(repo.dashboard({ storeId: 'store-a' }).financeByCurrency, financialBefore);
  assert.deepEqual(repo.getEntityHistory('store-a', 'transactions', 'charge-a'), evidenceBefore);
  assert.equal(repo.financialCases('refunds', { storeId: 'store-a' }).items[0].review.version, 0);
  assert.equal(repo.financialCaseDetail('charges', 'store-a', item.caseId).reviewHistory.length, 1);
});

test('known expenses leave the investigation queue while remaining in order and dashboard totals', async t => {
  const { repo, snapshot } = await fixture(t);
  const shipment = refund('shipment-a', '100.00', { transactionType: 'Shipment', transactionStatus: 'RELEASED' });
  const postage = refund('postage-a', '-12.34', { transactionType: 'ServiceFee', transactionStatus: 'RELEASED',
    breakdowns: [breakdown('Expenses', '-12.34', [breakdown('MFNPostageFee', '-12.34')])] });
  const storage = refund('storage-a', '-5.00', { transactionType: 'ServiceFee', transactionStatus: 'RELEASED',
    relatedIdentifiers: [], breakdowns: [breakdown('Expenses', '-5.00', [breakdown('FBAStorageFee', '-5.00')])] });
  const advertising = refund('advertising-a', '-3.00', { transactionType: 'ServiceFee', transactionStatus: 'RELEASED',
    relatedIdentifiers: [], breakdowns: [breakdown('Expenses', '-3.00', [breakdown('AdvertisingFee', '-3.00')])] });
  const otherService = refund('other-service-a', '-1.11', { transactionType: 'ServiceFee', transactionStatus: 'RELEASED',
    breakdowns: [breakdown('Expenses', '-1.11', [breakdown('OtherServiceFee', '-1.11')])] });
  await repo.importRun(await snapshot('store-a', [shipment, postage, storage, advertising, otherService]));

  const charges = repo.financialCases('charges', { storeId: 'store-a' });
  const chargeTransactions = charges.items.flatMap(item => item.transactions.map(transaction => transaction.transactionId));
  assert.deepEqual(new Set(chargeTransactions), new Set(['other-service-a']));
  assert.equal(charges.summary.byCurrency.find(row => row.currency === 'BRL').totalCents, '-111');

  const detail = repo.orderDetail('store-a', 'order-shared');
  assert.deepEqual(new Set(detail.transactions.map(item => item.transactionId)), new Set(['shipment-a', 'postage-a', 'other-service-a']));
  assert.equal(detail.transactions.find(item => item.transactionId === 'postage-a').totalCents, '-1234');
  const orderFinancial = detail.financial.byCurrency.find(row => row.currency === 'BRL');
  assert.equal(orderFinancial.netCents, '8655');
  assert.equal(orderFinancial.serviceFeeCents, '-1345');
  assert.equal(repo.orders({ storeId: 'store-a' }).items[0].financial.byCurrency[0].netCents, '8655');
  assert.equal(repo.dashboard({ storeId: 'store-a' }).financeByCurrency[0].netCents, '7855');
  const expenses = repo.dashboard({ storeId: 'store-a' }).platformExpenses.byCurrency[0];
  assert.equal(expenses.fbaStorageCents, '-500');
  assert.equal(expenses.adsCents, '-300');
  assert.equal(repo.getEntityHistory('store-a', 'transactions', 'postage-a').length, 1);
});

test('an explicit SAFE-T credit is linked to its store and refund without resolving the manual review', async t => {
  const { repo, snapshot } = await fixture(t);
  await repo.importRun(await snapshot('store-a', [refund()]));
  await repo.importRun(await snapshot('store-b', [refund()]));
  const initial = repo.financialCases('refunds', { storeId: 'store-a' }).items[0];
  const saved = repo.saveFinancialReview({ kind: 'refunds', storeId: 'store-a', caseId: initial.caseId,
    status: 'waiting_amazon', notes: 'Aguardando conferência do ressarcimento.', expectedVersion: 0, now: at(11) });
  const safeTCredit = refund('safe-t-credit', '60.00', { transactionType: 'Adjustment', transactionStatus: 'RELEASED',
    postedDate: at(12), breakdowns: [breakdown('Sales', '60.00', [breakdown('SAFETReimbursement', '60.00')])],
    items: [{ totalAmount: { currencyAmount: '60.00', currencyCode: 'BRL' },
      breakdowns: [breakdown('SAFETReimbursement', '60.00')] }] });
  const unrelatedAdjustment = refund('unclassified-credit', '900.00', { transactionType: 'Adjustment', transactionStatus: 'RELEASED',
    postedDate: at(13), breakdowns: [breakdown('Sales', '900.00', [breakdown('OtherAdjustment', '900.00')])] });
  const inventoryCredit = refund('inventory-credit', '3.00', { transactionType: 'Adjustment', transactionStatus: 'RELEASED',
    postedDate: at(14), breakdowns: [breakdown('Sales', '3.00', [breakdown('FBAInventoryReimbursement', '3.00')])] });
  const latest = await snapshot('store-a', [refund(), safeTCredit, unrelatedAdjustment, inventoryCredit], at(15));
  await repo.importRun(latest);

  const detail = repo.financialCaseDetail('refunds', 'store-a', initial.caseId);
  assert.equal(detail.reimbursement.identified, true);
  assert.deepEqual(detail.reimbursement.types.map(item => item.code), ['safe_t']);
  assert.equal(detail.reimbursement.credits.length, 1);
  assert.equal(detail.reimbursement.credits[0].transactionId, 'safe-t-credit');
  assert.equal(detail.reimbursement.credits[0].totalCents, '6000');
  assert.equal(detail.reimbursement.byCurrency.find(item => item.currency === 'BRL').totalCents, '6000');
  assert.equal(detail.reimbursement.lastCreditAt, at(12));
  assert.equal(detail.totalCents, '-8000');
  assert.equal(detail.refundCount, 1);
  assert.deepEqual(detail.review, saved);
  assert.equal(detail.reviewHistory.length, 1);
  assert.equal(repo.financialCases('refunds', { storeId: 'store-a', reimbursement: 'identified' }).total, 1);
  assert.equal(repo.financialCases('refunds', { storeId: 'store-a', reimbursement: 'safe_t' }).total, 1);
  assert.equal(repo.financialCases('refunds', { storeId: 'store-a', reimbursement: 'easy_ship' }).total, 0);
  assert.equal(repo.financialCases('refunds', { storeId: 'store-a', reimbursement: 'unidentified' }).total, 0);
  assert.equal(repo.financialCases('refunds', { storeId: 'store-b', reimbursement: 'identified' }).total, 0);
  assert.equal(repo.financialCases('refunds', { storeId: 'store-b', reimbursement: 'unidentified' }).total, 1);
  assert.equal(repo.financialCases('refunds', { storeId: 'store-b' }).items[0].review.version, 0);

  assert.equal((await repo.importRun(latest)).imported, false);
  const repeated = repo.financialCaseDetail('refunds', 'store-a', initial.caseId);
  assert.deepEqual(repeated.review, saved);
  assert.deepEqual(repeated.reviewHistory, detail.reviewHistory);
  assert.deepEqual(repeated.reimbursement, detail.reimbursement);
});

test('bulk repository review verifies every case before writing and survives imports without financial changes', async t => {
  const { repo, snapshot } = await fixture(t);
  const aRun = await snapshot('store-a', [refund()]);
  const bRun = await snapshot('store-b', [refund('refund-shared', '-25.00')]);
  await repo.importRun(aRun);
  await repo.importRun(bRun);
  const a = repo.financialCases('refunds', { storeId: 'store-a' }).items[0];
  const b = repo.financialCases('refunds', { storeId: 'store-b' }).items[0];
  const savedA = repo.saveFinancialReview({ kind: 'refunds', storeId: a.storeId, caseId: a.caseId,
    status: 'in_review', notes: 'Loja A: devolução em conferência.', expectedVersion: 0, now: at(11) });
  const savedB = repo.saveFinancialReview({ kind: 'refunds', storeId: b.storeId, caseId: b.caseId,
    status: 'waiting_amazon', notes: 'Loja B: guardar o protocolo.', expectedVersion: 0, now: at(11) });
  const selection = [a, b].map(item => ({ storeId: item.storeId, caseId: item.caseId, expectedVersion: 1 }));
  const financialBefore = repo.dashboard().financeByCurrency;
  const sourceBefore = repo.getEntityHistory('store-a', 'transactions', 'refund-shared');
  const missing = { storeId: 'store-a', caseId: `refunds-${'0'.repeat(64)}`, expectedVersion: 0 };
  for (const invalidItem of [missing, { ...selection[0], storeId: 'store-b' }]) {
    assert.throws(() => repo.saveFinancialReviews({ kind: 'refunds', status: 'resolved',
      items: [selection[0], invalidItem], now: at(12) }), { code: 'CASE_NOT_FOUND' });
    assert.deepEqual(repo.financialCaseDetail('refunds', a.storeId, a.caseId).review, savedA);
    assert.deepEqual(repo.financialCaseDetail('refunds', b.storeId, b.caseId).review, savedB);
  }
  const result = repo.saveFinancialReviews({ kind: 'refunds', items: selection, status: 'request_safe_t', now: at(12) });
  assert.equal(result.updatedCount, 2);
  assert.equal(result.unchangedCount, 0);
  assert.deepEqual(result.reviews.map(item => item.review.notes), [savedA.notes, savedB.notes]);
  assert.deepEqual(result.reviews.map(item => item.review.version), [2, 2]);

  assert.throws(() => repo.saveFinancialReviews({ kind: 'refunds', status: 'resolved', now: at(13),
    items: [{ ...selection[0], expectedVersion: 2 }, selection[1]] }), { code: 'REVIEW_CONFLICT' });
  await repo.importRun(aRun);
  await repo.importRun(bRun);
  await repo.importRun(await snapshot('store-a', [refund()], at(14)));
  for (const item of result.reviews) {
    const detail = repo.financialCaseDetail('refunds', item.storeId, item.caseId);
    assert.deepEqual(detail.review, item.review);
    assert.equal(detail.reviewHistory.length, 2);
    assert.equal(detail.reviewHistory[1].previousNotes, item.review.notes);
    assert.equal(detail.reviewHistory[1].notes, item.review.notes);
    assert.equal(detail.reimbursement.identified, false);
  }
  assert.deepEqual(repo.dashboard().financeByCurrency, financialBefore);
  assert.deepEqual(repo.getEntityHistory('store-a', 'transactions', 'refund-shared')[0], sourceBefore[0]);
  const resolved = repo.saveFinancialReviews({ kind: 'refunds', status: 'resolved', now: at(15),
    items: result.reviews.map(item => ({ storeId: item.storeId, caseId: item.caseId, expectedVersion: item.review.version })) });
  assert.equal(resolved.updatedCount, 2);
  assert.equal(repo.financialCaseDetail('refunds', a.storeId, a.caseId).reimbursement.identified, false);
  assert.equal(repo.financialCaseDetail('refunds', b.storeId, b.caseId).reimbursement.identified, false);
  assert.deepEqual(repo.dashboard().financeByCurrency, financialBefore);
});
