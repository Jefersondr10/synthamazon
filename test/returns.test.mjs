import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { ensureReturnSchema, recordTrackingObservation, latestTracking, latestTrackingIndex, returnsView, mergeTrackingPackages } from '../src/domain/returns.mjs';
import { saveLocalReview } from '../src/domain/local-reviews.mjs';

const at = day => `2026-09-${String(day).padStart(2, '0')}T12:00:00.000Z`;
const pkg = (detailedStatus, extra = {}) => ({ packageReferenceId: 'package-a', trackingNumber: 'TRACK-A', status: 'DELIVERED', detailedStatus, ...extra });
const originalRefund = (id = 'refund-a', day = 4, extra = {}) => ({
  transactionId: id, storeId: 'store-a', type: 'Refund', status: 'RELEASED', postedAt: at(day),
  orderIds: ['order-a'], totalCents: '-10000', currency: 'BRL', deferredTransactionIds: [], releaseTransactionIds: [], ...extra,
});

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE stores (store_id TEXT PRIMARY KEY,name TEXT);
    CREATE TABLE entities (store_id TEXT,source TEXT,source_id TEXT,observed_at TEXT,payload_json TEXT,PRIMARY KEY(store_id,source,source_id));
    CREATE TABLE observations (store_id TEXT,source TEXT,source_id TEXT,observed_at TEXT,run_id TEXT,version_hash TEXT,payload_json TEXT);`);
  db.prepare('INSERT INTO stores VALUES(?,?)').run('store-a', 'Loja A');
  db.prepare('INSERT INTO stores VALUES(?,?)').run('store-b', 'Loja B');
  ensureReturnSchema(db);
  t.after(() => db.close());
  function order(day, packages, extra = {}) {
    const item = { storeId: 'store-a', orderId: 'order-a', createdAt: '2026-01-01T12:00:00.000Z', status: 'SHIPPED', fulfillmentMode: 'DBA',
      items: [{ sku: 'sku-eletronico', title: 'Produto exemplo' }], observedAt: at(day), packages, ...extra };
    const payload = JSON.stringify(item);
    db.prepare('INSERT INTO observations VALUES(?,?,?,?,?,?,?)').run(item.storeId, 'orders', item.orderId, item.observedAt, randomUUID(), randomUUID(), payload);
    const prior = db.prepare('SELECT observed_at FROM entities WHERE store_id=? AND source=? AND source_id=?').get(item.storeId, 'orders', item.orderId);
    if (!prior || prior.observed_at <= item.observedAt) db.prepare('INSERT OR REPLACE INTO entities VALUES(?,?,?,?,?)').run(item.storeId, 'orders', item.orderId, item.observedAt, payload);
    return item;
  }
  function transaction(item) {
    db.prepare('INSERT OR REPLACE INTO entities VALUES(?,?,?,?,?)').run(item.storeId, 'transactions', item.transactionId, at(20), JSON.stringify(item));
  }
  const tracking = (day, packages, extra = {}) => recordTrackingObservation(db, { storeId: 'store-a', orderId: 'order-a', observedAt: at(day), packages, ...extra });
  const view = (options = {}) => returnsView({ db, now: new Date(at(8)), ...options });
  return { db, order, transaction, tracking, view };
}

test('batch tracking reads preserve partial histories and isolate identical order IDs by store', t => {
  const { db, tracking } = fixture(t);
  tracking(1, [pkg('IN_TRANSIT')]);
  tracking(3, [pkg('DELIVERED', { trackingNumber: null })]);
  tracking(4, []);
  tracking(2, [pkg('RETURNED_TO_SELLER')], { storeId: 'store-b' });
  tracking(2, [pkg('IN_TRANSIT')], { orderId: 'order-b' });
  const indexed = latestTrackingIndex(db);
  for (const [key, value] of indexed) {
    const [storeId, orderId] = JSON.parse(key);
    assert.deepEqual(value, latestTracking(db, { storeId, orderId }));
  }
  assert.equal(indexed.size, 3);
  assert.equal(latestTrackingIndex(db, 'store-a').size, 2);
  assert.ok([...latestTrackingIndex(db, 'store-b').keys()].every(key => JSON.parse(key)[0] === 'store-b'));
});

test('a same-package transition keeps its first episode through repeated queries and later status changes', t => {
  const { order, transaction, tracking, view } = fixture(t);
  order(1, [pkg('IN_TRANSIT')]); order(3, [pkg('RETURNED_TO_SELLER')]); transaction(originalRefund());
  const first = view().items[0];
  assert.equal(first.detectedAt, at(3));
  assert.equal(first.transitionDetectedAt, at(3));
  assert.equal(first.previousObservedAt, at(1));
  assert.equal(first.detectionKind, 'transition');
  assert.equal(first.alert.referenceAt, at(4));
  assert.equal(first.alert.dueAt, at(9));
  assert.equal(first.alert.state, 'open');
  assert.equal(first.alert.daysRemaining, 1);
  tracking(5, [pkg('RETURNED_TO_SELLER')]); tracking(7, [pkg('IN_TRANSIT')]); tracking(8, [pkg('RETURNED_TO_SELLER')]);
  const repeated = view().items[0];
  assert.equal(repeated.detectedAt, first.detectedAt);
  assert.equal(repeated.occurrenceId, first.occurrenceId);
  tracking(10, [pkg('DELIVERED')]);
  const changed = view().items[0];
  assert.equal(changed.detectedAt, at(3));
  assert.equal(changed.returnStatusChanged, true);
  assert.equal(changed.detailedStatus, 'DELIVERED');
  assert.equal(changed.currentReturnedPackageCount, 0);
  assert.equal(changed.returnedPackageCount, 1);
});

test('first observed returned needs confirmation even when a refund exists', t => {
  const { order, transaction, view } = fixture(t);
  order(3, [pkg('RETURNED_TO_SELLER')]); transaction(originalRefund());
  const row = view().items[0];
  assert.equal(row.detectionKind, 'already-returned');
  assert.equal(row.transitionDetectedAt, null);
  assert.equal(row.previousObservedAt, null);
  assert.equal(row.alert.state, 'needs-confirmation');
  assert.equal(row.alert.dueAt, null);
  assert.equal(row.alert.basis, null);
});

test('pending payment exclusions preserve physical return history and notes without refund alerts or financial counts', t => {
  const { db, order, transaction, view } = fixture(t);
  order(1, [pkg('IN_TRANSIT')], { status: 'PENDING' });
  order(3, [pkg('RETURNED_TO_SELLER')], { status: 'pending' });
  order(3, [pkg('RETURNED_TO_SELLER')], { orderId: 'preorder', status: 'PENDING_AVAILABILITY' });
  order(3, [pkg('RETURNED_TO_SELLER')], { storeId: 'store-b', status: 'UNSHIPPED' });
  transaction(originalRefund('refund-a', 4, { totalCents: '-900719925474099313' }));
  transaction(originalRefund('refund-a', 4, { storeId: 'store-b' }));
  saveLocalReview(db, { menu: 'returns', storeId: 'store-a', entityId: 'order-a', status: 'in_review',
    notes: 'Aguardar conferência física.', expectedVersion: 0, now: at(5) });
  const snapshot = () => JSON.stringify({ entities: db.prepare('SELECT * FROM entities').all(),
    observations: db.prepare('SELECT * FROM observations').all(), reviews: db.prepare('SELECT * FROM local_reviews').all() });
  const before = snapshot();
  const result = view({ filters: { limit: 1 } }), row = result.items[0];
  assert.equal(result.total, 3); assert.equal(result.summary.excludedPaymentPendingCount, 2);
  assert.equal(result.summary.withRefund, 1); assert.equal(result.summary.withoutRefundEvidence, 0);
  assert.equal(result.summary.transitions, 1); assert.equal(result.summary.alreadyReturned, 2);
  assert.equal(row.occurrenceId, view().items.find(item => item.orderId === 'order-a' && item.storeId === 'store-a').occurrenceId);
  assert.equal(row.detectedAt, at(3)); assert.equal(row.transitionDetectedAt, at(3));
  assert.equal(row.previousObservedAt, at(1)); assert.equal(row.returnedPackageCount, 1);
  assert.deepEqual(row.financialEligibility, { included: false, reason: 'payment-pending' });
  assert.equal(row.refund.status, 'recorded'); assert.equal(row.refund.transactions[0].totalCents, '-900719925474099313');
  assert.deepEqual(row.refund.financialEligibility, row.financialEligibility);
  assert.equal(row.refund.transactions[0].financialEligibility.included, false);
  assert.deepEqual(row.alert, { state: 'financial-excluded', referenceAt: null, dueAt: null, daysRemaining: null, basis: null });
  assert.equal(row.review.notes, 'Aguardar conferência física.'); assert.equal(row.review.version, 1);
  assert.equal(view({ filters: { status: 'refunded' } }).total, 1);
  assert.equal(view({ filters: { status: 'without_refund' } }).total, 0);
  assert.equal(snapshot(), before, 'Projection does not rewrite tracking, imported financial evidence or manual work');
  order(9, [pkg('RETURNED_TO_SELLER')], { status: 'UNSHIPPED' });
  const eligible = view().items.find(item => item.orderId === 'order-a' && item.storeId === 'store-a');
  assert.equal(eligible.financialEligibility.included, true); assert.equal(eligible.alert.dueAt, at(9));
  assert.equal(eligible.detectedAt, at(3)); assert.equal(eligible.review.version, 1);
});

test('refund release groups linked to another pending order are excluded before per-order projection', t => {
  const { order, transaction, view } = fixture(t);
  order(1, [pkg('IN_TRANSIT')]); order(3, [pkg('RETURNED_TO_SELLER')]);
  order(3, [], { orderId: 'pending-fba', status: 'PENDING_AVAILABILITY', fulfillmentMode: 'FBA' });
  order(3, [pkg('RETURNED_TO_SELLER')], { storeId: 'store-b' });
  transaction(originalRefund('original', 4, { status: 'DEFERRED_RELEASED', orderIds: ['pending-fba'], releaseTransactionIds: ['release'] }));
  transaction(originalRefund('release', 6, { deferredTransactionIds: ['original'] }));
  transaction(originalRefund('release', 6, { storeId: 'store-b' }));
  const rows = view().items;
  const mixed = rows.find(row => row.storeId === 'store-a');
  assert.equal(mixed.orderStatus, 'SHIPPED'); assert.equal(mixed.refund.status, 'recorded');
  assert.equal(mixed.refund.transactions[0].transactionId, 'release');
  assert.equal(mixed.financialEligibility.included, false); assert.equal(mixed.refund.financialEligibility.included, false);
  assert.equal(mixed.alert.state, 'financial-excluded'); assert.equal(mixed.detectedAt, at(3));
  assert.equal(rows.find(row => row.storeId === 'store-b').financialEligibility.included, true);
  assert.equal(view().summary.withRefund, 1); assert.equal(view().summary.excludedPaymentPendingCount, 1);
});

test('missing packages or detailed statuses do not establish a previous non-returned state', t => {
  const { order, tracking, view } = fixture(t);
  order(1, []); order(2, [pkg(null, { status: 'IN_TRANSIT' })]); order(3, [pkg('RETURNED_TO_SELLER')]);
  assert.equal(view().items[0].detectionKind, 'already-returned');
  tracking(4, []); tracking(5, [pkg(null, { status: null })]);
  assert.equal(view().items[0].returnStatusChanged, false);
  assert.equal(view().items[0].detailedStatus, 'RETURNED_TO_SELLER');
});

test('multiple packages stay distinct and another package cannot supply transition evidence', t => {
  const { order, view } = fixture(t);
  order(1, [pkg('IN_TRANSIT')]);
  order(3, [pkg('IN_TRANSIT'), pkg('RETURNED_TO_SELLER', { packageReferenceId: 'package-b', trackingNumber: 'TRACK-B' })]);
  const row = view().items[0];
  assert.equal(row.detectionKind, 'already-returned');
  assert.equal(row.returnedPackageCount, 1);
  assert.equal(row.packageCount, 2);
  assert.equal(row.partialReturn, true);
  assert.equal(row.trackingNumber, 'TRACK-B');
});

test('a tracking identity can gain its package reference without resetting the episode', t => {
  const { order, tracking, view } = fixture(t);
  order(1, [pkg('IN_TRANSIT', { packageReferenceId: null })]);
  tracking(3, [pkg('RETURNED_TO_SELLER', { packageReferenceId: null })]);
  const first = view().items[0];
  tracking(4, [pkg('RETURNED_TO_SELLER')]);
  const second = view().items[0];
  assert.equal(first.occurrenceId, second.occurrenceId);
  assert.equal(second.packageCount, 1);
  assert.equal(second.detectedAt, at(3));
  assert.equal(second.detectionKind, 'transition');
});

test('only DBA orders appear and identical IDs remain isolated between stores', t => {
  const { order, transaction, view } = fixture(t);
  order(3, [pkg('RETURNED_TO_SELLER')]);
  order(3, [pkg('RETURNED_TO_SELLER')], { storeId: 'store-b' });
  order(3, [pkg('RETURNED_TO_SELLER')], { orderId: 'fba-order', fulfillmentMode: 'FBA' });
  order(3, [pkg('RETURNED_TO_SELLER')], { orderId: 'unknown-order', fulfillmentMode: 'unknown' });
  transaction(originalRefund());
  assert.equal(view().total, 2);
  assert.equal(view({ filters: { storeId: 'store-a' } }).items[0].refund.status, 'recorded');
  assert.equal(view({ filters: { storeId: 'store-b' } }).items[0].refund.status, 'not-found');
  assert.equal(view({ filters: { storeId: 'store-b' } }).items[0].storeName, 'Loja B');
});

test('refund evidence accepts only associated Refund events and preserves exact signed cents', t => {
  const { order, transaction, view } = fixture(t);
  order(1, [pkg('IN_TRANSIT')]); order(3, [pkg('RETURNED_TO_SELLER')]);
  transaction(originalRefund('adjustment', 4, { type: 'Adjustment' }));
  transaction(originalRefund('other-order', 4, { orderIds: ['another-order'] }));
  assert.equal(view().items[0].refund.status, 'not-found');
  assert.equal(view().items[0].alert.state, 'pending-refund');
  transaction(originalRefund('exact', 4, { totalCents: '-900719925474099313' }));
  const row = view().items[0];
  assert.equal(row.refund.count, 1);
  assert.equal(row.refund.transactions[0].totalCents, '-900719925474099313');
  assert.equal(row.refund.latestPostedAt, at(4));
  assert.doesNotThrow(() => JSON.stringify(row));
});

test('explicitly linked refund release movements do not count again or reset the original date', t => {
  const { order, transaction, view } = fixture(t);
  order(1, [pkg('IN_TRANSIT')]); order(7, [pkg('RETURNED_TO_SELLER')]);
  transaction(originalRefund('original', 6, { status: 'DEFERRED_RELEASED', releaseTransactionIds: ['release'] }));
  transaction(originalRefund('release', 16, { status: 'RELEASED', deferredTransactionIds: ['original'] }));
  let row = view({ now: new Date(at(16)) }).items[0];
  assert.equal(row.refund.count, 1);
  assert.equal(row.refund.movementCount, 2);
  assert.equal(row.refund.latestPostedAt, at(6));
  assert.equal(row.refund.latestMovementPostedAt, at(16));
  assert.equal(row.refund.transactions.find(item => item.transactionId === 'release').isReleaseMovement, true);
  assert.equal(row.refund.transactions.find(item => item.transactionId === 'original').isReleaseMovement, false);
  assert.equal(row.alert.referenceAt, at(7));
  assert.equal(row.alert.dueAt, at(12));
  transaction(originalRefund('independent', 10));
  row = view({ now: new Date(at(16)) }).items[0];
  assert.equal(row.refund.count, 2);
  assert.equal(row.refund.latestPostedAt, at(10));
  assert.equal(row.alert.dueAt, at(15));
  assert.equal(row.alert.state, 'overdue');
});

test('a release whose original was not imported has an unknown original date and cannot start a timer', t => {
  const { order, transaction, view } = fixture(t);
  order(1, [pkg('IN_TRANSIT')]); order(3, [pkg('RETURNED_TO_SELLER')]);
  transaction(originalRefund('release-only', 16, { deferredTransactionIds: ['absent-original'] }));
  let row = view().items[0];
  assert.equal(row.refund.status, 'recorded');
  assert.equal(row.refund.latestPostedAt, null);
  assert.equal(row.refund.latestMovementPostedAt, at(16));
  assert.equal(row.refund.hasUnknownOriginalDate, true);
  assert.equal(row.alert.state, 'needs-confirmation');
  assert.equal(row.alert.referenceAt, null);
  transaction(originalRefund('independent', 4));
  row = view().items[0];
  assert.equal(row.refund.latestPostedAt, at(4));
  assert.equal(row.refund.count, 2);
  assert.equal(row.alert.state, 'needs-confirmation');
});

test('an anomalous release posting before its original is never relabeled as the original refund date', t => {
  const { order, transaction, view } = fixture(t);
  order(3, [pkg('RETURNED_TO_SELLER')]);
  transaction(originalRefund('original', 6, { releaseTransactionIds: ['release'] }));
  transaction(originalRefund('release', 5, { deferredTransactionIds: ['original'] }));
  assert.equal(view().items[0].refund.latestPostedAt, at(6));
});

test('two releases sharing the same absent original remain one refund of unknown date', t => {
  const { order, transaction, view } = fixture(t);
  order(1, [pkg('IN_TRANSIT')]); order(3, [pkg('RETURNED_TO_SELLER')]);
  transaction(originalRefund('release-a', 16, { deferredTransactionIds: ['absent-original'] }));
  transaction(originalRefund('release-b', 17, { deferredTransactionIds: ['absent-original'] }));
  const row = view().items[0];
  assert.equal(row.refund.count, 1);
  assert.equal(row.refund.movementCount, 2);
  assert.equal(row.refund.latestPostedAt, null);
  assert.equal(row.alert.state, 'needs-confirmation');
});

test('partial tracking snapshots preserve other packages and known fields without merging ambiguous identities', t => {
  const { db, tracking } = fixture(t);
  const first = pkg('RETURNED_TO_SELLER', { carrier: 'AMZBR', items: [{ orderItemId: 'item' }] });
  const second = pkg('PICKED_UP', { packageReferenceId: 'package-b', trackingNumber: 'TRACK-B' });
  tracking(3, [first, second]);
  tracking(4, [pkg(null, { trackingNumber: null, status: null })]);
  const latest = latestTracking(db, { storeId: 'store-a', orderId: 'order-a' });
  assert.equal(latest.packages.length, 2);
  assert.equal(latest.packages[0].detailedStatus, 'RETURNED_TO_SELLER');
  const merged = mergeTrackingPackages([first, second], latest.packages);
  assert.equal(merged[0].carrier, 'AMZBR');
  assert.equal(merged[0].items[0].orderItemId, 'item');
  const distinct = mergeTrackingPackages([first], [pkg('PICKED_UP', { packageReferenceId: 'other-reference' })]);
  assert.equal(distinct.length, 2);
  const ambiguous = mergeTrackingPackages(distinct, [pkg('DELIVERED', { packageReferenceId: null })]);
  assert.equal(ambiguous[0].detailedStatus, 'RETURNED_TO_SELLER');
  assert.equal(ambiguous[1].detailedStatus, 'PICKED_UP');
});

test('calendar reminders use the later internal observation/refund date and label the policy unofficial', t => {
  const { order, transaction, view } = fixture(t);
  order(1, [pkg('IN_TRANSIT')]); order(3, [pkg('RETURNED_TO_SELLER')]); transaction(originalRefund());
  assert.equal(view({ now: new Date(at(9)) }).items[0].alert.state, 'due-today');
  assert.equal(view({ now: new Date(at(10)) }).items[0].alert.daysRemaining, -1);
  assert.equal(view({ now: new Date(at(10)) }).items[0].alert.state, 'overdue');
  const policy = view().policy;
  assert.equal(policy.days, 5); assert.equal(policy.kind, 'calendar'); assert.equal(policy.isOfficial, false);
  assert.equal(policy.label, 'Alerta interno antecipado');
  assert.equal(view().items[0].alert.basis, 'internal-observation');
  assert.throws(() => view({ policy: { days: 5, kind: 'business' } }), /dias corridos/);
});

test('filters use detection date, refund evidence and text, with summary before pagination', t => {
  const { order, transaction, view } = fixture(t);
  order(3, [pkg('RETURNED_TO_SELLER')]);
  order(4, [pkg('RETURNED_TO_SELLER', { trackingNumber: 'TRACK-B' })], { orderId: 'order-b' });
  transaction(originalRefund());
  assert.equal(view({ filters: { from: '2026-09-03', to: '2026-09-03' } }).total, 1);
  assert.equal(view({ filters: { from: '2026-01-01', to: '2026-01-01' } }).total, 0);
  assert.equal(view({ filters: { status: 'refunded' } }).items[0].orderId, 'order-a');
  assert.equal(view({ filters: { status: 'without_refund' } }).items[0].orderId, 'order-b');
  assert.equal(view({ filters: { query: 'track-b' } }).total, 1);
  const paged = view({ filters: { limit: 1 } });
  assert.equal(paged.items.length, 1); assert.equal(paged.total, 2); assert.equal(paged.summary.total, 2);
  assert.equal(paged.summary.withRefund, 1); assert.equal(paged.summary.withoutRefundEvidence, 1); assert.equal(paged.hasMore, true);
});

test('tracking persistence is idempotent, allowlisted, and returns the latest nonempty observation', t => {
  const { db, order, tracking } = fixture(t);
  order(1, [pkg('IN_TRANSIT')]);
  assert.equal(tracking(3, [pkg('RETURNED_TO_SELLER', { secretDummy: 'DO-NOT-STORE' })]).recorded, true);
  assert.equal(tracking(3, [pkg('RETURNED_TO_SELLER')]).recorded, false);
  tracking(4, []);
  const latest = latestTracking(db, { storeId: 'store-a', orderId: 'order-a' });
  assert.equal(latest.observedAt, at(3));
  assert.equal(JSON.stringify(latest).includes('DO-NOT-STORE'), false);
  assert.equal(latestTracking(db, { storeId: 'store-b', orderId: 'order-a' }), null);
  assert.throws(() => tracking(3, [], { storeId: '../store' }), /Loja/);
  assert.throws(() => tracking(3, [], { observedAt: '2026-02-30T12:00:00Z' }), /Data/);
});
