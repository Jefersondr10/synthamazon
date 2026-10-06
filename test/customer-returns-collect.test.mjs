import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { returnReportWindows, syncCustomerReturnReports } from '../src/customer-returns-collect.mjs';
import { RETURN_REPORT_TYPES } from '../src/amazon/return-reports.mjs';
import { ensureCustomerReturnSchema, customerReturnJobs, saveCustomerReturnJob, customerReturnsView } from '../src/domain/customer-returns.mjs';

const [MFN, FBA] = RETURN_REPORT_TYPES;
const DAY = 86_400_000;
const START = '2026-01-01T00:00:00.000Z';
const NOW = '2026-09-25T12:00:00.000Z';
const config = { storeId: 'store-a', marketplaceId: 'marketplace-test', historyStart: START };
const headers = ['Order ID', 'Merchant SKU', 'ASIN', 'Item Name', 'Return quantity', 'Return request date', 'Return request status', 'Return delivery date', 'Return Reason', 'Return type', 'Amazon RMA ID', 'Tracking ID', 'Return carrier', 'Refunded Amount', 'Currency code', 'buyer-name', 'buyer-email', 'address', 'customer-comments'];
const values = ['701-1111111-2222222', 'SKU A', 'ASIN-A', 'Produto de teste', '2', '2026-09-02T10:30:00-03:00', 'Approved', '2026-09-04', 'UNWANTED_ITEM', 'CustomerReturn', 'RMA-A', 'TRACK-A', 'Carrier', '123.45', 'BRL', 'PRIVATE-NAME', 'PRIVATE-EMAIL@example.test', 'PRIVATE-ADDRESS', 'PRIVATE-COMMENT'];
const mfnBody = `${headers.join('\t')}\n${values.join('\t')}`;
const fbaBody = 'return-date\torder-id\tsku\tasin\tproduct-name\tquantity\treason\tstatus\tcustomer-comments\n2026-09-02T12:00:00Z\t701-3333333-4444444\tSKU-FBA\tASIN-FBA\tProduto FBA\t1\tDEFECTIVE\tUnit returned to inventory\tPRIVATE-FBA-COMMENT';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  ensureCustomerReturnSchema(db);
  return db;
}

function queued(db, extra = {}) {
  const job = { storeId: config.storeId, reportId: 'report-seeded', reportType: MFN,
    from: '2026-09-01T00:00:00.000Z', to: '2026-09-25T00:00:00.000Z', status: 'IN_QUEUE',
    createdAt: NOW, checkedAt: NOW, ...extra };
  saveCustomerReturnJob(db, job);
  if (job.status === 'IMPORTED' && extra.importVersion !== 0) db.prepare('INSERT OR REPLACE INTO customer_return_report_import_versions VALUES(?,?,1)').run(job.storeId, job.reportId);
  return job;
}

function mockClient() {
  const reports = new Map(), calls = { create: [], get: [], document: [], download: [] };
  const documents = new Map();
  let sequence = 0;
  const client = {
    async createReturnReport(input) {
      calls.create.push(input);
      const reportId = `report-${++sequence}`;
      reports.set(reportId, { reportId, reportType: input.reportType, processingStatus: 'IN_QUEUE' });
      return { reportId };
    },
    async getReport(id) {
      calls.get.push(id);
      assert.ok(reports.has(id), 'the collector must poll an existing mocked report');
      return reports.get(id);
    },
    async getReportDocument(id) {
      calls.document.push(id);
      const document = { reportDocumentId: id, url: `https://reports-bucket.s3.us-east-1.amazonaws.com/object?signature=PRIVATE-SIGNATURE-${id}` };
      documents.set(id, document);
      return document;
    },
    async downloadReturnReportDocument(document) {
      calls.download.push(document.reportDocumentId);
      assert.equal(document, documents.get(document.reportDocumentId));
      const report = [...reports.values()].find(item => item.reportDocumentId === document.reportDocumentId);
      assert.ok(report);
      return report.body ?? (report.reportType === MFN ? mfnBody : fbaBody);
    },
  };
  function set(job, status, extra = {}) {
    reports.set(job.reportId, { reportId: job.reportId, reportType: job.reportType, processingStatus: status,
      ...(status === 'DONE' ? { reportDocumentId: `PRIVATE-DOCUMENT-${job.reportId}` } : {}), ...extra });
  }
  return { client, reports, calls, set };
}

