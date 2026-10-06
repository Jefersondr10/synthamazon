import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Repository } from '../src/domain/repository.mjs';
import { SnapshotStore } from '../src/storage.mjs';

const at = day => `2026-09-${String(day).padStart(2, '0')}T12:00:00.000Z`;
const ref = (name, value) => ({ relatedIdentifierName: name, relatedIdentifierValue: value });
const refund = (transactionId, extra = {}) => ({
  transactionId, transactionType: 'Refund', transactionStatus: 'DEFERRED', postedDate: at(3),
  totalAmount: { currencyAmount: '-80.00', currencyCode: 'BRL' }, relatedIdentifiers: [], ...extra,
});
function pair({ originalOrder, releasedOrder, amount = '-80.00' } = {}) {
  return [refund('original', { transactionStatus: 'DEFERRED_RELEASED',
    totalAmount: { currencyAmount: amount, currencyCode: 'BRL' }, relatedIdentifiers: [
      ref('RELEASE_TRANSACTION_ID', 'release'), ...(originalOrder ? [ref('ORDER_ID', originalOrder)] : []),
    ] }), refund('release', { transactionStatus: 'RELEASED', postedDate: at(12),
    totalAmount: { currencyAmount: amount, currencyCode: 'BRL' }, relatedIdentifiers: [
      ref('DEFERRED_TRANSACTION_ID', 'original'), ...(releasedOrder ? [ref('ORDER_ID', releasedOrder)] : []),
    ] })];
}
async function fixture(t) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'synth-orphan-refund-charges-'));
  const repo = new Repository({ rootDir, dbPath: path.join(rootDir, 'fixture.sqlite'), stores: [
    { storeId: 'store-a', name: 'Loja A' }, { storeId: 'store-b', name: 'Loja B' },
  ] });
  t.after(async () => { repo.close(); await rm(rootDir, { recursive: true, force: true }); });
  async function snapshot(storeId, transactions, observedAt = at(15), orders) {
    const store = new SnapshotStore({ rootDir, storeId });
    const sources = [['transactions', JSON.stringify({ payload: { transactions } })]];
    if (orders) sources.push(['orders', JSON.stringify({ orders })]);
    const manifest = { id: randomUUID(), storeId, startedAt: observedAt, finishedAt: observedAt,
      status: 'collected-awaiting-validation', sources: [] };
    for (const [source, body] of sources) {
      const saved = await store.savePage({ source, body });
      manifest.sources.push({ source, status: 'api-pages-complete', dateBasis: source === 'orders' ? 'created' : 'posted',
        requestedWindow: { from: at(1), to: at(20) },
        pages: [{ ...saved, observedAt, hasNextPage: false }] });
    }
    await store.saveRun(manifest);
    await repo.importRun(manifest);
    return manifest;
  }
  const charges = (storeId = 'store-a') => repo.financialCases('charges', { storeId });
  const dbRows = table => repo.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  return { repo, snapshot, charges, dbRows };
}

test('an ORDER_ID on either side of explicit refund release references excludes the entire group from charges even without an order entity', async t => {
  const { repo, snapshot, charges } = await fixture(t);
  await snapshot('store-a', pair({ releasedOrder: 'missing-order' }));
  await snapshot('store-b', pair({ originalOrder: 'missing-order' }));
  for (const storeId of ['store-a', 'store-b']) {
    assert.equal(repo.orderDetail(storeId, 'missing-order'), null);
    assert.equal(charges(storeId).total, 0);
    const grouped = repo.financialCases('refunds', { storeId });
    assert.equal(grouped.total, 1);
    assert.deepEqual(grouped.items[0].orderIds, ['missing-order']);
    assert.equal(grouped.items[0].totalCents, '-8000');
    assert.equal(grouped.items[0].movementCount, 2);
    assert.equal(repo.dashboard({ storeId }).financeByCurrency[0].refundCents, '-8000');
  }
});

test('orphan original and release count once with precise cents while an independent identical refund remains separate', async t => {
  const { repo, snapshot, charges, dbRows } = await fixture(t);
  const amount = '-9007199254740993.13';
  const manifest = await snapshot('store-a', [...pair({ amount }), refund('independent', {
    transactionStatus: 'RELEASED', totalAmount: { currencyAmount: amount, currencyCode: 'BRL' },
  })]);
  const before = { entities: dbRows('entities'), observations: dbRows('observations'), finance: repo.dashboard().financeByCurrency };
  const result = charges();
  assert.equal(result.total, 2);
  assert.ok(result.items.every(item => item.type === 'Refund' && item.typeLabel === 'Reembolso sem pedido'));
  const original = result.items.find(item => item.transactions.some(transaction => transaction.transactionId === 'original'));
  assert.equal(original.totalCents, '-900719925474099313');
  assert.equal(original.movementCount, 2);
  assert.equal(original.transactions.filter(item => item.countsInTotal).length, 1);
  assert.deepEqual(original.orderIds, []);
  assert.equal(original.allocation, 'unlinked');
  assert.equal(result.summary.byCurrency[0].totalCents, '-1801439850948198626');
  assert.equal(repo.dashboard().financeByCurrency[0].refundCents, '-1801439850948198626');
  assert.equal((await repo.importRun(manifest)).imported, false);
  assert.deepEqual(dbRows('entities'), before.entities);
  assert.deepEqual(dbRows('observations'), before.observations);
  assert.deepEqual(repo.dashboard().financeByCurrency, before.finance);
  assert.equal(charges().total, 2);
});

