import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ensureFinancialCaseSchema } from '../src/domain/financial-cases.mjs';
import { ensureRefundManagementSchema, syncRefundManagement, refundManagementView } from '../src/domain/refund-management.mjs';
import { collectSafeTClaimIds, importSellerSafeTClaims } from '../src/domain/safe-t-claims.mjs';
import { mutateRefundManagement } from '../src/domain/refund-management-actions.mjs';
import { ensureCustomerReturnSchema, importCustomerReturnReport, saveCustomerReturnJob } from '../src/domain/customer-returns.mjs';
import { parseReturnReport } from '../src/amazon/return-reports.mjs';

const orderId = '701-1111111-2222222';
const now = () => new Date('2026-09-27T12:00:00Z');
function fixture(t, { withCredit = true } = {}) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  ensureFinancialCaseSchema(db); ensureRefundManagementSchema(db);
  const source = storeId => ({ storeId, orderId, order: { orderId }, products: [], fulfillmentMode: 'DBA',
    refund: { source: 'financial-transactions', byCurrency: [{ currency: 'BRL', totalCents: '-10000' }],
      latestPostedAt: '2026-09-01T12:00:00Z', count: 1, dateKnown: true, allocation: 'order' },
    refundCaseIds: [], customerReturns: [], returnedToSeller: null });
  const credit = { eventId: 'credit1', type: 'safe_t', label: 'SAFE-T', totalCents: '10000', currency: 'BRL', postedAt: '2026-09-05T12:00:00Z' };
  syncRefundManagement({ db, rows: ['store-a','store-b'].map(source), storeIds: ['store-a','store-b'], now: now(),
    creditIndex: new Map(withCredit ? ['store-a','store-b'].map(id => [JSON.stringify([id, orderId]), [credit]]) : []) });
  const view = (storeId = 'store-a', query) => refundManagementView(db, { storeId, workflow: 'all', ...(query ? { query } : {}) }, now());
  const snapshot = () => JSON.stringify(['refund_management','refund_management_history','refund_management_notes'].map(name => db.prepare(`SELECT * FROM ${name}`).all()));
  const options = { db, config: { storeId: 'store-a' }, now, sleep: async () => {} };
  return { db, view, snapshot, options };
}
const event = id => ({ SAFETClaimId: id, PostedDate: '2026-09-05T12:00:00Z' });
const client = events => ({ async *listFinancialEventsByOrderId(id) { yield { orderId: id, safeTEvents: events }; } });

const reportType = 'GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE';
function importRequests(f, { reportId = 'report-new', storeId = 'store-a', createdAt = now().toISOString(), observedAt = createdAt,
  records = [{ orderId, safeTClaimId: 'pending-claim', safeTClaimState: 'Pending', safeTClaimCreatedAt: '2026-09-24' }] } = {}) {
  ensureCustomerReturnSchema(f.db);
  saveCustomerReturnJob(f.db, { storeId, reportId, reportType, status: 'DONE', createdAt, checkedAt: observedAt });
  return importCustomerReturnReport(f.db, { storeId, reportId, reportType, observedAt, records });
}

