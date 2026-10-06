import { canonicalStoreSelection, storeArgs } from './store-filter.mjs';
import { createHash } from 'node:crypto';
import { ORDER_STATUS_CATALOG } from './order-status.mjs';
import { projectLocalReviews } from './review-projection.mjs';
import { getLocalReviewHistory } from './local-reviews.mjs';
import { orderFinancialEligibility } from './financial-eligibility.mjs';
import { ensureSafeTClaimsSchema, importSafeTReportClaim } from './safe-t-claims.mjs';

export const CUSTOMER_RETURN_IMPORT_VERSION = 1;

export const CUSTOMER_RETURN_TYPES = Object.freeze({
  GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE: 'Solicitações de devolução do vendedor',
  GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA: 'Devoluções recebidas no FBA',
});
const FBA = 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA';
const safeStore = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const invalid = () => Object.assign(new TypeError('Invalid customer return data.'), { code: 'INVALID_PARAMETERS' });
const text = (value, max = 512) => typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value) ? value.trim() : null;
const searchText = value => String(value ?? '').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('pt-BR');
function instant(value) {
  if (typeof value !== 'string') return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) return null;
  const [year, month, day, hour, minute, second] = parts.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 || minute > 59 || second > 59 || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}
function dateValue(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
  }
  return instant(value);
}