test('linking an orphan refund later removes it from charges without removing financial evidence or legacy reviews', async t => {
  const { repo, snapshot, charges, dbRows } = await fixture(t);
  await snapshot('store-a', pair());
  const legacyCase = repo.financialCases('refunds', { storeId: 'store-a' }).items[0];
  const legacyReview = repo.saveFinancialReview({ kind: 'refunds', storeId: 'store-a', caseId: legacyCase.caseId,
    status: 'in_review', notes: 'Histórico original do reembolso.', expectedVersion: 0, now: at(16) });
  const charge = charges().items[0];
  const detail = repo.financialCaseDetail('charges', 'store-a', charge.caseId);
  assert.equal(detail.typeLabel, 'Reembolso sem pedido');
  assert.equal(detail.legacyReviews.length, 1);
  assert.equal(detail.legacyReviews[0].caseId, legacyCase.caseId);
  assert.deepEqual(detail.legacyReviews[0].review, legacyReview);
  assert.equal(detail.legacyReviews[0].history.length, 1);
  const chargeReview = repo.saveFinancialReview({ kind: 'charges', storeId: 'store-a', caseId: charge.caseId,
    status: 'waiting_amazon', notes: 'Investigação na fila de cobranças.', expectedVersion: 0, now: at(17) });
  assert.equal(chargeReview.version, 1);
  const before = { reviews: dbRows('financial_case_reviews'), history: dbRows('financial_case_review_history'),
    finance: repo.dashboard().financeByCurrency, observations: dbRows('observations') };
  const linked = pair({ releasedOrder: 'newly-linked-order' });
  // A later partial snapshot contains just the release, now with its ORDER_ID.
  await snapshot('store-a', [linked[1]], at(18));
  assert.equal(charges().total, 0);
  assert.equal(repo.financialCaseDetail('charges', 'store-a', charge.caseId), null);
  assert.deepEqual(repo.dashboard().financeByCurrency, before.finance);
  assert.deepEqual(dbRows('financial_case_reviews'), before.reviews);
  assert.deepEqual(dbRows('financial_case_review_history'), before.history);
  assert.deepEqual(dbRows('observations').slice(0, before.observations.length), before.observations);
  assert.equal(repo.getEntityHistory('store-a', 'transactions', 'original').length, 1);
  assert.equal(repo.getEntityHistory('store-a', 'transactions', 'release').length, 2);
  const refundCase = repo.financialCases('refunds', { storeId: 'store-a' }).items[0];
  assert.deepEqual(refundCase.orderIds, ['newly-linked-order']);
  assert.equal(refundCase.totalCents, '-8000');
  assert.equal(refundCase.movementCount, 2);
  const linkedDetail = repo.financialCaseDetail('refunds', 'store-a', refundCase.caseId);
  assert.deepEqual(linkedDetail.legacyReviews.find(item => item.kind === 'refunds' && item.caseId === legacyCase.caseId).review, legacyReview);
  assert.deepEqual(linkedDetail.legacyReviews.find(item => item.kind === 'charges' && item.caseId === charge.caseId).review, chargeReview);
  assert.equal(linkedDetail.review.version, 0, 'Legacy reviews stay separate from the new linked case review');
});

test('the same refund IDs and release references in another store cannot link or inherit an orphan charge review', async t => {
  const { repo, snapshot, charges } = await fixture(t);
  await snapshot('store-a', pair());
  await snapshot('store-b', pair({ releasedOrder: 'order-b' }));
  const a = charges('store-a').items[0];
  assert.equal(charges('store-b').total, 0);
  const saved = repo.saveFinancialReview({ kind: 'charges', storeId: 'store-a', caseId: a.caseId,
    status: 'in_review', notes: 'Somente loja A.', expectedVersion: 0, now: at(16) });
  assert.equal(repo.financialCaseDetail('charges', 'store-b', a.caseId), null);
  const b = repo.financialCases('refunds', { storeId: 'store-b' }).items[0];
  assert.equal(b.review.version, 0);
  assert.equal(b.review.notes, '');
  assert.deepEqual(repo.financialCaseDetail('charges', 'store-a', a.caseId).review, saved);
  assert.equal(repo.financialCases('charges', { storeId: 'all' }).total, 1);
  assert.equal(repo.dashboard().financeByCurrency[0].refundCents, '-16000');
});
