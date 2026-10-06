import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Repository } from '../src/domain/repository.mjs';
import { SnapshotStore } from '../src/storage.mjs';
import { MISSING_ORDER_IMPORT } from '../src/order-enrichment.mjs';
import { returnsView } from '../src/domain/returns.mjs';

const at = day => `2026-09-${String(day).padStart(2, '0')}T12:00:00.000Z`;
const marketplaceId = 'MARKET-TEST';
const order = (orderId, extra = {}) => ({
  orderId, createdTime: at(1), lastUpdatedTime: at(2), salesChannel: { marketplaceId },
  programs: ['DELIVERY_BY_AMAZON'], fulfillment: { fulfillmentStatus: 'SHIPPED', fulfilledBy: 'MERCHANT' },
  orderItems: [{ orderItemId: `item-${orderId}`, quantityOrdered: 1,
    product: { sellerSku: 'SKU-TEST', asin: 'ASIN-TEST', title: 'Produto de teste' } }],
  ...extra,
});
const refund = (orderId, amount = '-20.00') => ({
  transactionId: `refund-${orderId}`, transactionType: 'Refund', transactionStatus: 'RELEASED', postedDate: at(3),
  totalAmount: { currencyAmount: amount, currencyCode: 'BRL' },
  relatedIdentifiers: [{ relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: orderId }],
});
const tables = ['stores', 'runs', 'coverage', 'entities', 'observations', 'source_state',
  'financial_case_reviews', 'financial_case_review_history', 'local_reviews', 'local_review_history', 'tracking_observations'];
const rows = (repo, table) => repo.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
const databaseState = repo => Object.fromEntries(tables.map(table => [table, rows(repo, table)]));

async function fixture(t) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'synth-order-enrichment-import-'));
  const repo = new Repository({ rootDir, dbPath: path.join(rootDir, 'fixture.sqlite'), stores: [
    { storeId: 'store-a', name: 'Loja A', marketplaceId }, { storeId: 'store-b', name: 'Loja B', marketplaceId },
  ] });
  t.after(async () => { repo.close(); await rm(rootDir, { recursive: true, force: true }); });
  async function regular(storeId, sources, observedAt = at(10)) {
    const store = new SnapshotStore({ rootDir, storeId });
    const manifest = { id: randomUUID(), storeId, marketplaceId, startedAt: observedAt, finishedAt: observedAt,
      status: 'collected-awaiting-validation', sources: [] };
    for (const [source, records] of Object.entries(sources)) {
      const body = JSON.stringify(source === 'orders' ? { orders: records } : { payload: { transactions: records } });
      const saved = await store.savePage({ source, body });
      manifest.sources.push({ source, status: 'api-pages-complete', dateBasis: source === 'orders' ? 'created' : 'posted',
        requestedWindow: { from: at(1), to: at(10) }, pages: [{ ...saved, observedAt, hasNextPage: false }] });
    }
    await repo.importRun(manifest);
    return manifest;
  }
  async function targeted(storeId, entries, observedAt = at(20)) {
    const store = new SnapshotStore({ rootDir, storeId });
    const source = { source: 'orders', operation: 'getOrder', includedData: ['PACKAGES', 'FULFILLMENT'],
      status: 'targeted-observations', dateBasis: 'order-id', requestedWindow: null,
      requestedOrderIds: entries.map(entry => entry.orderId), pages: [] };
    for (const entry of entries) {
      const body = entry.rawBody ?? JSON.stringify({ order: entry.order ?? order(entry.orderId) });
      const saved = await store.savePage({ source: 'orders', body });
      source.pages.push({ ...saved, requestedOrderId: entry.orderId, records: 1, hasNextPage: false, observedAt });
    }
    return { id: randomUUID(), storeId, marketplaceId, importMode: MISSING_ORDER_IMPORT,
      status: 'targeted-observations', startedAt: observedAt, finishedAt: observedAt, sources: [source] };
  }
  return { repo, rootDir, regular, targeted };
}

