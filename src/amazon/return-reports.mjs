import { gunzipSync } from 'node:zlib';

// Official contracts: report-type-values-returns, report-type-values-fba and
// reports_2021-06-30.json. Raw reports and presigned URLs stay in memory only.
export const RETURN_REPORT_TYPES = Object.freeze(['GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE', 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA']);
export const RETURN_REPORT_LIMITS = Object.freeze({ downloadBytes: 20 * 1024 * 1024, textBytes: 40 * 1024 * 1024, rows: 100_000, columns: 128, fieldChars: 65_536 });
const fail = code => { throw Object.assign(new Error(`Relatório de devoluções: ${code}.`), { code, operation: 'returnReport' }); };

export function validateReturnReportUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('UNSAFE_REPORT_URL'); }
  const host = url.hostname;
  // Only ordinary S3 endpoints, including virtual-hosted buckets and legacy
  // hyphenated regional hosts; arbitrary amazonaws.com services are not allowed.
  const s3 = /^(?:[a-z0-9][a-z0-9.-]*\.)?s3(?:-external-1|[.-][a-z]{2}(?:-gov)?-[a-z]+-\d)?\.amazonaws\.com$/;
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' || url.hash || !s3.test(host)) fail('UNSAFE_REPORT_URL');
  return url;
}

function reportEncoding(contentType) {
  const declarations = [...String(contentType ?? '').matchAll(/(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]*))/gi)];
  if (declarations.length > 1) fail('INVALID_REPORT_ENCODING');
  const charset = declarations.length ? (declarations[0][1] ?? declarations[0][2] ?? declarations[0][3]).trim().toLowerCase() : 'utf-8';
  // Cp1252 is explicitly supplied by the live Amazon BR return-report response.
  // There is no heuristic fallback for an invalid UTF-8 body without that header.
  const allowed = { 'utf-8': 'utf-8', utf8: 'utf-8', cp1252: 'windows-1252', 'windows-1252': 'windows-1252' };
  if (!Object.hasOwn(allowed, charset)) fail('INVALID_REPORT_ENCODING');
  return allowed[charset];
}

export async function downloadReturnReportDocument(document, { fetchImpl = globalThis.fetch, timeoutMs = 30_000,
  maxDownloadBytes = RETURN_REPORT_LIMITS.downloadBytes, maxTextBytes = RETURN_REPORT_LIMITS.textBytes } = {}) {
  const url = validateReturnReportUrl(document?.url);
  if (document?.compressionAlgorithm !== undefined && document.compressionAlgorithm !== 'GZIP') fail('UNSUPPORTED_COMPRESSION');
  if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000
    || !Number.isInteger(maxDownloadBytes) || maxDownloadBytes < 1 || maxDownloadBytes > RETURN_REPORT_LIMITS.downloadBytes
    || !Number.isInteger(maxTextBytes) || maxTextBytes < 1 || maxTextBytes > RETURN_REPORT_LIMITS.textBytes) fail('INVALID_PARAMETERS');
  const controller = new AbortController(); let timer;
  try {
    return await Promise.race([(async () => {
      const response = await fetchImpl(url.href, { method: 'GET', headers: { 'accept-encoding': 'identity' }, redirect: 'error', signal: controller.signal });
      if (!response.ok) { await response.body?.cancel?.(); fail('REPORT_DOWNLOAD_FAILED'); }
      const size = Number(response.headers.get('content-length'));
      if (Number.isFinite(size) && size > maxDownloadBytes) { await response.body?.cancel?.(); fail('REPORT_TOO_LARGE'); }
      if (!response.body?.getReader) fail('INVALID_REPORT_DOCUMENT');
      const reader = response.body.getReader(), parts = []; let bytes = 0;
      try {
        while (true) { const { done, value } = await reader.read(); if (done) break;
          bytes += value.byteLength; if (bytes > maxDownloadBytes) { await reader.cancel(); fail('REPORT_TOO_LARGE'); } parts.push(value); }
      } finally { reader.releaseLock(); }
      let body = Buffer.concat(parts, bytes);
      if (document.compressionAlgorithm === 'GZIP') {
        try { body = gunzipSync(body, { maxOutputLength: maxTextBytes }); }
        catch (error) { fail(error?.code === 'ERR_BUFFER_TOO_LARGE' ? 'REPORT_TOO_LARGE' : 'INVALID_REPORT_DOCUMENT'); }
      }
      if (body.byteLength > maxTextBytes) fail('REPORT_TOO_LARGE');
      const encoding = reportEncoding(response.headers.get('content-type'));
      let decoded;
      try { decoded = new TextDecoder(encoding, { fatal: true }).decode(body); }
      catch { fail('INVALID_REPORT_ENCODING'); }
      if (Buffer.byteLength(decoded, 'utf8') > maxTextBytes) fail('REPORT_TOO_LARGE');
      return decoded;
    })(), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error('Relatório de devoluções: TIMEOUT.'), { code: 'TIMEOUT', operation: 'returnReport' })); }, timeoutMs); })]);
  } catch (error) {
    if (error?.operation === 'returnReport') throw error;
    fail(controller.signal.aborted ? 'TIMEOUT' : 'REPORT_DOWNLOAD_FAILED');
  } finally { clearTimeout(timer); }
}

