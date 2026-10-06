import test from 'node:test';
import assert from 'node:assert/strict';
import { AmazonClient, AmazonApiError, AMAZON_BR_MARKETPLACE_ID } from '../src/amazon/client.mjs';

const NOW = Date.parse('2026-09-24T12:00:00Z');
const CREDS = { clientId: 'mock-client', clientSecret: 'mock-secret', refreshToken: 'mock-refresh' };
const RANGE = { createdAfter: '2026-09-01T00:00:00Z', createdBefore: '2026-09-02T00:00:00Z' };
const FINANCE_RANGE = { postedAfter: '2026-09-01T00:00:00Z', postedBefore: '2026-09-02T00:00:00Z' };
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const lwa = (access_token = 'mock-access', expires_in = 3600) => json({ access_token, expires_in, token_type: 'bearer' });
const stock = (inventorySummaries = [], pagination) => json({ payload: { granularity: { granularityType: 'Marketplace', granularityId: AMAZON_BR_MARKETPLACE_ID }, inventorySummaries }, ...(pagination ? { pagination } : {}) });
async function collect(iterator) { const pages = []; for await (const page of iterator) pages.push(page); return pages; }

test('SAFE-T queries preserve the exact order across empty-page pagination and use the documented financial route', async () => {
  const orderId = '701-1111111-2222222';
  const { client, calls } = mockClient([lwa(), json({ payload: { FinancialEvents: {}, NextToken: 'a+/=&?' } }),
    json({ payload: { FinancialEvents: { SAFETReimbursementEventList: [{ SAFETClaimId: 'claim1' }] } } })]);
  const pages = await collect(client.listFinancialEventsByOrderId(orderId));
  assert.equal(pages.length, 2);
  assert.deepEqual(pages[0].safeTEvents, []);
  assert.equal(pages[1].safeTEvents[0].SAFETClaimId, 'claim1');
  assert.ok(pages.every(page => page.orderId === orderId));
  assert.ok(calls.slice(1).every(call => call.url.pathname === `/finances/v0/orders/${orderId}/financialEvents`
    && call.url.searchParams.get('MaxResultsPerPage') === '100' && call.init.method === 'GET'));
  assert.equal(calls[2].url.searchParams.get('NextToken'), 'a+/=&?');
});

test('SAFE-T rejects invalid order IDs before authentication and malformed event envelopes', async () => {
  const invalid = mockClient([]);
  await assert.rejects(collect(invalid.client.listFinancialEventsByOrderId('../financialEvents')), { code: 'INVALID_PARAMETERS' });
  assert.equal(invalid.calls.length, 0);
  const { client } = mockClient([lwa(), json({ payload: { FinancialEvents: { SAFETReimbursementEventList: {} } } })]);
  await assert.rejects(collect(client.listFinancialEventsByOrderId('701-1111111-2222222')), { code: 'INVALID_RESPONSE' });
});
function mockClient(responses, options = {}) {
  const calls = [];
  const sleeps = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url), init });
    assert.ok(responses.length, 'Unexpected request; all network calls must have a mock response');
    const next = responses.shift();
    return typeof next === 'function' ? next(url, init) : next;
  };
  const client = new AmazonClient({ ...CREDS, fetchImpl, now: () => NOW, sleep: async ms => { sleeps.push(ms); }, ...options });
  return { client, calls, sleeps };
}

test('credentials fail locally, and client inspection does not expose supplied secrets', () => {
  let calls = 0;
  assert.throws(() => new AmazonClient({ fetchImpl: () => { calls++; } }), { code: 'MISSING_CREDENTIALS' });
  assert.equal(calls, 0);
  const { client } = mockClient([]);
  assert.equal(JSON.stringify(client), '{}');
});