function pass(db, client, options = {}) {
  return syncCustomerReturnReports({ db, client, config, now: () => new Date(NOW), ...options });
}

function persisted(db) {
  return JSON.stringify({ jobs: db.prepare('SELECT * FROM customer_return_report_jobs').all(),
    records: db.prepare('SELECT * FROM customer_return_records').all(),
    observations: db.prepare('SELECT * FROM customer_return_observations').all() });
}

function importedOtherWindows(db, target) {
  for (const [index, window] of returnReportWindows(START, new Date(NOW)).entries()) {
    for (const reportType of RETURN_REPORT_TYPES) {
      if (reportType === MFN && window.from === target.from && window.to === target.to) continue;
      queued(db, { reportId: `imported-${index}-${reportType}`, reportType, ...window,
        status: 'IMPORTED', recordCount: 0 });
    }
  }
}

test('historical report windows cover the year continuously in at most 60 days with a stable daily cutoff', () => {
  const newestFirst = returnReportWindows(START, new Date(NOW));
  assert.ok(newestFirst.length > 1);
  const ascending = [...newestFirst].reverse();
  assert.equal(ascending[0].from, START);
  assert.equal(newestFirst[0].to, '2026-09-25T00:00:00.000Z');
  for (let i = 0; i < ascending.length; i++) {
    const length = Date.parse(ascending[i].to) - Date.parse(ascending[i].from);
    assert.ok(length > 0 && length <= 60 * DAY);
    if (i) assert.equal(ascending[i].from, ascending[i - 1].to);
  }
  assert.deepEqual(returnReportWindows(START, new Date('2026-09-25T23:59:59Z')), newestFirst);
  assert.deepEqual(returnReportWindows(START, new Date('2026-09-26T00:03:00Z')), newestFirst);
  assert.equal(returnReportWindows(START, new Date('2026-09-26T00:06:00Z'))[0].to, '2026-09-26T00:00:00.000Z');
  assert.deepEqual(returnReportWindows('2026-09-25T01:00:00Z', new Date(NOW)), []);
  assert.throws(() => returnReportWindows('invalid', new Date(NOW)), TypeError);
  assert.throws(() => returnReportWindows('2026-09-26T00:00:00Z', new Date(NOW)), TypeError);
});

test('legacy MFN imports refresh once for SAFE-T fields, respect pending jobs and retain creation limits', async t => {
  const db = fixture(t), mock = mockClient();
  const windows = returnReportWindows(START, new Date(NOW));
  for (const [index, window] of windows.entries()) for (const reportType of RETURN_REPORT_TYPES) {
    queued(db, { reportId: `legacy-${index}-${reportType}`, ...window, reportType, status: 'IMPORTED', recordCount: 0, importVersion: 0 });
  }
  const first = await pass(db, mock.client, { maxCreate: 1 });
  assert.equal(first.created, 1);
  assert.equal(mock.calls.create[0].reportType, MFN);
  const newJob = customerReturnJobs(db, config.storeId).find(job => job.status === 'IN_QUEUE');
  mock.set(newJob, 'IN_PROGRESS');
  assert.equal((await pass(db, mock.client, { maxCreate: 1 })).created, 1, 'Next historical MFN window is upgraded within the limit');
  assert.equal(new Set(mock.calls.create.map(call => call.dataStartTime)).size, 2, 'No second request for the pending window');
  mock.set(newJob, 'DONE', { body: mfnBody + '' });
  const imported = await pass(db, mock.client, { create: false });
  assert.equal(imported.imported, 1);
  assert.equal(customerReturnJobs(db, config.storeId).find(job => job.reportId === newJob.reportId).importVersion, 1);
  const before = mock.calls.create.length;
  await pass(db, mock.client, { maxCreate: 100 });
  assert.ok(mock.calls.create.slice(before).every(call => call.dataStartTime !== newJob.from));
  assert.ok(mock.calls.create.every(call => call.reportType === MFN), 'FBA is not requeued solely for SAFE-T fields');
});

