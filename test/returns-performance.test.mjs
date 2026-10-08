import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureReturnSchema, recordTrackingObservation, returnsView } from '../src/domain/returns.mjs';
import { ensureReturnedManagementSchema, saveReturnedManagement } from '../src/domain/returned-management.mjs';

const at = day => `2026-09-${String(day).padStart(2, '0')}T12:00:00.000Z`;
const pkg = detailedStatus => ({ packageReferenceId: 'parcel', trackingNumber: 'TRACK', status: 'DELIVERED', detailedStatus });

function fixture(t, { file = false, onPrepare = () => {} } = {}) {
  const directory = file ? mkdtempSync(path.join(os.tmpdir(), 'returns-performance-')) : null;
  const filename = directory ? path.join(directory, 'test.sqlite') : ':memory:';
  const raw = new DatabaseSync(filename);
  const connections = [raw], queries = [];
  const db = new Proxy(raw, { get(target, key) {
    if (key === 'prepare') return sql => { queries.push(sql); onPrepare(sql); return target.prepare(sql); };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE stores (store_id TEXT PRIMARY KEY,name TEXT);
    CREATE TABLE entities (store_id TEXT,source TEXT,source_id TEXT,observed_at TEXT,payload_json TEXT,PRIMARY KEY(store_id,source,source_id));
    CREATE TABLE observations (store_id TEXT,source TEXT,source_id TEXT,observed_at TEXT,run_id TEXT,version_hash TEXT,payload_json TEXT);
    CREATE INDEX order_history ON observations(store_id,source,source_id,observed_at);`);
  for (const store of ['a', 'b', 'c']) db.prepare('INSERT INTO stores VALUES(?,?)').run(`store-${store}`, `Loja ${store}`);
  ensureReturnSchema(db);
  ensureReturnedManagementSchema(db);
  t.after(() => { for (const connection of connections.reverse()) connection.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });
  const secondConnection = () => { const connection = new DatabaseSync(filename); connections.push(connection); return connection; };
  let version = 0;
  function order(orderId, day, packages, { storeId = 'store-a', connection = db, ...extra } = {}) {
    const payload = JSON.stringify({ orderId, storeId, status: 'SHIPPED', fulfillmentMode: 'DBA', createdAt: at(1), packages, ...extra });
    connection.prepare('INSERT INTO observations VALUES(?,?,?,?,?,?,?)').run(storeId, 'orders', orderId, at(day), `run-${++version}`, `version-${version}`, payload);
    connection.prepare('INSERT OR REPLACE INTO entities VALUES(?,?,?,?,?)').run(storeId, 'orders', orderId, at(day), payload);
  }
  function transaction(transactionId, orderId, { storeId = 'store-a', connection = db, ...extra } = {}) {
    const item = { transactionId, storeId, type: 'Refund', status: 'RELEASED', postedAt: at(4),
      orderIds: [orderId], totalCents: '-10000', currency: 'BRL', ...extra };
    connection.prepare('INSERT OR REPLACE INTO entities VALUES(?,?,?,?,?)').run(storeId, 'transactions', transactionId, at(4), JSON.stringify(item));
  }
  const view = (filters = {}, options = {}) => returnsView({ db, now: new Date(at(8)), filters, ...options });
  const reads = () => ({
    histories: queries.filter(sql => /FROM observations\s+WHERE store_id=\? AND source='orders' AND source_id=\?/.test(sql)).length,
    transactions: queries.filter(sql => /FROM entities WHERE source='transactions'/.test(sql)).length,
    individualManagement: queries.filter(sql => /FROM returned_management WHERE store_id=\? AND order_id=\?/.test(sql)).length,
    batchManagement: queries.filter(sql => /FROM returned_management\s+WHERE \(\? IS NULL/.test(sql)).length,
  });
  const reset = () => { queries.length = 0; };
  return { db, order, transaction, view, reads, reset, secondConnection };
}

test('pagination and filters reuse imported evidence while history reads scale with returned candidates', t => {
  const { db, order, transaction, view, reads, reset } = fixture(t);
  db.exec('BEGIN');
  for (let index = 0; index < 1000; index++) {
    order(`order-${index}`, 1, [pkg('IN_TRANSIT')]);
    transaction(`refund-${index}`, `order-${index}`);
  }
  for (let index = 0; index < 12; index++) order(`order-${index}`, 3, [pkg('RETURNED_TO_SELLER')]);
  db.exec('COMMIT');
  reset();
  const first = view({ limit: 5 });
  assert.equal(first.total, 12); assert.equal(first.items.length, 5); assert.equal(first.hasMore, true);
  assert.equal(reads().histories, 12, 'unrelated orders must not each load their tracking history');
  assert.equal(reads().transactions, 1);
  assert.equal(reads().individualManagement, 0, 'workflow is read as a batch rather than once per order');
  reset();
  const second = view({ offset: 5, limit: 5 });
  const filtered = view({ query: 'order-11', status: 'refunded', from: '2026-09-03', to: '2026-09-03' });
  assert.equal(second.total, 12); assert.equal(second.items.length, 5);
  assert.deepEqual(filtered.items.map(row => row.orderId), ['order-11']);
  assert.equal(reads().histories, 0, 'changing a page or filter must not reconstruct historical evidence');
  assert.equal(reads().transactions, 0, 'changing a page or filter must not reread every financial transaction');
  assert.equal(reads().individualManagement, 0);
  assert.equal(reads().batchManagement, 2);
});

test('a slow initial snapshot retains a full cache lifetime after construction', t => {
  let clock = 0, advanceDuringBuild = false;
  const { order, view, reads, reset } = fixture(t, { onPrepare(sql) {
    if (advanceDuringBuild && /FROM observations WHERE source='orders'/.test(sql)) {
      clock += 90_000;
      advanceDuringBuild = false;
    }
  } });
  order('order-a', 3, [pkg('RETURNED_TO_SELLER')]);
  order('order-b', 3, [pkg('RETURNED_TO_SELLER')]);
  t.mock.method(Date, 'now', () => clock);
  advanceDuringBuild = true;
  assert.equal(view({ limit: 1 }).items[0].orderId, 'order-a');
  assert.equal(clock, 90_000, 'the initial build took longer than the cache lifetime');
  reset();
  clock += 59_999;
  assert.equal(view({ limit: 1, offset: 1 }).items[0].orderId, 'order-b');
  assert.equal(reads().histories, 0, 'the second page must reuse the completed slow snapshot');
  assert.equal(reads().transactions, 0);
  clock += 2;
  assert.equal(view().total, 2);
  assert.equal(reads().histories, 2, 'normal expiry still applies sixty seconds after completion');
  assert.equal(reads().transactions, 1);
});

test('same-connection tracking, refunds, eligibility and workflow writes are visible immediately', t => {
  const { db, order, transaction, view } = fixture(t);
  order('order-a', 1, [pkg('IN_TRANSIT')]);
  assert.equal(view().total, 0);
  recordTrackingObservation(db, { storeId: 'store-a', orderId: 'order-a', observedAt: at(3), packages: [pkg('RETURNED_TO_SELLER')] });
  assert.equal(view().items[0].alert.state, 'pending-refund');
  transaction('refund', 'order-a');
  assert.equal(view().items[0].refund.status, 'recorded');
  assert.equal(view().items[0].alert.dueAt, at(9));
  order('order-a', 5, [], { status: 'PENDING' });
  assert.equal(view().items[0].financialEligibility.included, false);
  assert.equal(view().summary.withRefund, 0);
  order('order-a', 6, [], { status: 'SHIPPED' });
  assert.equal(view().items[0].financialEligibility.included, true);
  saveReturnedManagement(db, { action: 'finalize', items: [{ storeId: 'store-a', orderId: 'order-a', expectedVersion: 0 }],
    status: 'resolved', note: 'Conferido', caseId: '123456' }, new Date(at(8)));
  assert.equal(view({ workflow: 'active' }).total, 0);
  const done = view({ workflow: 'finalized', reviewStatus: 'resolved' });
  assert.equal(done.total, 1); assert.equal(done.items[0].review.notes, 'Conferido');
  assert.equal(done.items[0].review.caseId, '123456');
  assert.deepEqual(done.summary.workflowCounts, { all: 1, active: 0, finalized: 1 });
});

test('a collector on another connection invalidates evidence and workflow caches after commit', t => {
  const { order, transaction, view, secondConnection } = fixture(t, { file: true });
  order('order-a', 1, [pkg('IN_TRANSIT')]);
  assert.equal(view().total, 0);
  const writer = secondConnection();
  writer.exec('BEGIN');
  order('order-a', 3, [pkg('RETURNED_TO_SELLER')], { connection: writer });
  transaction('refund', 'order-a', { connection: writer });
  assert.equal(view().total, 0, 'another connection must not expose uncommitted imports');
  writer.exec('COMMIT');
  assert.equal(view().total, 1); assert.equal(view().items[0].refund.status, 'recorded');
  transaction('safe-t', 'order-a', { connection: writer, type: 'Adjustment', totalCents: '8000',
    breakdowns: [{ kind: 'SAFETReimbursement', amountCents: '8000', currency: 'BRL' }] });
  assert.equal(view().items[0].reimbursement.identified, true);
  assert.equal(view().items[0].reimbursement.byCurrency[0].totalCents, '8000');
  saveReturnedManagement(writer, { action: 'finalize', items: [{ storeId: 'store-a', orderId: 'order-a', expectedVersion: 0 }],
    status: 'resolved', note: 'Conferido em outra sessão' }, new Date(at(8)));
  assert.equal(view({ workflow: 'active' }).total, 0);
  assert.equal(view({ workflow: 'finalized' }).items[0].review.notes, 'Conferido em outra sessão');
});

test('transaction snapshots cannot survive rollback, including temporary imports and deletions', t => {
  const { db, order, view } = fixture(t);
  order('order-a', 1, [pkg('IN_TRANSIT')]);
  assert.equal(view().total, 0);
  db.exec('BEGIN');
  order('order-a', 3, [pkg('RETURNED_TO_SELLER')]);
  assert.equal(view().total, 1);
  db.exec('ROLLBACK');
  assert.equal(view().total, 0, 'a temporary returned episode must not leak after rollback');
  order('order-a', 3, [pkg('RETURNED_TO_SELLER')]);
  assert.equal(view().total, 1);
  db.exec('BEGIN');
  db.exec("DELETE FROM entities WHERE source='orders'");
  assert.equal(view().total, 0);
  db.exec('ROLLBACK');
  assert.equal(view().total, 1, 'a temporary empty result must not replace committed evidence');
});

test('cached evidence keeps identical order IDs isolated in single, combined and all-store scopes', t => {
  const { order, transaction, view, reset, reads } = fixture(t);
  for (const storeId of ['store-a', 'store-b', 'store-c']) order('same-id', 3, [pkg('RETURNED_TO_SELLER')], { storeId });
  transaction('refund', 'same-id', { storeId: 'store-b' });
  assert.equal(view({ storeId: 'store-a' }).items[0].refund.status, 'not-found');
  assert.equal(view({ storeId: 'store-b' }).items[0].refund.status, 'recorded');
  const combined = view({ storeId: 'store-a,store-b' });
  assert.deepEqual(combined.items.map(row => row.storeId), ['store-a', 'store-b']);
  assert.equal(combined.summary.withRefund, 1);
  reset();
  assert.deepEqual(view({ storeId: 'store-b,store-a' }), combined);
  assert.equal(reads().transactions, 0, 'the same selection in another order should reuse its canonical scope');
  assert.equal(view().total, 3);
  assert.equal(view({ storeId: 'store-a' }).total, 1);
  assert.equal(view({ storeId: 'store-b' }).items[0].storeName, 'Loja b');
});

test('warm-cache alerts use the requested current date and policy, including the Brasília midnight boundary', t => {
  const { order, transaction, view, reset, reads } = fixture(t);
  order('order-a', 1, [pkg('IN_TRANSIT')]); order('order-a', 3, [pkg('RETURNED_TO_SELLER')]);
  transaction('refund', 'order-a');
  assert.equal(view().items[0].alert.daysRemaining, 1);
  reset();
  const beforeMidnight = view({}, { now: new Date('2026-09-09T02:59:59Z') });
  const midnight = view({}, { now: new Date('2026-09-09T03:00:00Z') });
  const nextDay = view({}, { now: new Date('2026-09-10T03:00:00Z') });
  assert.equal(beforeMidnight.items[0].alert.state, 'open');
  assert.equal(midnight.items[0].alert.state, 'due-today');
  assert.equal(nextDay.items[0].alert.state, 'overdue');
  assert.equal(nextDay.items[0].alert.daysRemaining, -1);
  assert.equal(view({}, { policy: { days: 10, kind: 'calendar' } }).items[0].alert.dueAt, at(14));
  assert.equal(reads().histories, 0); assert.equal(reads().transactions, 0);
});

test('candidate pruning preserves historical returns but rejects unrelated text containing a return marker', t => {
  const { db, order, view } = fixture(t);
  order('historical', 1, [pkg('IN_TRANSIT')]);
  order('historical', 3, [pkg('RETURNED_TO_SELLER')]);
  order('historical', 5, [pkg('DELIVERED')]);
  order('tracking-only', 1, [pkg('IN_TRANSIT')]);
  recordTrackingObservation(db, { storeId: 'store-a', orderId: 'tracking-only', observedAt: at(3), packages: [pkg('RETURNED_TO_SELLER')] });
  recordTrackingObservation(db, { storeId: 'store-a', orderId: 'tracking-only', observedAt: at(5), packages: [pkg('DELIVERED')] });
  order('text-marker', 1, [pkg('IN_TRANSIT')], { items: [{ title: 'Texto RETURNED_TO_SELLER sem devolução' }] });
  const result = view();
  assert.deepEqual(result.items.map(row => row.orderId), ['historical', 'tracking-only']);
  for (const row of result.items) {
    assert.equal(row.detectedAt, at(3)); assert.equal(row.detectionKind, 'transition');
    assert.equal(row.detailedStatus, 'DELIVERED'); assert.equal(row.returnStatusChanged, true);
  }
});