test('orders use current fixed GET route, safe datasets, documented pagination and raw bytes', async () => {
  const raw = '{ "orders": [{"orderId":"701-1111111-2222222","proceeds":{"grandTotal":{"amount":"12.3400","currencyCode":"BRL"}}}], "pagination": {"nextToken":"a+/=&? token"} }';
  const { client, calls } = mockClient([lwa(), new Response(raw, { headers: { 'x-amzn-requestid': 'req-1' } }), json({ orders: [] })]);
  const pages = await collect(client.searchOrders(RANGE));
  assert.equal(pages.length, 2);
  assert.equal(pages[0].rawBody, raw);
  assert.equal(pages[0].requestId, 'req-1');
  assert.equal(pages[0].orders[0].proceeds.grandTotal.amount, '12.3400');
  assert.equal(pages[0].nextToken, 'a+/=&? token');
  assert.equal(pages[1].nextToken, undefined);
  assert.equal(calls[0].url.href, 'https://api.amazon.com/auth/o2/token');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].init.body)), {
    grant_type: 'refresh_token', refresh_token: CREDS.refreshToken, client_id: CREDS.clientId, client_secret: CREDS.clientSecret,
  });
  for (const { url, init } of calls.slice(1)) {
    assert.equal(url.origin, 'https://sellingpartnerapi-na.amazon.com');
    assert.equal(url.pathname, '/orders/2026-01-01/orders');
    assert.equal(url.searchParams.get('marketplaceIds'), AMAZON_BR_MARKETPLACE_ID);
    assert.equal(url.searchParams.get('includedData'), 'PROCEEDS,EXPENSE,PROMOTION,PACKAGES,FULFILLMENT');
    assert.equal(url.searchParams.get('createdAfter'), RANGE.createdAfter);
    assert.equal(url.searchParams.get('createdBefore'), RANGE.createdBefore);
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['x-amz-access-token'], 'mock-access');
    assert.equal(init.headers['x-amz-date'], '20260924T120000Z');
    assert.equal(init.headers['user-agent'], 'SynthAmazon/0.1 (Language=Node.js)');
    assert.equal(init.body, undefined);
  }
  assert.equal(calls[2].url.searchParams.get('paginationToken'), 'a+/=&? token');
  assert.equal(calls[2].url.searchParams.has('nextToken'), false);
});

test('getOrder requests only PACKAGES and keeps absence distinct from an empty package list', async () => {
  const { client, calls } = mockClient([lwa(), json({ order: { orderId: '701-1111111-2222222' } })]);
  const result = await client.getOrder('701-1111111-2222222');
  assert.equal(result.order.packages, undefined);
  assert.equal(calls[1].url.pathname, '/orders/2026-01-01/orders/701-1111111-2222222');
  assert.equal(calls[1].url.searchParams.get('includedData'), 'PACKAGES');
  assert.deepEqual(JSON.parse(result.rawBody), { order: result.order });
});

test('saldo pagina ciclos financeiros inclusive páginas vazias e mantém a janela de 180 dias', async () => {
  const { client, calls } = mockClient([lwa(), json({payload:{FinancialEventGroupList:[],NextToken:'next+/='}}), json({payload:{FinancialEventGroupList:[{FinancialEventGroupId:'a'}]}})]);
  const pages = await collect(client.listFinancialEventGroups());
  assert.equal(pages.length,2);
  for (const call of calls.slice(1)) {
    assert.equal(call.url.pathname,'/finances/v0/financialEventGroups');
    assert.equal(call.init.method,'GET');
    assert.equal(call.url.searchParams.get('MaxResultsPerPage'),'100');
    assert.equal(Date.parse(call.url.searchParams.get('FinancialEventGroupStartedBefore')),NOW-300000);
    assert.equal(Date.parse(call.url.searchParams.get('FinancialEventGroupStartedAfter')),NOW-300000-180*86400000);
  }
  assert.equal(calls[2].url.searchParams.get('NextToken'),'next+/=');
});