export function ensureCustomerReturnSchema(db) {
  ensureSafeTClaimsSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS customer_return_report_jobs (
    store_id TEXT NOT NULL,report_id TEXT NOT NULL,report_type TEXT NOT NULL,from_at TEXT,to_at TEXT,
    status TEXT NOT NULL,created_at TEXT NOT NULL,checked_at TEXT NOT NULL,error_code TEXT,record_count INTEGER,warning_count INTEGER,
    PRIMARY KEY(store_id,report_id));
    CREATE TABLE IF NOT EXISTS customer_return_records (
    store_id TEXT NOT NULL,return_id TEXT NOT NULL,report_type TEXT NOT NULL,first_observed_at TEXT NOT NULL,
    observed_at TEXT NOT NULL,report_id TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(store_id,return_id));
    CREATE TABLE IF NOT EXISTS customer_return_observations (
    store_id TEXT NOT NULL,return_id TEXT NOT NULL,report_id TEXT NOT NULL,observed_at TEXT NOT NULL,payload_json TEXT NOT NULL,
    PRIMARY KEY(store_id,return_id,report_id));
    CREATE TABLE IF NOT EXISTS customer_return_report_import_versions (
      store_id TEXT NOT NULL,report_id TEXT NOT NULL,version INTEGER NOT NULL,
      PRIMARY KEY(store_id,report_id));`);
}

export function saveCustomerReturnJob(db, job) {
  ensureCustomerReturnSchema(db);
  if (!safeStore(job.storeId) || !text(job.reportId, 256) || !Object.hasOwn(CUSTOMER_RETURN_TYPES, job.reportType)
    || !['IN_QUEUE', 'IN_PROGRESS', 'DONE', 'CANCELLED', 'FATAL', 'FAILED', 'IMPORTED'].includes(job.status)
    || !instant(job.createdAt) || !instant(job.checkedAt)) throw invalid();
  const code = job.errorCode && /^[A-Z_]{1,60}(?:_\d{3})?$/.test(job.errorCode) ? job.errorCode : null;
  db.prepare(`INSERT INTO customer_return_report_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(store_id,report_id)
    DO UPDATE SET status=excluded.status,checked_at=excluded.checked_at,error_code=excluded.error_code,
    record_count=COALESCE(excluded.record_count,customer_return_report_jobs.record_count),
    warning_count=COALESCE(excluded.warning_count,customer_return_report_jobs.warning_count)`)
    .run(job.storeId, job.reportId, job.reportType, instant(job.from), instant(job.to), job.status, instant(job.createdAt), instant(job.checkedAt), code,
      Number.isSafeInteger(job.recordCount) && job.recordCount >= 0 ? job.recordCount : null,
      Number.isSafeInteger(job.warningCount) && job.warningCount >= 0 ? job.warningCount : null);
}

export function customerReturnJobs(db, storeId) {
  ensureCustomerReturnSchema(db);
  if (!safeStore(storeId)) throw invalid();
  return db.prepare(`SELECT store_id AS storeId,report_id AS reportId,report_type AS reportType,from_at AS "from",to_at AS "to",
    status,created_at AS createdAt,checked_at AS checkedAt,error_code AS errorCode,record_count AS recordCount,warning_count AS warningCount,
    COALESCE((SELECT version FROM customer_return_report_import_versions v WHERE v.store_id=customer_return_report_jobs.store_id
      AND v.report_id=customer_return_report_jobs.report_id),0) AS importVersion
    FROM customer_return_report_jobs WHERE store_id=? ORDER BY created_at,report_id`).all(storeId).map(row => ({ ...row }));
}

// Only operational report columns reach persistence. Source customer comments and contact data never do.
function safeRecord(record, reportType) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw invalid();
  const result = {};
  for (const key of ['orderId', 'sku', 'asin', 'productName', 'returnStatus', 'reasonCode', 'returnType', 'rmaId', 'trackingNumber', 'carrier']) result[key] = text(record[key], key === 'productName' ? 2000 : 512);
  result.reasonCode = /^[A-Z][A-Z0-9_:-]{0,99}$/.test(result.reasonCode ?? '') ? result.reasonCode : null;
  result.quantity = Number.isSafeInteger(record.quantity) && record.quantity >= 0 ? record.quantity : null;
  result.returnRequestedAt = dateValue(record.returnRequestedAt);
  result.returnReceivedAt = dateValue(record.returnReceivedAt);
  const claimId = text(record.safeTClaimId, 100);
  result.safeTClaimId = reportType !== FBA && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(claimId ?? '')
    && !/^(?:na|none|null|notavailable|notapplicable)$/i.test(claimId) ? claimId : null;
  result.safeTClaimState = result.safeTClaimId ? text(record.safeTClaimState, 100) : null;
  result.safeTClaimCreatedAt = result.safeTClaimId ? dateValue(record.safeTClaimCreatedAt) : null;
  result.reportedRefundCents = typeof record.reportedRefundCents === 'string' && /^-?\d{1,100}$/.test(record.reportedRefundCents) ? record.reportedRefundCents : null;
  result.currency = typeof record.currency === 'string' && /^[A-Z]{3}$/.test(record.currency) ? record.currency : null;
  result.reportType = reportType;
  if (!result.orderId && !result.rmaId && !result.trackingNumber) throw invalid();
  return result;
}

export function importCustomerReturnReport(db, { storeId, reportId, reportType, records, observedAt, warningCount = 0 }) {
  ensureCustomerReturnSchema(db);
  if (!safeStore(storeId) || !text(reportId, 256) || !Object.hasOwn(CUSTOMER_RETURN_TYPES, reportType) || !instant(observedAt) || !Array.isArray(records) || records.length > 100000) throw invalid();
  const job = customerReturnJobs(db, storeId).find(item => item.reportId === reportId);
  if (!job || job.reportType !== reportType) throw invalid();
  if (job.status === 'IMPORTED' && job.importVersion >= CUSTOMER_RETURN_IMPORT_VERSION) return { imported: false, recordCount: job.recordCount };
  const occurrences = new Map();
  const rows = records.map(record => {
    const safe = safeRecord(record, reportType);
    const identity = JSON.stringify([reportType, safe.orderId, safe.sku, safe.asin,
      safe.rmaId || safe.trackingNumber || safe.returnRequestedAt || safe.returnReceivedAt]);
    const occurrence = occurrences.get(identity) ?? 0; occurrences.set(identity, occurrence + 1);
    return { returnId: `return-${hash(JSON.stringify([storeId, identity, occurrence]))}`, record: safe, payload: JSON.stringify(safe) };
  });
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      importSafeTReportClaim(db, { storeId, record: row.record, reportId, reportType, reportCreatedAt: job.createdAt, observedAt });
      db.prepare(`INSERT OR IGNORE INTO customer_return_observations VALUES(?,?,?,?,?)`).run(storeId, row.returnId, reportId, observedAt, row.payload);
      db.prepare(`INSERT INTO customer_return_records VALUES(?,?,?,?,?,?,?) ON CONFLICT(store_id,return_id)
        DO UPDATE SET observed_at=excluded.observed_at,report_id=excluded.report_id,payload_json=excluded.payload_json
        WHERE excluded.observed_at>=customer_return_records.observed_at`)
        .run(storeId, row.returnId, reportType, observedAt, observedAt, reportId, row.payload);
    }
    saveCustomerReturnJob(db, { ...job, status: 'IMPORTED', checkedAt: observedAt, recordCount: rows.length, warningCount });
    db.prepare(`INSERT INTO customer_return_report_import_versions VALUES(?,?,?) ON CONFLICT(store_id,report_id)
      DO UPDATE SET version=excluded.version`).run(storeId, reportId, CUSTOMER_RETURN_IMPORT_VERSION);
    db.exec('COMMIT');
    return { imported: true, recordCount: rows.length };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function coverage(db, storeId) {
  const jobs = db.prepare('SELECT * FROM customer_return_report_jobs WHERE (? IS NULL OR store_id IN (SELECT value FROM json_each(?))) ORDER BY checked_at DESC,report_id').all(...storeArgs(storeId));
  const sources = Object.entries(CUSTOMER_RETURN_TYPES).map(([reportType, label]) => {
    const matching = jobs.filter(job => job.report_type === reportType), windows = new Map();
    for (const job of matching) {
      const key = JSON.stringify([job.store_id, job.from_at, job.to_at]), previous = windows.get(key);
      if (!previous || job.created_at > previous.created_at || job.created_at === previous.created_at && job.checked_at > previous.checked_at) windows.set(key, job);
    }
    const current = [...windows.values()], incomplete = current.find(job => job.status !== 'IMPORTED');
    const imported = matching.filter(job => job.status === 'IMPORTED');
    const from = imported.map(job => job.from_at).filter(Boolean).sort()[0] ?? null;
    const to = imported.map(job => job.to_at).filter(Boolean).sort().at(-1) ?? null;
    const recordCount = imported.length ? db.prepare('SELECT COUNT(*) AS total FROM customer_return_records WHERE report_type=? AND (? IS NULL OR store_id IN (SELECT value FROM json_each(?)))').get(reportType, ...storeArgs(storeId)).total : null;
    return { reportType, label, status: incomplete?.status ?? (imported.length ? 'IMPORTED' : 'NOT_COLLECTED'), observedAt: imported[0]?.checked_at ?? null,
      errorCode: incomplete?.error_code ?? null, from, to, recordCount,
      warningCount: imported.length ? current.filter(job => job.status === 'IMPORTED').reduce((sum, job) => sum + (job.warning_count ?? 0), 0) : null,
      importedWindows: current.filter(job => job.status === 'IMPORTED').length, totalWindows: current.length };
  });
  return { state: !jobs.length ? 'missing' : sources.every(source => source.status === 'IMPORTED') ? 'available' : 'partial', sources };
}

function refundIndex(cases) {
  return new Map(cases.filter(item => item.orderIds?.length === 1).map(item => [JSON.stringify([item.storeId, item.orderIds[0]]), {
    status: 'recorded', count: item.refundCount, latestPostedAt: item.lastEventAt, byCurrency: item.byCurrency,
    hasUnknownOriginalDate: !item.eventDateKnown,
  }]));
}

function projectedRows({ db, orders, refundCases, storeId }) {
  const orderIndex = new Map(orders.map(order => [JSON.stringify([order.storeId, order.orderId]), order]));
  const refunds = refundIndex(refundCases);
  const excludedRefundOrders = new Set(refundCases.filter(item => item.financialEligibility?.included === false)
    .flatMap(item => (item.orderIds ?? []).map(orderId => JSON.stringify([item.storeId, orderId]))));
  return db.prepare('SELECT * FROM customer_return_records WHERE (? IS NULL OR store_id IN (SELECT value FROM json_each(?)))').all(...storeArgs(storeId)).map(row => {
    const record = JSON.parse(row.payload_json), key = JSON.stringify([row.store_id, record.orderId]);
    const order = orderIndex.get(key), product = order?.items?.find(item => record.sku ? item.sku === record.sku : record.asin && item.asin === record.asin);
    const mode = record.reportType === FBA ? 'FBA' : ['DBA', 'MFN'].includes(order?.fulfillmentMode) ? order.fulfillmentMode : 'unknown';
    const matches = record.trackingNumber ? (order?.packages ?? []).filter(pkg => pkg.trackingNumber === record.trackingNumber) : [];
    const trackingCodes = [...new Set(matches.map(pkg => pkg.detailedStatus || pkg.status).filter(Boolean))];
    const trackingStatus = trackingCodes.length === 1 ? trackingCodes[0] : null;
    const reportedRefund = record.reportedRefundCents !== null && BigInt(record.reportedRefundCents) > 0n;
    const financialEligibility = excludedRefundOrders.has(key) ? { included: false, reason: 'payment-pending' }
      : orderFinancialEligibility(order);
    const financialRefund = refunds.get(key);
    const refund = financialRefund ? { ...financialRefund, source: 'financial-transactions' }
      : reportedRefund ? { status: 'recorded', source: 'return-report', count: null, latestPostedAt: null,
        byCurrency: record.currency ? [{ currency: record.currency, totalCents: record.reportedRefundCents }] : [], hasUnknownOriginalDate: true }
        : { status: 'not_found', source: null, count: 0, latestPostedAt: null, byCurrency: [], hasUnknownOriginalDate: false };
    return { returnId: row.return_id, storeId: row.store_id, orderId: record.orderId, sku: record.sku, asin: record.asin,
      productName: record.productName || product?.title || null, quantity: record.quantity, fulfillmentMode: mode, financialEligibility,
      requestedAt: record.returnRequestedAt, receivedAt: record.returnReceivedAt, returnStatus: record.returnStatus,
      reasonCode: record.reasonCode, returnType: record.returnType, rmaId: record.rmaId, trackingNumber: record.trackingNumber, carrier: record.carrier,
      tracking: { status: trackingStatus, label: trackingStatus ? ORDER_STATUS_CATALOG[trackingStatus]?.label || trackingStatus : null,
        updatedAt: null, observedAt: trackingStatus ? order?.trackingObservedAt ?? null : null, source: trackingStatus ? 'order-package-match' : 'not_available' },
      refund: { ...refund, financialEligibility, reportedByReturn: reportedRefund,
        reportedRefundCents: record.reportedRefundCents, reportedCurrency: record.currency },
      sourceLabel: CUSTOMER_RETURN_TYPES[record.reportType], reportType: record.reportType, observedAt: row.observed_at,
      dateBasis: record.reportType === FBA ? 'received' : 'requested' };
  });
}

export function customerReturnsView({ db, orders = [], refundCases = [], filters = {}, returnId }) {
  ensureCustomerReturnSchema(db);
  const storeId = canonicalStoreSelection(filters.storeId);
  canonicalStoreSelection(storeId);
  const mode = filters.mode ?? 'all', refund = filters.refund ?? 'all';
  if (!['all', 'FBA', 'DBA', 'MFN', 'unknown'].includes(mode) || !['all', 'recorded', 'not_found'].includes(refund)) throw invalid();
  const from = filters.from ? dateValue(filters.from) : null, to = filters.to ? dateValue(filters.to) : null;
  if (filters.from && !from || filters.to && !to || from && to && from > to) throw invalid();
  const toDay = value => value?.length === 10 ? value : value ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value)) : null;
  const rows = projectedRows({ db, orders, refundCases, storeId });
  if (returnId !== undefined) {
    if (storeId === 'all' || !safeStore(storeId) || !/^return-[a-f0-9]{64}$/.test(returnId)) throw invalid();
    const row = rows.find(row => row.returnId === returnId);
    if (!row) return null;
    const projection = projectLocalReviews(db, 'customer-returns', [row], item => item.returnId);
    return { ...projection.items[0], reviewStatuses: projection.reviewStatuses,
      reviewHistory: getLocalReviewHistory(db, { menu: 'customer-returns', storeId, entityId: returnId }) };
  }
  const query = searchText(filters.query);
  const scoped = rows.filter(row => (mode === 'all' || row.fulfillmentMode === mode)
    && (refund === 'all' || row.financialEligibility.included && row.refund.status === refund)
    && (!query || searchText([row.orderId, row.sku, row.asin, row.productName, row.trackingNumber, row.rmaId].filter(Boolean).join(' ')).includes(query)));
  const dateFor = row => row.dateBasis === 'received' ? row.receivedAt : row.requestedAt;
  const dated = scoped.filter(row => !from && !to || dateFor(row) && (!from || toDay(dateFor(row)) >= toDay(from)) && (!to || toDay(dateFor(row)) <= toDay(to)))
    .sort((a, b) => String(dateFor(b) ?? '').localeCompare(String(dateFor(a) ?? '')) || a.returnId.localeCompare(b.returnId));
  const projection = projectLocalReviews(db, 'customer-returns', dated, row => row.returnId, filters.reviewStatus);
  const selected = projection.items;
  const offset = Math.max(0, Number.isSafeInteger(Number(filters.offset)) ? Number(filters.offset) : 0);
  const limit = Math.max(1, Math.min(500, Number.isSafeInteger(Number(filters.limit)) && Number(filters.limit) > 0 ? Number(filters.limit) : 100));
  return { items: selected.slice(offset, offset + limit), total: selected.length, offset, limit, hasMore: offset + limit < selected.length,
    reviewStatusOptions: projection.reviewStatusOptions, reviewStatuses: projection.reviewStatuses,
    summary: { caseCount: selected.length, refundedCount: selected.filter(row => row.financialEligibility.included && row.refund.status === 'recorded').length,
      withoutRefundCount: selected.filter(row => row.financialEligibility.included && row.refund.status !== 'recorded').length,
      excludedPaymentPendingCount: selected.filter(row => !row.financialEligibility.included).length,
      undatedExcludedCount: from || to ? scoped.filter(row => !dateFor(row)).length : 0 }, coverage: coverage(db, storeId) };
}