function delimited(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > RETURN_REPORT_LIMITS.textBytes) fail('REPORT_TOO_LARGE');
  text = text.replace(/^\uFEFF/, '');
  if (!text.trim()) return [];
  const delimiter = text.split(/\r?\n/, 1)[0].includes('\t') ? '\t' : ',';
  const rows = []; let row = [], field = '', quoted = false, closed = false;
  const cell = () => { row.push(field); field = ''; closed = false; if (row.length > RETURN_REPORT_LIMITS.columns) fail('REPORT_TOO_LARGE'); };
  const line = () => { cell(); if (row.some(value => value !== '')) rows.push(row); row = []; if (rows.length > RETURN_REPORT_LIMITS.rows + 1) fail('REPORT_TOO_LARGE'); };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"') { if (text[index + 1] === '"') { field += '"'; index++; } else { quoted = false; closed = true; } }
      else field += char;
    } else if (char === delimiter) cell();
    else if (char === '\n' || char === '\r') { if (char === '\r' && text[index + 1] === '\n') index++; line(); }
    else if (char === '"' && !field && !closed) quoted = true;
    // Amazon TSV product names can contain a literal inch mark in an unquoted
    // field. It is not a CSV quote boundary; already-quoted fields stay strict.
    else { if (closed || char === '"' && delimiter !== '\t') fail('INVALID_REPORT_FORMAT'); field += char; }
    if (field.length > RETURN_REPORT_LIMITS.fieldChars) fail('REPORT_TOO_LARGE');
  }
  if (quoted) fail('INVALID_REPORT_FORMAT');
  if (field || row.length || closed) line();
  return rows;
}
const header = value => value.trim().toLowerCase().replace(/[\s_-]+/g, ' ');
const clean = (value, max = 500) => typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ? value.trim() : null;
const code = value => { const result = clean(value, 100); return result && /^[A-Za-z][A-Za-z0-9 _:/().-]*$/.test(result) ? result : null; };
function date(value) {
  if (!value) return null;
  // Live MFN reports label days as DD-MMM-YYYY with English month names.
  // This is unambiguous calendar evidence and does not supply a time zone.
  const named = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(value);
  if (named) {
    const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(named[2].toLowerCase()) + 1;
    if (!month) return null;
    value = `${named[3]}-${String(month).padStart(2, '0')}-${named[1].padStart(2, '0')}`;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match) return null;
  const [y, m, d] = match.slice(1, 4).map(Number);
  if (m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return null;
  if (!match[4]) return value; // A calendar day is not an invented midnight instant.
  if (+match[4] > 23 || +match[5] > 59 || +match[6] > 59 || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}
function cents(value) {
  if (!value || !/^-?\d{1,100}(?:\.\d{1,2})?$/.test(value)) return null;
  const negative = value.startsWith('-'), [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  return ((negative ? -1n : 1n) * (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')))).toString();
}

/** Only the returned allowlist may be persisted. Warnings never carry raw cells. */
export function parseReturnReport({ reportType, text } = {}) {
  if (!RETURN_REPORT_TYPES.includes(reportType)) fail('INVALID_PARAMETERS');
  const rows = delimited(text), warnings = [], records = [];
  if (!rows.length) return { records, warnings };
  const headers = rows.shift().map(header);
  if (new Set(headers).size !== headers.length || !headers.includes('order id')) fail('INVALID_REPORT_HEADERS');
  const fba = reportType === RETURN_REPORT_TYPES[1];
  const warn = (row, field) => { if (warnings.length < 1000) warnings.push({ code: 'INVALID_REPORT_FIELD', row, field }); };
  for (let index = 0; index < rows.length; index++) {
    if (rows[index].length !== headers.length) fail('INVALID_REPORT_FORMAT');
    const values = new Map(headers.map((key, i) => [key, rows[index][i].trim()]));
    const get = key => values.get(key) || null;
    const read = (field, key, convert = clean) => { const value = get(key), result = value ? convert(value) : null; if (value && result === null) warn(index + 2, field); return result; };
    const orderId = read('orderId', 'order id', value => /^[A-Za-z0-9-]{1,80}$/.test(value) ? value : null);
    if (!orderId) { warn(index + 2, 'orderId'); continue; }
    const record = { orderId, sku: read('sku', fba ? 'sku' : 'merchant sku'), asin: read('asin', 'asin'),
      productName: read('productName', fba ? 'product name' : 'item name', value => clean(value, 1000)),
      quantity: read('quantity', fba ? 'quantity' : 'return quantity', value => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null),
      returnRequestedAt: fba ? null : read('returnRequestedAt', 'return request date', date),
      returnReceivedAt: read('returnReceivedAt', fba ? 'return date' : 'return delivery date', date),
      returnStatus: read('returnStatus', fba ? 'status' : 'return request status', code),
      reasonCode: read('reasonCode', fba ? 'reason' : 'return reason', value => /^[A-Z][A-Z0-9_:-]{0,99}$/.test(value) ? value : null),
      returnType: fba ? null : read('returnType', 'return type', code), rmaId: fba ? null : read('rmaId', 'amazon rma id'),
      trackingNumber: fba ? null : read('trackingNumber', 'tracking id'), carrier: fba ? null : read('carrier', 'return carrier', code),
      safeTClaimId: fba ? null : read('safeTClaimId', 'safet claim id', value =>
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value) && !/^(?:na|none|null|notavailable|notapplicable)$/i.test(value) ? value : null),
      safeTClaimState: fba ? null : read('safeTClaimState', 'safet claim state', code),
      safeTClaimCreatedAt: fba ? null : read('safeTClaimCreatedAt', 'safet claim creation time', date),
      reportedRefundCents: fba ? null : read('reportedRefundCents', 'refunded amount', cents),
      currency: fba ? null : read('currency', 'currency code', value => /^[A-Z]{3}$/.test(value) ? value : null), reportType };
    records.push(record);
  }
  return { records, warnings };
}