test('getOrder permits operational FULFILLMENT explicitly while retaining exact raw text and rejecting restricted fields', async () => {
  const raw = '{ "order": {"orderId":"order-old","orderItems":[],"fulfillment":{"fulfilledBy":"AMAZON","fulfillmentStatus":"CANCELLED"},"proceeds":{"grandTotal":{"amount":9007199254740993.13,"currencyCode":"BRL"}}} }';
  const { client, calls } = mockClient([lwa(), new Response(raw)]);
  const result = await client.getOrder('order-old', { includedData: ['PACKAGES', 'FULFILLMENT'] });
  assert.equal(result.rawBody, raw);
  assert.equal(result.order.fulfillment.fulfillmentStatus, 'CANCELLED');
  assert.equal(calls[1].url.searchParams.get('includedData'), 'PACKAGES,FULFILLMENT');
  const restricted = mockClient([lwa(), json({ order: { orderId: 'order-old',
    orderItems: [{ fulfillment: { packing: { giftOption: { giftMessage: 'private text' } } } }] } })]);
  await assert.rejects(restricted.client.getOrder('order-old', { includedData: ['PACKAGES', 'FULFILLMENT'] }), { code: 'UNEXPECTED_RESTRICTED_DATA' });
  const denied = mockClient([]);
  for (const includedData of [['BUYER'], ['RECIPIENT'], ['TAX'], ['PAYMENT'], ['PROCEEDS']]) {
    await assert.rejects(denied.client.getOrder('order-old', { includedData }), { code: 'INVALID_PARAMETERS' });
  }
  assert.equal(denied.calls.length, 0);
});

test('operational fulfillment status is available without requesting personal datasets and unexpected gift text fails closed', async () => {
  const safe = mockClient([lwa(), json({ orders: [{ orderId: 'order-a', fulfillment: { fulfilledBy: 'MERCHANT', fulfillmentStatus: 'UNSHIPPED' }, orderItems: [] }] })]);
  const pages = await collect(safe.client.searchOrders(RANGE));
  assert.equal(pages[0].orders[0].fulfillment.fulfillmentStatus, 'UNSHIPPED');
  const requested = safe.calls[1].url.searchParams.get('includedData').split(',');
  assert.ok(requested.includes('FULFILLMENT'));
  assert.ok(!requested.some(dataset => ['BUYER', 'RECIPIENT', 'TAX', 'PAYMENT'].includes(dataset)));
  const unexpected = mockClient([lwa(), json({ orders: [{ orderId: 'order-a', orderItems: [{ fulfillment: { packing: { giftOption: { giftMessage: 'do not persist' } } } }] }] })]);
  await assert.rejects(collect(unexpected.client.searchOrders(RANGE)), { code: 'UNEXPECTED_RESTRICTED_DATA' });
});

test('finances preserve empty intermediate pages and payload nextToken', async () => {
  const raw = '{"payload":{"transactions":[{"transactionId":"t-1","totalAmount":{"currencyAmount":9007199254740993,"currencyCode":"BRL"}}]}}';
  const { client, calls } = mockClient([lwa(), json({ payload: { nextToken: 'finance-cursor' } }), new Response(raw)]);
  const pages = await collect(client.listTransactions(FINANCE_RANGE));
  assert.deepEqual(pages[0].transactions, []);
  assert.equal(pages[1].transactions[0].transactionId, 't-1');
  assert.equal(pages[1].rawBody, raw, 'Exact financial source text must survive JSON numeric precision limits');
  assert.equal(calls[2].url.pathname, '/finances/2024-06-19/transactions');
  assert.equal(calls[2].url.searchParams.get('nextToken'), 'finance-cursor');
  assert.equal(calls[2].url.searchParams.get('postedAfter'), FINANCE_RANGE.postedAfter);
  assert.equal(calls[2].url.searchParams.get('marketplaceId'), AMAZON_BR_MARKETPLACE_ID);
});

test('inventory reads top-level pagination and retains filters for next page', async () => {
  const { client, calls } = mockClient([lwa(), stock([{ sellerSku: 'SKU-1', totalQuantity: 0 }], { nextToken: 'stock-cursor' }), stock()]);
  const pages = await collect(client.getInventorySummaries({ startDateTime: '2026-09-01T00:00:00Z' }));
  assert.equal(pages[0].inventorySummaries[0].totalQuantity, 0);
  assert.equal(pages[0].granularity.granularityId, AMAZON_BR_MARKETPLACE_ID);
  assert.equal(calls[2].url.pathname, '/fba/inventory/v1/summaries');
  assert.equal(calls[2].url.searchParams.get('nextToken'), 'stock-cursor');
  assert.equal(calls[2].url.searchParams.get('startDateTime'), '2026-09-01T00:00:00Z');
  assert.equal(calls[2].url.searchParams.get('details'), 'true');
  assert.equal(calls[2].url.searchParams.get('granularityType'), 'Marketplace');
  assert.equal(calls[2].url.searchParams.get('marketplaceIds'), AMAZON_BR_MARKETPLACE_ID);
});