test('queued reports progress asynchronously and import only sanitized records, once per report', async t => {
  const db = fixture(t), mock = mockClient(), events = [];
  assert.deepEqual(await pass(db, mock.client, { maxCreate: 1, report: item => events.push(item) }),
    { created: 1, imported: 0, records: 0, pending: 1, failed: 0 });
  const job = customerReturnJobs(db, config.storeId)[0];
  assert.equal(job.reportType, MFN);
  assert.deepEqual(mock.calls.create[0].marketplaceIds, [config.marketplaceId]);
  assert.equal(customerReturnsView({ db }).coverage.sources[0].recordCount, null);

  mock.set(job, 'IN_PROGRESS');
  assert.equal((await pass(db, mock.client, { create: false })).pending, 1);
  assert.equal(customerReturnJobs(db, config.storeId)[0].status, 'IN_PROGRESS');
  assert.equal(mock.calls.download.length, 0);
  mock.set(job, 'DONE');
  assert.deepEqual(await pass(db, mock.client, { create: false, report: item => events.push(item) }),
    { created: 0, imported: 1, records: 1, pending: 0, failed: 0 });
  const row = customerReturnsView({ db }).items[0];
  assert.equal(row.orderId, values[0]);
  assert.equal(row.sku, 'SKU A');
  assert.equal(row.quantity, 2);
  assert.equal(row.requestedAt, '2026-09-02T13:30:00.000Z');
  assert.equal(row.receivedAt, '2026-09-04');
  assert.equal(row.refund.reportedRefundCents, '12345');
  assert.equal(row.refund.reportedCurrency, 'BRL');
  assert.equal(customerReturnJobs(db, config.storeId)[0].status, 'IMPORTED');
  assert.doesNotMatch(persisted(db), /PRIVATE|signature=|https:\/\/|example\.test/);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|signature=|https:\/\/|example\.test/);

  assert.deepEqual(await pass(db, mock.client, { create: false }),
    { created: 0, imported: 0, records: 0, pending: 0, failed: 0 });
  assert.equal(mock.calls.get.length, 2);
  assert.equal(mock.calls.document.length, 1);
  assert.equal(mock.calls.download.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customer_return_observations').get().n, 1);
});

test('repeated passes do not recreate pending or recently imported windows and preserve distinct sources', async t => {
  const db = fixture(t), mock = mockClient();
  const options = { config: { ...config, historyStart: '2026-09-01T00:00:00.000Z' }, maxCreate: 100 };
  assert.equal((await pass(db, mock.client, options)).created, 2);
  assert.equal((await pass(db, mock.client, options)).created, 0);
  for (const job of customerReturnJobs(db, config.storeId)) mock.set(job, 'DONE');
  const imported = await pass(db, mock.client, options);
  assert.equal(imported.created, 0);
  assert.equal(imported.imported, 2);
  assert.equal(imported.records, 2);
  assert.deepEqual(await pass(db, mock.client, options), { created: 0, imported: 0, records: 0, pending: 0, failed: 0 });
  assert.equal(mock.calls.create.length, 2);
  assert.equal(mock.calls.download.length, 2);
  assert.equal(customerReturnsView({ db }).total, 2);
  assert.equal(customerReturnsView({ db }).coverage.state, 'available');
  const fba = customerReturnsView({ db, filters: { mode: 'FBA' } }).items[0];
  assert.equal(fba.requestedAt, null);
  assert.equal(fba.receivedAt, '2026-09-02T12:00:00.000Z');
  assert.equal(fba.refund.reportedRefundCents, null);
});

test('cancelled and fatal reports never become successful empty imports or erase earlier evidence', async t => {
  const db = fixture(t), mock = mockClient();
  const initial = queued(db, { reportId: 'report-imported', createdAt: '2026-09-24T12:00:00Z' });
  mock.set(initial, 'DONE');
  await pass(db, mock.client, { create: false });
  const cancelled = queued(db, { reportId: 'report-cancelled', reportType: MFN });
  const fatal = queued(db, { reportId: 'report-fatal', reportType: FBA });
  mock.set(cancelled, 'CANCELLED'); mock.set(fatal, 'FATAL');
  const result = await pass(db, mock.client, { create: false, now: () => new Date('2026-09-25T13:00:00Z') });
  assert.equal(result.imported, 0);
  assert.equal(result.records, 0);
  assert.equal(result.pending, 0);
  assert.equal(result.failed, 2);
  assert.equal(mock.calls.download.length, 1);
  for (const job of customerReturnJobs(db, config.storeId).filter(item => item.reportId !== initial.reportId)) {
    assert.equal(job.recordCount, null);
    assert.ok(['CANCELLED', 'FATAL'].includes(job.status));
  }
  const view = customerReturnsView({ db });
  assert.equal(view.total, 1);
  assert.equal(view.coverage.state, 'partial');
  const mfn = view.coverage.sources.find(source => source.reportType === MFN);
  const fba = view.coverage.sources.find(source => source.reportType === FBA);
  assert.equal(mfn.status, 'CANCELLED');
  assert.equal(mfn.recordCount, 1);
  assert.equal(fba.status, 'FATAL');
  assert.equal(fba.recordCount, null);
  assert.equal(fba.observedAt, null);
  assert.equal((await pass(db, mock.client, { create: false })).failed, 0);
});