test('Seller Central report supplements requests missing from returns and finances without changing workflow or money', t => {
  const f = fixture(t, { withCredit: false }), before = f.snapshot();
  const input = { storeId: 'store-a', reportHash: 'a'.repeat(64), reportCreatedAt: now().toISOString(), observedAt: now().toISOString(),
    records: [{ orderId, claimId: 'seller-claim', claimState: 'Pending', amount: 'ignored' }] };
  assert.deepEqual(importSellerSafeTClaims(f.db, input), { claims: 1, orders: 1 });
  assert.equal(f.view().items[0].management.safeTId, 'seller-claim');
  assert.equal(f.view().items[0].management.safeTIdSource, 'seller-central-report');
  assert.equal(f.view('store-b').items[0].management.safeTId, '');
  assert.equal(f.view('store-a', 'seller-claim').total, 1);
  assert.equal(f.snapshot(), before);
  importSellerSafeTClaims(f.db, input);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM safe_t_seller_claims').get().n, 1);
  assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM safe_t_seller_claims').all()).includes('ignored'), false);
  importRequests(f, { records: [{ orderId, safeTClaimId: 'seller-claim', safeTClaimState: 'Pending' }] });
  assert.equal(f.view().items[0].management.safeTId, 'seller-claim');
  assert.equal(f.view().items[0].management.safeTIdSource, 'amazon-multiple-sources');
  assert.equal(f.view().items[0].management.automaticSafeTClaims.length, 1);
  const current = f.view().items[0];
  mutateRefundManagement({ db: f.db, now: now(), input: { action: 'edit', items: [{ storeId: 'store-a', managementId: current.managementId, expectedVersion: current.management.version }], safeTId: 'manual-claim' } });
  importSellerSafeTClaims(f.db, input);
  assert.equal(f.view().items[0].management.safeTId, 'manual-claim');
});

test('Seller report imports validate all associations, reject stale metadata and retain IDs on omission', t => {
  const f = fixture(t, { withCredit: false });
  const input = { storeId: 'store-a', reportHash: 'a'.repeat(64), reportCreatedAt: now().toISOString(), observedAt: now().toISOString(), records: [{ orderId, claimId: 'claim', claimState: 'Under investigation' }] };
  importSellerSafeTClaims(f.db, input);
  importSellerSafeTClaims(f.db, { ...input, reportCreatedAt: '2026-09-01T12:00:00Z', records: [{ orderId, claimId: 'claim', claimState: 'Pending' }] });
  assert.equal(f.view().items[0].management.automaticSafeTClaims[0].claimState, 'Under investigation');
  importSellerSafeTClaims(f.db, { ...input, records: [] });
  assert.equal(f.view().items[0].management.safeTId, 'claim');
  for (const invalid of [{ storeId: 'all' }, { reportHash: 'bad' }, { reportCreatedAt: 'invalid' }, { records: [{ orderId, claimId: 'new-claim' }, { orderId: 'invalid', claimId: 'other' }] }]) {
    assert.throws(() => importSellerSafeTClaims(f.db, { ...input, ...invalid }), { code: 'INVALID_PARAMETERS' });
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM safe_t_seller_claims').get().n, 1);
  }
});

test('return reports identify pending and denied SAFE-T requests without payment, with exact store/order isolation', t => {
  const f = fixture(t, { withCredit: false }), before = f.snapshot();
  const parsed = parseReturnReport({ reportType, text: 'Order ID\tSafeT claim id\tSafeT claim state\tSafeT claim creation time\tSafeT claim reimbursement amount\n'
    + `${orderId}\tpending-claim\tPending\t2026-09-24\t\n${orderId}\tdenied-claim\tDenied\t2026-09-25\t0\n${orderId}\tpending-claim\tPending\t2026-09-24\t` });
  importRequests(f, { records: parsed.records });
  const a = f.view().items[0];
  assert.equal(a.management.safeTId, 'denied-claim, pending-claim');
  assert.equal(a.management.safeTIdSource, 'amazon-return-report');
  assert.equal(a.management.automaticSafeTClaims[1].claimState, 'Pending');
  assert.equal(a.management.automaticSafeTClaims[1].claimCreatedAt, '2026-09-24');
  assert.equal(f.view('store-a', 'pending-claim').total, 1);
  assert.equal(f.view('store-b').items[0].management.safeTId, '');
  assert.equal(f.snapshot(), before, 'No changes to money, status, workflow, notes or optimistic versions');
  importRequests(f, { reportId: 'invalid-orders', records: [{ orderId: '', safeTClaimId: 'unlinked', rmaId: 'RMA' },
    { orderId: 'not-an-amazon-order', safeTClaimId: 'invalid-order' }, { orderId, safeTClaimId: 'https://invalid.test' }] });
  assert.equal(f.view().items[0].management.safeTId, 'denied-claim, pending-claim');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM safe_t_report_claims').get().n, 2);
});