test('SKU and opaque token characters are encoded without changing parameter meaning', async () => {
  const { client, calls } = mockClient([lwa(), stock()]);
  await collect(client.getInventorySummaries({ sellerSku: 'a/b +ç,&=' }));
  assert.equal(calls[1].url.searchParams.get('sellerSku'), 'a/b +ç,&=');
  assert.equal(calls[1].url.searchParams.has('a/b'), false);
});

test('LWA token is cached, concurrent calls share refresh, and expiry refreshes once', async () => {
  let current = NOW;
  const { client, calls } = mockClient([lwa('first', 10), json({ order: {} }), json({ order: {} }), lwa('second', 10), json({ order: {} })], { now: () => current });
  await Promise.all([client.getOrder('order-1'), client.getOrder('order-2')]);
  assert.equal(calls.filter(call => call.url.hostname === 'api.amazon.com').length, 1);
  current += 9_001;
  await client.getOrder('order-3');
  assert.equal(calls.filter(call => call.url.hostname === 'api.amazon.com').length, 2);
  assert.equal(calls.at(-1).init.headers['x-amz-access-token'], 'second');
});

test('429 and 5xx retry with bounded Retry-After seconds and HTTP dates', async () => {
  const { client, calls, sleeps } = mockClient([
    lwa(), json({}, 429, { 'retry-after': '3' }),
    json({}, 503, { 'retry-after': new Date(NOW + 5_000).toUTCString() }), json({ order: {} }),
  ]);
  await client.getOrder('order-1');
  assert.deepEqual(sleeps, [3_000, 5_000]);
  assert.equal(calls.length, 4);
});

test('retry exhaustion and excessive Retry-After fail without an early retry', async () => {
  const retry = mockClient([lwa(), json({}, 503), json({}, 503)], { maxAttempts: 2 });
  await assert.rejects(retry.client.getOrder('order-1'), error => error.code === 'HTTP_ERROR' && error.status === 503);
  assert.equal(retry.calls.length, 3);
  assert.deepEqual(retry.sleeps, [1_000]);
  const long = mockClient([lwa(), json({}, 429, { 'retry-after': '180' })]);
  await assert.rejects(long.client.getOrder('order-1'), error => error.code === 'RATE_LIMITED' && error.retryAfterMs === 180_000);
  assert.equal(long.calls.length, 2);
  assert.deepEqual(long.sleeps, []);
});

test('nonretryable errors omit remote bodies, URLs and credential values', async () => {
  const { client, calls } = mockClient([lwa(), json({ error: `leak ${CREDS.clientSecret} https://unsafe.invalid?q=${CREDS.refreshToken}` }, 403, { 'x-amzn-requestid': 'req-error' })]);
  await assert.rejects(client.getOrder('order-1'), error => {
    assert.ok(error instanceof AmazonApiError);
    assert.equal(error.status, 403);
    assert.equal(error.operation, 'getOrder');
    assert.equal(error.requestId, 'req-error');
    const displayed = `${error.stack} ${JSON.stringify(error)}`;
    assert.equal(displayed.includes(CREDS.clientSecret), false);
    assert.equal(displayed.includes(CREDS.refreshToken), false);
    assert.equal(displayed.includes('unsafe.invalid'), false);
    assert.equal(displayed.includes('body'), false);
    return true;
  });
  assert.equal(calls.length, 2);
});

test('timeouts abort fetch and also bound response body reads', async () => {
  let signal;
  const stalledFetch = mockClient([(_url, init) => { signal = init.signal; return new Promise(() => {}); }], { timeoutMs: 10 });
  await assert.rejects(stalledFetch.client.getOrder('order-1'), { code: 'TIMEOUT', operation: 'lwaToken' });
  assert.equal(signal.aborted, true);
  const stalledBody = mockClient([lwa(), () => ({ ok: true, status: 200, headers: new Headers(), text: () => new Promise(() => {}) })], { timeoutMs: 10 });
  await assert.rejects(stalledBody.client.getOrder('order-1'), { code: 'TIMEOUT', operation: 'getOrder' });
});