test('transient failures remain pending, unexpected errors are sanitized and store isolation is preserved', async t => {
  const db = fixture(t), events = [];
  queued(db, { reportId: 'report-retry' });
  queued(db, { reportId: 'report-failure' });
  queued(db, { storeId: 'store-b', reportId: 'report-other-store' });
  const polled = [];
  const client = { async getReport(id) {
    polled.push(id);
    const error = new Error('PRIVATE-EXCEPTION https://secret.invalid?signature=PRIVATE-SIGNATURE');
    if (id === 'report-retry') error.code = 'NETWORK_ERROR';
    throw error;
  } };
  const result = await pass(db, client, { create: false, report: event => { events.push(event); throw new Error('callback failure'); } });
  assert.equal(result.failed, 2);
  assert.equal(result.imported, 0);
  assert.equal(result.pending, 1);
  assert.deepEqual(polled.sort(), ['report-failure', 'report-retry']);
  const jobs = customerReturnJobs(db, config.storeId);
  assert.equal(jobs.find(job => job.reportId === 'report-retry').status, 'IN_QUEUE');
  assert.equal(jobs.find(job => job.reportId === 'report-retry').errorCode, 'NETWORK_ERROR');
  assert.equal(jobs.find(job => job.reportId === 'report-failure').status, 'FAILED');
  assert.equal(jobs.find(job => job.reportId === 'report-failure').errorCode, 'REPORT_COLLECTION_FAILED');
  assert.equal(customerReturnJobs(db, 'store-b')[0].status, 'IN_QUEUE');
  assert.doesNotMatch(persisted(db) + JSON.stringify(events), /PRIVATE|secret\.invalid|signature=/);
  assert.ok(customerReturnsView({ db }).coverage.sources.every(source => source.recordCount === null));
});

test('403 creation failures are attempted once per source per day rather than for every historical window', async t => {
  const db = fixture(t), calls = [], events = [];
  const client = { async createReturnReport(input) {
    calls.push(input);
    throw Object.assign(new Error('PRIVATE permission payload'), { code: 'HTTP_ERROR', status: 403 });
  } };
  const options = { maxCreate: 100, report: event => events.push(event) };
  assert.ok(returnReportWindows(START, new Date(NOW)).length > 2);
  assert.deepEqual(await pass(db, client, options), { created: 2, imported: 0, records: 0, pending: 0, failed: 2 });
  assert.deepEqual(calls.map(call => call.reportType).sort(), [...RETURN_REPORT_TYPES].sort());
  assert.equal((await pass(db, client, { ...options, now: () => new Date('2026-09-26T11:59:59Z') })).created, 0);
  assert.equal(calls.length, 2);
  assert.equal((await pass(db, client, { ...options, now: () => new Date('2026-09-26T12:00:00Z') })).created, 2);
  assert.equal(calls.length, 4);
  assert.equal(customerReturnJobs(db, config.storeId).length, 4);
  assert.ok(customerReturnJobs(db, config.storeId).every(job => job.errorCode === 'HTTP_ERROR_403' && job.recordCount === null));
  assert.doesNotMatch(persisted(db) + JSON.stringify(events), /PRIVATE/);
});

