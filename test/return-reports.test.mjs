import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { AmazonClient } from '../src/amazon/client.mjs';
import { RETURN_REPORT_TYPES, RETURN_REPORT_LIMITS, parseReturnReport, downloadReturnReportDocument } from '../src/amazon/return-reports.mjs';
const [MFN, FBA] = RETURN_REPORT_TYPES;
const url = 'https://reports-bucket.s3.us-east-1.amazonaws.com/object?secret=never-log';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const headers = ['Order ID', 'Merchant SKU', 'ASIN', 'Item Name', 'Return quantity', 'Return request date', 'Return request status', 'Return delivery date', 'Return Reason', 'Return type', 'Amazon RMA ID', 'Tracking ID', 'Return carrier', 'Refunded Amount', 'Currency code'];
const values = ['701-1111111-2222222', 'SKU A', 'ASIN-A', 'Produto', '2', '2026-09-02T10:30:00-03:00', 'Approved', '2026-09-04', 'UNWANTED_ITEM', 'CustomerReturn', 'RMA-A', 'TRACK-A', 'Carrier', '123.45', 'BRL'];
const tsv = (extraHeaders = [], extraValues = []) => `${[...headers, ...extraHeaders].join('\t')}\n${[...values, ...extraValues].join('\t')}`;

test('SAFE-T request fields are imported without a reimbursement amount and tolerate normalized headers', () => {
  const fields = ['SafeT claim id','SafeT claim state','SafeT claim creation time','SafeT claim reimbursement amount'];
  for (const names of [fields, fields.map(name => name.replaceAll(' ', '-')), fields.map(name => name.replaceAll(' ', '_').toUpperCase())]) {
    const parsed = parseReturnReport({ reportType: MFN, text: tsv(names, ['12345-12345-1234567','Pending','24-Sep-2026','']) });
    assert.deepEqual(parsed.warnings, []);
    assert.equal(parsed.records[0].safeTClaimId, '12345-12345-1234567');
    assert.equal(parsed.records[0].safeTClaimState, 'Pending');
    assert.equal(parsed.records[0].safeTClaimCreatedAt, '2026-09-24');
    assert.equal(parsed.records[0].safeTClaimReimbursementAmount, undefined, 'Request metadata must not become payment evidence');
  }
  for (const invalidId of ['N/A', 'NA', '--', 'None', 'https://private.invalid/claim', '<script>bad</script>']) {
    const parsed = parseReturnReport({ reportType: MFN, text: tsv(fields, [invalidId,'Pending','2026-09-24','0']) });
    assert.equal(parsed.records[0].safeTClaimId, null);
    assert.ok(parsed.warnings.some(warning => warning.field === 'safeTClaimId'));
    assert.doesNotMatch(JSON.stringify(parsed), /private.invalid|<script>/);
  }
  const fba = parseReturnReport({ reportType: FBA, text: tsv(fields, ['12345-12345-1234567','Approved','2026-09-24','100']) });
  assert.equal(fba.records[0].safeTClaimId, null);
  assert.equal(fba.records[0].safeTClaimState, null);
});

test('MFN allowlist preserves explicit fields, discards personal columns, and keeps date-only precision', () => {
  const result = parseReturnReport({ reportType: MFN, text: '\uFEFF' + tsv(['buyer-name', 'buyer-email', 'address', 'customer-comments', 'refund-comment'], ['PRIVATE-NAME', 'private@example.test', 'PRIVATE-ADDRESS', 'PRIVATE-COMMENT', 'PRIVATE-REFUND']) });
  assert.equal(result.records.length, 1); assert.deepEqual(result.warnings, []);
  const row = result.records[0];
  assert.equal(row.reportedRefundCents, '12345'); assert.equal(row.quantity, 2);
  assert.equal(row.returnRequestedAt, '2026-09-02T13:30:00.000Z'); assert.equal(row.returnReceivedAt, '2026-09-04');
  assert.equal(row.reasonCode, 'UNWANTED_ITEM'); assert.equal(row.rmaId, 'RMA-A');
  assert.ok(!JSON.stringify(result).includes('PRIVATE')); assert.ok(!JSON.stringify(result).includes('@example'));
});