test('pagination cycles and page caps fail explicitly, after yielding the last received page', async () => {
  const capped = mockClient([lwa(), json({ orders: [], pagination: { nextToken: 'next' } })], { maxPages: 1 });
  const iterator = capped.client.searchOrders(RANGE);
  assert.equal((await iterator.next()).value.nextToken, 'next');
  await assert.rejects(iterator.next(), { code: 'PAGINATION_LIMIT' });
  assert.equal(capped.calls.length, 2);
  const cycle = mockClient([lwa(), json({ orders: [], pagination: { nextToken: 'same' } }), json({ orders: [], pagination: { nextToken: 'same' } })]);
  await assert.rejects(collect(cycle.client.searchOrders(RANGE)), { code: 'PAGINATION_CYCLE' });
  assert.equal(cycle.calls.length, 3);
});

test('invalid/ambiguous filters and restricted datasets fail before any network call', async () => {
  const { client, calls } = mockClient([]);
  for (const params of [
    {}, { ...RANGE, lastUpdatedAfter: RANGE.createdAfter }, { ...RANGE, includedData: ['BUYER'] },
    { ...RANGE, includedData: ['PAYMENT'] }, { ...RANGE, nextToken: 'wrong-name' },
    { ...RANGE, maxResultsPerPage: 101 }, { ...RANGE, marketplaceIds: [] },
  ]) await assert.rejects(collect(client.searchOrders(params)), { code: 'INVALID_PARAMETERS' });
  await assert.rejects(client.getOrder('../orders'), { code: 'INVALID_PARAMETERS' });
  await assert.rejects(client.getOrder('order-1', { includedData: ['RECIPIENT'] }), { code: 'INVALID_PARAMETERS' });
  await assert.rejects(collect(client.listTransactions({ postedAfter: '2026-01-01T00:00:00Z', postedBefore: '2026-09-01T00:00:00Z' })), { code: 'INVALID_PARAMETERS' });
  await assert.rejects(collect(client.listTransactions({ relatedIdentifierName: 'ORDER_ID' })), { code: 'INVALID_PARAMETERS' });
  await assert.rejects(collect(client.getInventorySummaries({ marketplaceIds: ['one', 'two'] })), { code: 'INVALID_PARAMETERS' });
  await assert.rejects(collect(client.getInventorySummaries({ sellerSku: 'sku', startDateTime: RANGE.createdAfter })), { code: 'INVALID_PARAMETERS' });
  assert.equal(calls.length, 0);
});

test('malformed envelopes and unexpected customer data never become snapshots', async () => {
  const malformed = mockClient([lwa(), json({ payload: { orders: [] } })]);
  await assert.rejects(collect(malformed.client.searchOrders(RANGE)), { code: 'INVALID_RESPONSE' });
  const pii = mockClient([lwa(), json({ orders: [{ orderId: 'order-1', buyer: { buyerEmail: 'private@example.invalid' } }] })]);
  await assert.rejects(collect(pii.client.searchOrders(RANGE)), error => {
    assert.equal(error.code, 'UNEXPECTED_RESTRICTED_DATA');
    assert.equal(JSON.stringify(error).includes('private@example.invalid'), false);
    assert.equal(error.rawBody, undefined);
    return true;
  });
  const message = mockClient([lwa(), json({ order: { orderId: 'order-1', orderItems: [{ fulfillment: { packing: { giftOption: { giftMessage: 'private message' } } } }] } })]);
  await assert.rejects(message.client.getOrder('order-1'), { code: 'UNEXPECTED_RESTRICTED_DATA' });
});

test('network exceptions are sanitized and never retried accidentally', async () => {
  const { client, calls } = mockClient([() => { throw new Error(`Failed at URL with ${CREDS.clientSecret}`); }]);
  await assert.rejects(client.getOrder('order-1'), error => {
    assert.equal(error.code, 'NETWORK_ERROR');
    assert.equal(error.message.includes(CREDS.clientSecret), false);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(calls.length, 1);
});