test('temporary creation failures retry historical windows after one hour, then reuse the queued report', async t => {
  const target = returnReportWindows(START, new Date(NOW))[1];
  for (const errorCode of ['TIMEOUT', 'NETWORK_ERROR', 'RATE_LIMITED', 'RATE_LIMITED_429', 'HTTP_ERROR_429', 'HTTP_ERROR_500', 'HTTP_ERROR_502', 'HTTP_ERROR_503', 'HTTP_ERROR_504']) {
    const db = fixture(t), mock = mockClient();
    importedOtherWindows(db, target);
    queued(db, { reportId: `attempt-${errorCode}`, ...target, status: 'FAILED', errorCode });
    assert.equal((await pass(db, mock.client, { maxCreate: 100, now: () => new Date('2026-09-25T12:59:59Z') })).created, 0, errorCode);
    assert.equal((await pass(db, mock.client, { maxCreate: 100, now: () => new Date('2026-09-25T13:00:00Z') })).created, 1, errorCode);
    assert.equal(mock.calls.create.length, 1);
    assert.equal(mock.calls.create[0].dataStartTime, target.from);
    assert.equal(mock.calls.create[0].dataEndTime, target.to);
    assert.equal((await pass(db, mock.client, { maxCreate: 100, now: () => new Date('2026-09-25T14:00:00Z') })).created, 0, errorCode);
    assert.equal(mock.calls.create.length, 1);
  }
});

test('client RATE_LIMITED with HTTP 429 remains retryable during polling and creation', async t => {
  const limited = () => Object.assign(new Error('PRIVATE rate limit response'), { code: 'RATE_LIMITED', status: 429 });
  const db = fixture(t), events = [];
  queued(db);
  const polling = await pass(db, { async getReport() { throw limited(); } },
    { create: false, report: event => events.push(event) });
  assert.equal(polling.failed, 1);
  assert.equal(polling.pending, 1);
  assert.equal(customerReturnJobs(db, config.storeId)[0].status, 'IN_QUEUE');
  assert.equal(customerReturnJobs(db, config.storeId)[0].errorCode, 'RATE_LIMITED_429');
  assert.equal(events[0].status, 'RETRY_PENDING');
  assert.doesNotMatch(persisted(db) + JSON.stringify(events), /PRIVATE/);

  const creationDb = fixture(t), target = returnReportWindows(START, new Date(NOW))[1];
  importedOtherWindows(creationDb, target);
  let attempts = 0;
  const client = { async createReturnReport() {
    attempts++;
    if (attempts === 1) throw limited();
    return { reportId: 'report-after-rate-limit' };
  } };
  assert.equal((await pass(creationDb, client, { maxCreate: 1 })).failed, 1);
  const failure = customerReturnJobs(creationDb, config.storeId).find(job => job.status === 'FAILED');
  assert.equal(failure.errorCode, 'RATE_LIMITED_429');
  assert.ok(failure.reportId.startsWith('attempt-'));
  assert.equal((await pass(creationDb, client, { now: () => new Date('2026-09-25T12:59:59Z') })).created, 0);
  assert.equal(attempts, 1);
  const retry = await pass(creationDb, client, { now: () => new Date('2026-09-25T13:00:00Z') });
  assert.equal(retry.created, 1);
  assert.equal(retry.pending, 1);
  assert.equal(retry.failed, 0);
  assert.equal(attempts, 2);
});

test('latest creation and check times govern retry cooldown instead of insertion or report ID order', async t => {
  const target = returnReportWindows(START, new Date(NOW))[1];
  const db = fixture(t), mock = mockClient();
  importedOtherWindows(db, target);
  queued(db, { reportId: 'attempt-a-later-check', ...target, status: 'FAILED', errorCode: 'NETWORK_ERROR', checkedAt: '2026-09-25T13:00:00Z' });
  queued(db, { reportId: 'attempt-z-earlier-check', ...target, status: 'FAILED', errorCode: 'NETWORK_ERROR' });
  assert.equal((await pass(db, mock.client, { now: () => new Date('2026-09-25T13:59:59Z') })).created, 0);
  assert.equal((await pass(db, mock.client, { now: () => new Date('2026-09-25T14:00:00Z') })).created, 1);

  const importedDb = fixture(t), importedMock = mockClient();
  importedOtherWindows(importedDb, target);
  queued(importedDb, { reportId: 'newer-imported', ...target, status: 'IMPORTED', recordCount: 0 });
  queued(importedDb, { reportId: 'attempt-z-older-failure', ...target, status: 'FAILED', errorCode: 'NETWORK_ERROR',
    createdAt: '2026-09-25T10:00:00Z', checkedAt: '2026-09-25T10:00:00Z' });
  assert.equal((await pass(importedDb, importedMock.client, { now: () => new Date('2026-09-25T14:00:00Z') })).created, 0);
});

