import { randomUUID } from 'node:crypto';
import { RETURN_REPORT_TYPES, parseReturnReport } from './amazon/return-reports.mjs';
import { ensureCustomerReturnSchema, customerReturnJobs, saveCustomerReturnJob, importCustomerReturnReport, CUSTOMER_RETURN_IMPORT_VERSION } from './domain/customer-returns.mjs';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const SAFE_ERRORS = new Set(['RATE_LIMITED', 'HTTP_ERROR', 'TIMEOUT', 'NETWORK_ERROR', 'INVALID_RESPONSE', 'INVALID_PARAMETERS', 'UNSAFE_REPORT_URL', 'UNSUPPORTED_COMPRESSION', 'REPORT_DOWNLOAD_FAILED', 'REPORT_TOO_LARGE', 'INVALID_REPORT_DOCUMENT', 'INVALID_REPORT_ENCODING', 'INVALID_REPORT_FORMAT', 'INVALID_REPORT_HEADERS']);
const RETRYABLE_ERRORS = new Set(['TIMEOUT', 'NETWORK_ERROR', 'RATE_LIMITED', 'RATE_LIMITED_429', 'HTTP_ERROR_429', 'HTTP_ERROR_500', 'HTTP_ERROR_502', 'HTTP_ERROR_503', 'HTTP_ERROR_504']);
function codeFor(error) { return SAFE_ERRORS.has(error?.code) ? `${error.code}${Number.isInteger(error.status) ? `_${error.status}` : ''}` : 'REPORT_COLLECTION_FAILED'; }

export function returnReportWindows(historyStart, now = new Date()) {
  const start = new Date(historyStart), end = new Date(now.getTime() - 5 * 60_000);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) throw new TypeError('Invalid report window.');
  // Stable daily cutoffs prevent one new report per hourly monitor pass.
  end.setUTCHours(0, 0, 0, 0);
  if (start >= end) return [];
  const windows = [];
  for (let from = start.getTime(); from < end.getTime(); from += 60 * DAY) windows.push({ from: new Date(from).toISOString(), to: new Date(Math.min(from + 60 * DAY, end.getTime())).toISOString() });
  return windows.reverse();
}

/** One nonblocking pass: queues reports and imports only completed, sanitized documents. */
export async function syncCustomerReturnReports({ db, client, config, now = () => new Date(), create = true, maxCreate = 2, report = () => {}, signal }) {
  ensureCustomerReturnSchema(db);
  const current = new Date(now()), observedAt = current.toISOString();
  const summary = { created: 0, imported: 0, records: 0, pending: 0, failed: 0 };
  const emit = value => { try { report(value); } catch {} };
  for (const job of customerReturnJobs(db, config.storeId).filter(job => ['IN_QUEUE', 'IN_PROGRESS', 'DONE'].includes(job.status)).slice(0, 30)) {
    if (signal?.aborted) break;
    try {
      const result = await client.getReport(job.reportId);
      if (result.reportId !== job.reportId || result.reportType !== job.reportType) throw Object.assign(new Error('Invalid report response.'), { code: 'INVALID_RESPONSE' });
      if (result.processingStatus === 'DONE') {
        if (!result.reportDocumentId) throw Object.assign(new Error('Missing report document.'), { code: 'INVALID_RESPONSE' });
        const document = await client.getReportDocument(result.reportDocumentId);
        // Presigned download URLs and full reports stay in memory; only allowlisted records reach SQLite.
        const body = await client.downloadReturnReportDocument(document);
        const parsed = parseReturnReport({ reportType: job.reportType, text: body });
        const imported = importCustomerReturnReport(db, { storeId: config.storeId, reportId: job.reportId, reportType: job.reportType, records: parsed.records, observedAt, warningCount: parsed.warnings.length });
        summary.imported += Number(imported.imported); summary.records += imported.recordCount;
        emit({ reportType: job.reportType, status: 'IMPORTED', records: imported.recordCount, warnings: parsed.warnings.length });
      } else {
        saveCustomerReturnJob(db, { ...job, status: result.processingStatus, checkedAt: observedAt });
        if (['FATAL', 'CANCELLED'].includes(result.processingStatus)) summary.failed++;
        emit({ reportType: job.reportType, status: result.processingStatus });
      }
    } catch (error) {
      const code = codeFor(error), retryable = RETRYABLE_ERRORS.has(code);
      saveCustomerReturnJob(db, { ...job, status: retryable ? job.status : 'FAILED', checkedAt: observedAt, errorCode: code });
      summary.failed++; emit({ reportType: job.reportType, status: retryable ? 'RETRY_PENDING' : 'FAILED', code });
    }
  }
  if (create && !signal?.aborted) {
    const windows = returnReportWindows(config.historyStart, current);
    for (const window of windows) for (const reportType of RETURN_REPORT_TYPES) {
      if (summary.created >= maxCreate || signal?.aborted) break;
      const jobs = customerReturnJobs(db, config.storeId).filter(job => job.reportType === reportType);
      // Authorization failures are retried at most daily, not once per historical window.
      if (jobs.some(job => job.errorCode === 'HTTP_ERROR_403' && current.getTime() - Date.parse(job.checkedAt) < DAY)) continue;
      const matching = jobs.filter(job => job.from === window.from && job.to === window.to);
      if (matching.some(job => ['IN_QUEUE', 'IN_PROGRESS', 'DONE'].includes(job.status))) continue;
      // Creation time defines the latest attempt; checkedAt resolves equal creation timestamps.
      const previous = matching.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.checkedAt.localeCompare(b.checkedAt)).at(-1);
      const retryCreation = previous?.status === 'FAILED' && previous.reportId.startsWith('attempt-') && RETRYABLE_ERRORS.has(previous.errorCode);
      const refreshAfter = retryCreation ? HOUR : window === windows[0] ? DAY : 7 * DAY;
      const attemptedAt = retryCreation ? previous.checkedAt : previous?.createdAt;
      // Older imports discarded SAFE-T request columns. Refresh each MFN window
      // once with the new parser, using the existing bounded queue and retries.
      const needsClaimFields = reportType === RETURN_REPORT_TYPES[0] && previous?.status === 'IMPORTED'
        && previous.importVersion < CUSTOMER_RETURN_IMPORT_VERSION;
      if (previous && !needsClaimFields && current.getTime() - Date.parse(attemptedAt) < refreshAfter) continue;
      const base = { storeId: config.storeId, reportType, ...window, createdAt: observedAt, checkedAt: observedAt };
      try {
        const result = await client.createReturnReport({ reportType, dataStartTime: window.from, dataEndTime: window.to, marketplaceIds: [config.marketplaceId] });
        saveCustomerReturnJob(db, { ...base, reportId: result.reportId, status: 'IN_QUEUE' });
        summary.created++; emit({ reportType, status: 'IN_QUEUE', from: window.from, to: window.to });
      } catch (error) {
        const code = codeFor(error);
        saveCustomerReturnJob(db, { ...base, reportId: `attempt-${randomUUID()}`, status: 'FAILED', errorCode: code });
        summary.created++; summary.failed++; emit({ reportType, status: 'FAILED', code });
      }
    }
  }
  summary.pending = customerReturnJobs(db, config.storeId).filter(job => ['IN_QUEUE', 'IN_PROGRESS', 'DONE'].includes(job.status)).length;
  return summary;
}