test('quoted CSV preserves commas, escaped quotes and newlines without leaking excluded cells', () => {
  const body = 'Order ID,Item Name,Merchant SKU,customer-comments\r\n701-1111111-2222222,"Produto, ""modelo""\nlinha 2",SKU,"PRIVATE\nCOMMENT"\r\n';
  const row = parseReturnReport({ reportType: MFN, text: body }).records[0];
  assert.equal(row.productName, 'Produto, "modelo"\nlinha 2'); assert.equal(row.sku, 'SKU');
  assert.equal(row.returnRequestedAt, null); assert.equal(row.reportedRefundCents, null);
  assert.ok(!JSON.stringify(row).includes('PRIVATE'));
});

test('Amazon TSV allows literal inch marks inside unquoted product names without changing columns', () => {
  const body = 'Order ID\tItem Name\tMerchant SKU\tReturn quantity\tcustomer-comments\n701-1111111-2222222\tMonitor 24" IPS\tSKU-A\t2\tPRIVATE\n701-1111111-2222223\t"Produto \"\"modelo\"\"\nlinha 2"\tSKU-B\t1\tPRIVATE';
  const result = parseReturnReport({ reportType: MFN, text: body });
  assert.equal(result.records.length, 2); assert.deepEqual(result.warnings, []);
  assert.equal(result.records[0].productName, 'Monitor 24" IPS'); assert.equal(result.records[0].sku, 'SKU-A'); assert.equal(result.records[0].quantity, 2);
  assert.equal(result.records[1].productName, 'Produto "modelo"\nlinha 2'); assert.equal(result.records[1].sku, 'SKU-B');
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  assert.throws(() => parseReturnReport({ reportType: MFN, text: 'Order ID,Item Name\n701-1111111-2222222,Monitor 24" IPS' }), { code: 'INVALID_REPORT_FORMAT' });
});

test('FBA return date is receipt evidence, never a request date or invented RMA/tracking/refund', () => {
  const body = 'return-date\torder-id\tsku\tasin\tproduct-name\tquantity\treason\tstatus\tcustomer-comments\n2026-09-02T12:00:00Z\t701-1111111-2222222\tSKU\tASIN\tProduto\t1\tDEFECTIVE\tUnit returned to inventory\tPRIVATE';
  const row = parseReturnReport({ reportType: FBA, text: body }).records[0];
  assert.equal(row.returnReceivedAt, '2026-09-02T12:00:00.000Z'); assert.equal(row.returnRequestedAt, null);
  assert.equal(row.reasonCode, 'DEFECTIVE'); assert.equal(row.returnStatus, 'Unit returned to inventory');
  for (const field of ['rmaId', 'trackingNumber', 'carrier', 'returnType', 'reportedRefundCents', 'currency']) assert.equal(row[field], null);
});

test('ambiguous dates, invalid amounts and freeform reasons become null with value-free warnings', () => {
  const bad = [...values]; bad[5] = '09/02/2026'; bad[7] = '2026-02-30'; bad[8] = 'contact private@example.test'; bad[13] = '1.234,56';
  const result = parseReturnReport({ reportType: MFN, text: headers.join('\t') + '\n' + bad.join('\t') });
  for (const field of ['returnRequestedAt', 'returnReceivedAt', 'reasonCode', 'reportedRefundCents']) assert.equal(result.records[0][field], null);
  assert.equal(result.warnings.length, 4); assert.ok(!JSON.stringify(result).includes('@example'));
  bad[5] = '2026-09-02T12:00:00'; bad[7] = ''; bad[13] = '9007199254740993.13';
  const next = parseReturnReport({ reportType: MFN, text: headers.join('\t') + '\n' + bad.join('\t') }).records[0];
  assert.equal(next.returnRequestedAt, null); assert.equal(next.reportedRefundCents, '900719925474099313');
});

test('Amazon MFN named-month dates keep calendar precision and reject impossible or unknown dates', () => {
  const parse = value => parseReturnReport({ reportType: MFN, text: 'Order ID\tReturn request date\n701-1111111-2222222\t' + value });
  assert.equal(parse('02-Sep-2026').records[0].returnRequestedAt, '2026-09-02');
  assert.equal(parse('9-Aug-2026').records[0].returnRequestedAt, '2026-08-09');
  assert.equal(parse('29-Feb-2024').records[0].returnRequestedAt, '2024-02-29');
  for (const value of ['29-Feb-2026', '31-Apr-2026', '12-XYZ-2026']) {
    const result = parse(value); assert.equal(result.records[0].returnRequestedAt, null); assert.equal(result.warnings.length, 1);
  }
});