test('individual order envelope preserves raw numeric precision and never claims complete history', async t => {
  const { repo, rootDir, regular, targeted } = await fixture(t);
  await regular('store-a', { orders: [] });
  const priorState = rows(repo, 'source_state');
  const priorSync = repo.getBootstrap().latestSync;
  const rawBody = JSON.stringify({ order: order('precise', {
    proceeds: { grandTotal: { amount: 'EXACT-DECIMAL', currencyCode: 'BRL' } },
  }) }).replace('"EXACT-DECIMAL"', '9007199254740993.13');
  const manifest = await targeted('store-a', [{ orderId: 'precise', rawBody }]);
  const result = await repo.importRun(manifest);
  assert.equal(result.insertedOrders, 1);
  assert.equal(repo.orderDetail('store-a', 'precise').grandTotalCents, '900719925474099313');
  assert.equal(repo.orderDetail('store-a', 'precise').fulfillmentMode, 'DBA');
  assert.deepEqual(rows(repo, 'source_state'), priorState);
  assert.equal(repo.getBootstrap().latestSync, priorSync);
  const coverage = rows(repo, 'coverage').find(item => item.run_id === manifest.id);
  assert.equal(coverage.status, 'targeted-observations');
  assert.equal(coverage.date_basis, 'order-id');
  assert.equal(coverage.from_at, null);
  assert.equal(coverage.to_at, null);
  const store = new SnapshotStore({ rootDir, storeId: 'store-a' });
  assert.equal(await store.readPage({ source: 'orders', hash: manifest.sources[0].pages[0].hash }), rawBody);
  const state = databaseState(repo);
  assert.equal((await repo.importRun(manifest)).imported, false);
  assert.deepEqual(databaseState(repo), state);

  await repo.importRun(await targeted('store-b', [{ orderId: 'precise' }]));
  assert.equal(rows(repo, 'source_state').some(item => item.store_id === 'store-b'), false);
  assert.equal(repo.orderDetail('store-b', 'precise').grandTotalCents, null);
  assert.equal(repo.orderDetail('store-a', 'precise').grandTotalCents, '900719925474099313');
});

test('insert-only imports preserve existing orders, observations, finances and manual reviews while linking previous refunds', async t => {
  const { repo, regular, targeted } = await fixture(t);
  await regular('store-a', { orders: [order('existing')], transactions: [refund('existing'), refund('new-order', '-35.00')] });
  await regular('store-b', { orders: [order('new-order')], transactions: [refund('new-order', '-90.00')] });
  const cases = repo.financialCases('refunds', { storeId: 'store-a' }).items;
  const newCase = cases.find(item => item.orderIds.includes('new-order'));
  for (const item of cases) repo.saveFinancialReview({ kind: 'refunds', storeId: 'store-a', caseId: item.caseId,
    status: 'request_safe_t', notes: `Nota preservada ${item.caseId}`, expectedVersion: 0, now: at(11) });
  repo.saveLocalReview({ menu: 'orders', storeId: 'store-a', entityId: 'existing', status: 'in_review',
    notes: 'Conferência manual do pedido.', expectedVersion: 0, now: at(11) });
  const manifest = await targeted('store-a', [
    { orderId: 'existing', order: order('existing', { fulfillment: { fulfillmentStatus: 'CANCELLED', fulfilledBy: 'MERCHANT' } }) },
    { orderId: 'new-order' }, { orderId: 'arrived-during-fetch' },
  ]);
  // Simulate another importer inserting a candidate after selection/fetch and before import.
  await regular('store-a', { orders: [order('arrived-during-fetch')] }, at(19));
  const before = databaseState(repo);
  const beforeFinancial = repo.dashboard({ storeId: 'store-a' }).financeByCurrency;
  const beforeReview = repo.financialCaseDetail('refunds', 'store-a', newCase.caseId).review;
  const result = await repo.importRun(manifest);
  assert.equal(result.insertedOrders, 1);
  assert.equal(result.skippedExistingOrders, 2);
  for (const table of ['financial_case_reviews', 'financial_case_review_history', 'local_reviews', 'local_review_history', 'source_state', 'tracking_observations']) {
    assert.deepEqual(rows(repo, table), before[table], table);
  }
  const protectedRows = list => list.filter(item => !(item.store_id === 'store-a' && item.source === 'orders' && item.source_id === 'new-order'));
  for (const table of ['entities', 'observations']) assert.deepEqual(protectedRows(rows(repo, table)), before[table], table);
  assert.deepEqual(repo.dashboard({ storeId: 'store-a' }).financeByCurrency, beforeFinancial);
  assert.equal(repo.orderDetail('store-a', 'existing').status, 'SHIPPED');
  assert.equal(repo.orderDetail('store-a', 'new-order').financial.byCurrency[0].netCents, '-3500');
  assert.equal(repo.orderDetail('store-b', 'new-order').financial.byCurrency[0].netCents, '-9000');
  assert.equal(repo.orderDetail('store-a', 'new-order').transactions[0].transactionId, 'refund-new-order');
  assert.deepEqual(repo.financialCaseDetail('refunds', 'store-a', newCase.caseId).review, beforeReview);
});