test('the shorter cooldown applies only to temporary creation failures and never duplicates an older pending job', async t => {
  const target = returnReportWindows(START, new Date(NOW))[1];
  for (const extra of [{ reportId: 'attempt-permanent', errorCode: 'INVALID_PARAMETERS' },
    { reportId: 'amazon-existing-report', errorCode: 'NETWORK_ERROR' }]) {
    const db = fixture(t), mock = mockClient();
    importedOtherWindows(db, target);
    queued(db, { ...target, ...extra, status: 'FAILED' });
    assert.equal((await pass(db, mock.client, { now: () => new Date('2026-09-25T14:00:00Z') })).created, 0);
  }
  const db = fixture(t), mock = mockClient();
  importedOtherWindows(db, target);
  const pending = queued(db, { reportId: 'pending-older', ...target, createdAt: '2026-09-25T10:00:00Z' });
  queued(db, { reportId: 'attempt-newer', ...target, status: 'FAILED', errorCode: 'HTTP_ERROR_500' });
  mock.set(pending, 'IN_PROGRESS');
  const result = await pass(db, mock.client, { now: () => new Date('2026-09-25T14:00:00Z') });
  assert.equal(result.created, 0);
  assert.equal(result.pending, 1);
  assert.equal(mock.calls.create.length, 0);
});

test('maxCreate bounds successful and failed creation attempts, and aborted passes make no requests', async t => {
  const db = fixture(t), mock = mockClient();
  assert.equal((await pass(db, mock.client, { maxCreate: 3 })).created, 3);
  assert.equal(mock.calls.create.length, 3);
  assert.equal((await pass(db, mock.client, { maxCreate: 0 })).created, 0);
  assert.equal(mock.calls.create.length, 3);
  const before = mock.calls.get.length;
  await pass(db, mock.client, { signal: AbortSignal.abort(), maxCreate: 100 });
  assert.equal(mock.calls.get.length, before);
  assert.equal(mock.calls.create.length, 3);

  const failuresDb = fixture(t);
  let failedCalls = 0;
  const failures = await pass(failuresDb, { async createReturnReport() {
    failedCalls++; throw Object.assign(new Error('temporary failure'), { code: 'NETWORK_ERROR' });
  } }, { maxCreate: 3 });
  assert.equal(failures.created, 3);
  assert.equal(failures.failed, 3);
  assert.equal(failedCalls, 3);
});

test('invalid report identity, missing document, or malformed report cannot establish empty coverage', async t => {
  for (const scenario of ['wrong-type', 'missing-document', 'malformed-body']) {
    const db = fixture(t), mock = mockClient(), job = queued(db, { reportId: `report-${scenario}` });
    mock.set(job, 'DONE', scenario === 'wrong-type' ? { reportType: FBA }
      : scenario === 'missing-document' ? { reportDocumentId: undefined }
        : { body: 'SKU\nPRIVATE-INVALID-REPORT' });
    const result = await pass(db, mock.client, { create: false });
    assert.equal(result.imported, 0, scenario);
    assert.equal(result.failed, 1, scenario);
    assert.equal(customerReturnJobs(db, config.storeId)[0].status, 'FAILED');
    assert.equal(customerReturnJobs(db, config.storeId)[0].recordCount, null);
    assert.equal(customerReturnsView({ db }).total, 0);
    assert.ok(customerReturnsView({ db }).coverage.sources.every(source => source.recordCount === null));
    assert.doesNotMatch(persisted(db), /PRIVATE/);
  }
});

test('a completed header-only report establishes known empty coverage only for its own source', async t => {
  const db = fixture(t), mock = mockClient(), job = queued(db);
  mock.set(job, 'DONE', { body: headers.join('\t') });
  const result = await pass(db, mock.client, { create: false });
  assert.equal(result.imported, 1);
  assert.equal(result.records, 0);
  assert.equal(result.failed, 0);
  const sources = customerReturnsView({ db }).coverage.sources;
  assert.equal(sources.find(source => source.reportType === MFN).recordCount, 0);
  assert.equal(sources.find(source => source.reportType === MFN).status, 'IMPORTED');
  assert.equal(sources.find(source => source.reportType === FBA).recordCount, null);
});