test('parser rejects malformed quoting, duplicate headers, excess columns and oversized cells', () => {
  for (const text of ['Order ID,Order-ID\na,b', 'SKU\na', 'Order ID,Item Name\na,"open', 'Order ID,Item Name\na,"closed"bad', 'Order ID\na,b']) {
    assert.throws(() => parseReturnReport({ reportType: MFN, text }), error => /INVALID_REPORT/.test(error.code));
  }
  assert.throws(() => parseReturnReport({ reportType: MFN, text: 'Order ID\n' + 'a'.repeat(RETURN_REPORT_LIMITS.fieldChars + 1) }), { code: 'REPORT_TOO_LARGE' });
  assert.throws(() => parseReturnReport({ reportType: MFN, text: Array.from({ length: 129 }, (_, i) => 'h' + i).join(',') }), { code: 'REPORT_TOO_LARGE' });
  assert.throws(() => parseReturnReport({ reportType: 'RESTRICTED_REPORT', text: '' }), { code: 'INVALID_PARAMETERS' });
});

test('download is bounded UTF-8, supports GZIP, sends no authorization and rejects redirects', async () => {
  let calls = 0;
  const text = await downloadReturnReportDocument({ url, compressionAlgorithm: 'GZIP' }, { fetchImpl: async (target, init) => {
    calls++; assert.equal(target, url); assert.equal(init.redirect, 'error'); assert.deepEqual(init.headers, { 'accept-encoding': 'identity' });
    return new Response(gzipSync(Buffer.from('olá\n')));
  } });
  assert.equal(text, 'olá\n'); assert.equal(calls, 1);
  await assert.rejects(downloadReturnReportDocument({ url }, { fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://evil.test' } }) }), { code: 'REPORT_DOWNLOAD_FAILED' });
  await assert.rejects(downloadReturnReportDocument({ url }, { fetchImpl: async () => new Response(Uint8Array.from([0xff])) }), { code: 'INVALID_REPORT_ENCODING' });
  await assert.rejects(downloadReturnReportDocument({ url }, { maxDownloadBytes: 3, fetchImpl: async () => new Response('1234') }), { code: 'REPORT_TOO_LARGE' });
  await assert.rejects(downloadReturnReportDocument({ url, compressionAlgorithm: 'GZIP' }, { maxTextBytes: 3, fetchImpl: async () => new Response(gzipSync(Buffer.from('123456789'))) }), { code: 'REPORT_TOO_LARGE' });
});

test('untrusted report URLs and failures cannot send network requests or reveal URLs/bodies', async () => {
  let calls = 0; const fetchImpl = async () => { calls++; throw new Error('PRIVATE url/secret'); };
  for (const bad of ['http://s3.amazonaws.com/a', 'https://s3.amazonaws.com.evil.test/a', 'https://localhost/a', 'https://amazonaws.com/a', 'https://user:secret@s3.amazonaws.com/a', 'https://s3.amazonaws.com:8443/a', 'https://ec2.us-east-1.amazonaws.com/a', 'https://tortuga-prod-na.s3-external-2.amazonaws.com/a', 'https://tortuga-prod-na.s3-external-1.amazonaws.com.evil.test/a', 'https://example.cloudfront.net/a']) {
    await assert.rejects(downloadReturnReportDocument({ url: bad }, { fetchImpl }), { code: 'UNSAFE_REPORT_URL' });
  }
  assert.equal(calls, 0);
  await assert.rejects(downloadReturnReportDocument({ url }, { fetchImpl }), error => error.code === 'REPORT_DOWNLOAD_FAILED' && !String(error).includes('PRIVATE') && !String(error).includes('secret'));
  await assert.rejects(downloadReturnReportDocument({ url }, { timeoutMs: 5, fetchImpl: () => new Promise(() => {}) }), { code: 'TIMEOUT' });
});

test('explicit Amazon Cp1252 charset decodes Portuguese without guessing or bypassing decoded limits', async () => {
  const encoded = Uint8Array.from([68, 101, 118, 111, 108, 117, 231, 227, 111]);
  for (const charset of ['Cp1252', '"windows-1252"']) {
    assert.equal(await downloadReturnReportDocument({ url }, { fetchImpl: async () => new Response(encoded, { headers: { 'content-type': `text/plain; charset=${charset}` } }) }), 'Devolução');
  }
  assert.equal(await downloadReturnReportDocument({ url, compressionAlgorithm: 'GZIP' }, { fetchImpl: async () => new Response(gzipSync(encoded), { headers: { 'content-type': 'text/plain; charset=Cp1252' } }) }), 'Devolução');
  await assert.rejects(downloadReturnReportDocument({ url }, { fetchImpl: async () => new Response(encoded) }), { code: 'INVALID_REPORT_ENCODING' });
  for (const contentType of ['text/plain; charset=unknown', 'text/plain; charset=UTF-8; charset=Cp1252']) {
    await assert.rejects(downloadReturnReportDocument({ url }, { fetchImpl: async () => new Response(encoded, { headers: { 'content-type': contentType } }) }), { code: 'INVALID_REPORT_ENCODING' });
  }
  await assert.rejects(downloadReturnReportDocument({ url }, { maxTextBytes: encoded.length, fetchImpl: async () => new Response(encoded, { headers: { 'content-type': 'text/plain; charset=Cp1252' } }) }), { code: 'REPORT_TOO_LARGE' });
});

test('Amazon legacy external-1 S3 downloads allow bucket and root hosts without authorization', async () => {
  for (const host of ['tortuga-prod-na.s3-external-1.amazonaws.com', 's3-external-1.amazonaws.com']) {
    const expected = `https://${host}/report?signature=mock`;
    const result = await downloadReturnReportDocument({ url: expected }, { fetchImpl: async (target, init) => {
      assert.equal(target, expected); assert.equal(init.redirect, 'error');
      assert.deepEqual(init.headers, { 'accept-encoding': 'identity' });
      return new Response('safe-report');
    } });
    assert.equal(result, 'safe-report');
  }
});

test('Reports client uses fixed routes, two permitted report types and ordinary LWA token', async () => {
  const calls = [], responses = [json({ access_token: 'mock-token', expires_in: 3600 }), json({ reportId: 'r-1' }, 202),
    json({ reportId: 'r-1', reportType: MFN, processingStatus: 'DONE', reportDocumentId: 'amzn1.spdoc.1.na.mock' }),
    json({ reportDocumentId: 'amzn1.spdoc.1.na.mock', url }), new Response(tsv())];
  const client = new AmazonClient({ clientId: 'mock', clientSecret: 'mock', refreshToken: 'mock', now: () => Date.parse('2026-09-25T00:00:00Z'),
    fetchImpl: async (target, init) => { calls.push({ target, init }); assert.ok(responses.length); return responses.shift(); } });
  assert.deepEqual(await client.createReturnReport({ reportType: MFN, dataStartTime: '2026-09-01T00:00:00Z', dataEndTime: '2026-09-20T00:00:00Z' }), { reportId: 'r-1', requestId: undefined });
  assert.equal((await client.getReport('r-1')).processingStatus, 'DONE');
  const doc = await client.getReportDocument('amzn1.spdoc.1.na.mock'); assert.equal(await client.downloadReturnReportDocument(doc), tsv());
  assert.equal(calls[1].target, 'https://sellingpartnerapi-na.amazon.com/reports/2021-06-30/reports');
  assert.equal(calls[1].init.method, 'POST'); assert.equal(calls[1].init.headers['x-amz-access-token'], 'mock-token');
  assert.equal(calls[2].target, 'https://sellingpartnerapi-na.amazon.com/reports/2021-06-30/reports/r-1');
  assert.equal(calls.at(-1).init.headers['x-amz-access-token'], undefined);
  const count = calls.length;
  await assert.rejects(client.createReturnReport({ reportType: 'GET_ORDER_REPORT_DATA_INVOICING' }), { code: 'INVALID_PARAMETERS' });
  await assert.rejects(client.createReturnReport({ reportType: MFN, dataStartTime: '2026-01-01T00:00:00Z', dataEndTime: '2026-09-20T00:00:00Z' }), { code: 'INVALID_PARAMETERS' });
  await assert.rejects(client.createReturnReport({ reportType: MFN, dataStartTime: '2026-02-30T00:00:00Z', dataEndTime: '2026-03-10T00:00:00Z' }), { code: 'INVALID_PARAMETERS' });
  await assert.rejects(client.getReport('../secrets'), { code: 'INVALID_PARAMETERS' });
  assert.equal(calls.length, count);
});