test('report claims retain proven IDs on omissions, reject stale state and merge financial evidence without duplicates', async t => {
  const f = fixture(t);
  importRequests(f, { records: [{ orderId, safeTClaimId: 'shared', safeTClaimState: 'Under investigation' }] });
  importRequests(f, { reportId: 'empty-new', createdAt: '2026-09-28T12:00:00Z', records: [{ orderId }] });
  assert.equal(f.view().items[0].management.safeTId, 'shared');
  importRequests(f, { reportId: 'older-arrived-late', createdAt: '2026-09-26T12:00:00Z', observedAt: '2026-09-29T12:00:00Z',
    records: [{ orderId, safeTClaimId: 'shared', safeTClaimState: 'Pending' }] });
  assert.equal(f.view().items[0].management.automaticSafeTClaims[0].claimState, 'Under investigation');
  await collectSafeTClaimIds({ ...f.options, client: client([event('shared'), event('financial-only')]) });
  const management = f.view().items[0].management;
  assert.equal(management.safeTId, 'financial-only, shared');
  assert.equal(management.safeTIdSource, 'amazon-reports-and-finances');
  assert.deepEqual(management.automaticSafeTClaims[1].sources, ['amazon-finances', 'amazon-return-report']);
  assert.equal(management.automaticSafeTClaims[1].claimState, 'Under investigation');
  importRequests(f, { reportId: 'newer-approved', createdAt: '2026-09-29T13:00:00Z', records: [{ orderId, safeTClaimId: 'shared', safeTClaimState: 'Approved' }] });
  assert.equal(f.view().items[0].management.automaticSafeTClaims[1].claimState, 'Approved');
});

test('manual overrides survive request imports and a failed import rolls back claim associations', t => {
  const f = fixture(t, { withCredit: false });
  const edit = safeTId => { const row = f.view().items[0]; mutateRefundManagement({ db: f.db, now: now(), input: { action: 'edit',
    items: [{ storeId: row.storeId, managementId: row.managementId, expectedVersion: row.management.version }], safeTId } }); };
  edit('manual-id'); importRequests(f);
  assert.equal(f.view().items[0].management.safeTId, 'manual-id');
  assert.equal(f.view().items[0].management.safeTIdSource, 'manual');
  edit('');
  assert.equal(f.view().items[0].management.safeTId, 'pending-claim');
  const before = f.snapshot();
  f.db.exec("CREATE TRIGGER fail_report BEFORE INSERT ON customer_return_records BEGIN SELECT RAISE(ABORT,'fixture'); END");
  assert.throws(() => importRequests(f, { reportId: 'failed', records: [{ orderId, safeTClaimId: 'partial-claim' }] }), /fixture/);
  assert.equal(f.view().items[0].management.safeTId, 'pending-claim');
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM customer_return_report_import_versions WHERE report_id='failed'").get().n, 0);
  assert.equal(f.snapshot(), before);
});

test('exact-order pagination stores all IDs, deduplicates, isolates stores and changes no money/workflow/manual data', async t => {
  const f = fixture(t), before = f.snapshot();
  const result = await collectSafeTClaimIds({ ...f.options, client: { async *listFinancialEventsByOrderId(id) {
    assert.equal(id, orderId);
    yield { orderId: id, safeTEvents: [], nextToken: 'next' };
    yield { orderId: id, safeTEvents: [event('claim-1'), event('claim-1'), event('claim-2')], requestId: 'request' };
  } } });
  assert.equal(result.withIds, 1);
  assert.equal(f.view().items[0].management.safeTId, 'claim-1, claim-2');
  assert.equal(f.view().items[0].management.safeTIdSource, 'amazon-finances');
  assert.equal(f.view('store-a','claim-2').total, 1);
  assert.equal(f.view('store-b').items[0].management.safeTId, '');
  assert.equal(f.snapshot(), before);
  const cached = await collectSafeTClaimIds({ ...f.options, client: { listFinancialEventsByOrderId() { throw new Error('must not request'); } } });
  assert.equal(cached.selected, 0);
});