test('a newly imported returned package records first observation rather than inventing a historical return date', async t => {
  const { repo, regular, targeted } = await fixture(t);
  await regular('store-a', { transactions: [refund('returned')] });
  await repo.importRun(await targeted('store-a', [{ orderId: 'returned', order: order('returned', { packages: [
    { packageReferenceId: 'package-a', trackingNumber: 'TRACK-TEST', shipTime: at(2), createdTime: at(1),
      packageStatus: { status: 'UNDELIVERABLE', detailedStatus: 'RETURNED_TO_SELLER' } },
  ] }) }]));
  const first = returnsView({ db: repo.db, now: new Date(at(21)) }).items[0];
  assert.equal(first.detectedAt, at(20));
  assert.equal(first.detectionKind, 'already-returned');
  assert.equal(first.transitionDetectedAt, null);
  assert.equal(first.previousObservedAt, null);
  assert.equal(first.alert.state, 'needs-confirmation');
  assert.equal(first.alert.referenceAt, null);
  assert.equal(first.alert.dueAt, null);
});

test('identity mismatches on a later page reject the entire import before any database write', async t => {
  const { repo, targeted } = await fixture(t);
  for (const invalidOrder of [order('different-id'), order('invalid', { salesChannel: { marketplaceId: 'OTHER-MARKET' } })]) {
    const manifest = await targeted('store-a', [{ orderId: 'valid' }, { orderId: 'invalid', order: invalidOrder }]);
    const before = databaseState(repo);
    await assert.rejects(repo.importRun(manifest));
    assert.deepEqual(databaseState(repo), before);
    assert.equal(repo.orderDetail('store-a', 'valid'), null);
  }
});

test('mixed sources, false complete coverage and fabricated filtering provenance are rejected atomically', async t => {
  const { repo, targeted } = await fixture(t);
  const valid = await targeted('store-a', [{ orderId: 'target' }]);
  const variants = [
    manifest => manifest.sources.push({ source: 'transactions', status: 'api-pages-complete', pages: [] }),
    manifest => { manifest.status = 'api-pages-complete'; },
    manifest => { manifest.sources[0].status = 'api-pages-complete'; },
    manifest => { manifest.sources[0].requestedWindow = { from: at(1), to: at(20) }; },
    manifest => { manifest.sources[0].pages[0].requestFilters = { fulfilledBy: ['AMAZON'] }; },
    manifest => { manifest.sources[0].requestedFulfilledBy = ['AMAZON', 'MERCHANT']; },
    manifest => { manifest.sources[0].requestedOrderIds = ['some-other-order']; },
    manifest => { manifest.sources[0].includedData.push('BUYER'); },
    manifest => { delete manifest.importMode; },
  ];
  for (const mutate of variants) {
    const manifest = structuredClone(valid); manifest.id = randomUUID(); mutate(manifest);
    const before = databaseState(repo);
    await assert.rejects(repo.importRun(manifest));
    assert.deepEqual(databaseState(repo), before);
  }
});