test('manual IDs win; removing the override restores automatic IDs, without fabricating support case IDs', async t => {
  const f = fixture(t);
  const edit = safeTId => { const row = f.view().items[0]; mutateRefundManagement({ db: f.db, now: now(), input: { action: 'edit',
    items: [{ storeId: row.storeId, managementId: row.managementId, expectedVersion: row.management.version }], safeTId } }); };
  edit('manual-claim');
  await collectSafeTClaimIds({ ...f.options, client: client([event('automatic-claim')]) });
  assert.equal(f.view().items[0].management.safeTId, 'manual-claim');
  assert.equal(f.view().items[0].management.automaticSafeTClaims[0].claimId, 'automatic-claim');
  assert.equal(f.view().items[0].management.caseId, '');
  edit('');
  assert.equal(f.view().items[0].management.safeTId, 'automatic-claim');
});

test('failed later pages, cross-order responses and aborted runs do not publish partial associations', async t => {
  const f = fixture(t);
  for (const mock of [
    { async *listFinancialEventsByOrderId(id) { yield { orderId: id, safeTEvents: [event('partial')] }; throw Object.assign(new Error(), { code: 'TIMEOUT' }); } },
    client([{ ...event('wrong'), AmazonOrderId: '701-9999999-9999999' }]),
    { async *listFinancialEventsByOrderId() { yield { orderId: '701-9999999-9999999', safeTEvents: [event('wrong')] }; } },
  ]) {
    assert.equal((await collectSafeTClaimIds({ ...f.options, client: mock })).failed, 1);
    assert.equal(f.view().items[0].management.safeTId, '');
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM safe_t_claim_queries').get().n, 0);
  }
  const controller = new AbortController();
  const aborted = await collectSafeTClaimIds({ ...f.options, signal: controller.signal, client: {
    async *listFinancialEventsByOrderId(id) { yield { orderId: id, safeTEvents: [event('partial')] }; controller.abort(); }
  } });
  assert.equal(aborted.interrupted, true);
  assert.equal(f.view().items[0].management.safeTId, '');
});

test('new financial credit invalidates cache; empty later responses retain proven IDs', async t => {
  const f = fixture(t);
  await collectSafeTClaimIds({ ...f.options, client: client([event('first')]) });
  f.db.prepare(`UPDATE refund_management SET source_json=json_set(source_json,'$.payment.credits[0].eventId','new-credit') WHERE store_id='store-a'`).run();
  const updated = await collectSafeTClaimIds({ ...f.options, client: client([event('second')]) });
  assert.equal(updated.checked, 1);
  assert.equal(f.view().items[0].management.safeTId, 'first, second');
  await collectSafeTClaimIds({ ...f.options, now: () => new Date('2026-09-29T12:00:00Z'), client: client([]) });
  assert.equal(f.view().items[0].management.safeTId, 'first, second');
});

test('orders without SAFE-T credits and payment-pending orders are not queried', async t => {
  const f = fixture(t);
  f.db.prepare(`UPDATE refund_management SET source_json=json_set(source_json,'$.payment.credits[0].type','easy_ship')`).run();
  assert.equal((await collectSafeTClaimIds({ ...f.options, client: client([]) })).selected, 0);
  f.db.prepare(`UPDATE refund_management SET source_json=json_set(source_json,'$.payment.credits[0].type','safe_t','$.financialEligibility.included',json('false'))`).run();
  assert.equal((await collectSafeTClaimIds({ ...f.options, client: client([]) })).selected, 0);
});
