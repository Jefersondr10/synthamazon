import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startWebServer } from '../src/web/server.mjs';

function request(origin, route, { method = 'GET', headers = {}, body } = {}) {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: url.hostname, port: url.port, path: route, method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('produção exige identidade Google do proprietário e segredo do proxy, mantendo Origin e CSRF', async t => {
  const production = { origin: 'https://synthamazon.example.com', ownerEmail: 'owner@gmail.com', proxyPassword: 'p'.repeat(64) };
  const app = await fixture(t, {}, { production });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal(app.url, production.origin);
  const base = { host: 'synthamazon.example.com', 'x-forwarded-proto': 'https' };
  const valid = { ...base, 'x-forwarded-user': production.ownerEmail,
    authorization: `Basic ${Buffer.from(`${production.ownerEmail}:${production.proxyPassword}`).toString('base64')}` };
  for (const headers of [base, { ...base, 'x-forwarded-user': production.ownerEmail },
    { ...valid, 'x-forwarded-user': 'other@gmail.com' }, { ...valid, authorization: 'Basic Zm9vOmJhcg==' },
    { ...base, authorization: valid.authorization, 'x-forwarded-email': production.ownerEmail },
    { ...valid, 'x-forwarded-proto': 'http' }, { ...valid, host: 'evil.example.com' }]) {
    assert.equal((await request(origin, '/api/bootstrap', { headers })).status, 403);
    assert.equal((await request(origin, '/', { headers })).status, 403);
  }
  assert.equal((await request(origin, '/connect/anything', { headers: valid })).status, 403);
  const bootstrap = await request(origin, '/api/bootstrap', { headers: valid });
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.json.meta.accountEmail, production.ownerEmail);
  assert.equal(bootstrap.json.meta.localOnly, false);
  assert.equal(bootstrap.json.meta.accessExpiresAt, undefined);
  assert.ok(!bootstrap.text.includes(production.proxyPassword));
  const body = JSON.stringify({ storeId: 'test-store' });
  const post = { ...valid, origin: production.origin, 'content-type': 'application/json', 'x-csrf-token': bootstrap.json.meta.csrfToken };
  assert.equal((await request(origin, '/api/refund-management/sync', { method: 'POST', headers: { ...post, origin: 'https://evil.example.com' }, body })).status, 403);
  assert.equal((await request(origin, '/api/refund-management/sync', { method: 'POST', headers: { ...post, 'x-csrf-token': 'forged' }, body })).status, 403);
  assert.equal((await request(origin, '/api/refund-management/sync', { method: 'POST', headers: post, body })).status, 200);
  assert.deepEqual(app.calls.filter(row => row[0] === 'syncRefundManagement'), [['syncRefundManagement', { storeId: 'test-store' }]]);
  assert.equal((await request(origin, '/api/reload', { method: 'POST', headers: { ...post, 'x-csrf-token': 'forged' } })).status, 403);
  const refreshed = await request(origin, '/api/reload', { method: 'POST', headers: post });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.json.bootstrap.meta.accountEmail, production.ownerEmail);
  assert.equal(app.calls.some(row => row[0] === 'loadWorkspace'), false, 'Production refresh reads the collector database without reimporting snapshots on the HTTP process');
});

async function fixture(t, overrides = {}, serverOptions = {}) {
  const base = path.resolve(tmpdir());
  const rootDir = await mkdtemp(path.join(base, 'synthamazon-web-test-'));
  await mkdir(path.join(rootDir, 'public'));
  await writeFile(path.join(rootDir, 'public', 'inventory-planning.js'), 'export const fixture=true;');
  await writeFile(path.join(rootDir, 'public', 'product-sales.js'), 'export const fixture=true;');
  await writeFile(path.join(rootDir, 'public', 'product-sales.css'), '.sales{display:block}');
  for (const [name, content] of Object.entries({ 'index.html': '<!doctype html><h1>Mock UI</h1>', 'app.js': '"use strict";', 'list-data.js': 'export const fixture=true;', 'styles.css': 'body{color:black}', 'design.css': ':root{--accent:green}', 'favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>', 'refund-management.js':'export const fixture=true;', 'refund-management.css':'.fixture{display:block}' })) {
    await writeFile(path.join(rootDir, 'public', name), content);
  }
  const calls = [];
  const pending = { code: 'pending', label: 'Novo', color: 'neutral', menus: ['orders', 'refunds', 'charges', 'customer-returns', 'returns'], active: true, closesCase: false, version: 1, updatedAt: '2026-09-25T12:00:00.000Z' };
  const settings = { items: [pending], menus: pending.menus.map(code => ({ code, label: code })) };
  const review = { status: 'pending', label: 'Novo', color: 'neutral', closesCase: false, notes: '', version: 0, updatedAt: null };
  const repository = {
    getBootstrap: () => ({ stores: [{ storeId: 'test-store', name: 'Test Store' }], latestSync: null }),
    dashboard: filters => { calls.push(['dashboard', filters]); return { counts: { orders: 2 }, amountCents: 12n }; },
    dashboardTransactions: filters => { calls.push(['dashboardTransactions', filters]); return { items: [], total: 0, totals: [] }; },
    orders: filters => { calls.push(['orders', filters]); return { items: [], total: 0 }; },
    orderDetail: (storeId, orderId) => { calls.push(['orderDetail', storeId, orderId]); return orderId === 'missing' ? null : { storeId, orderId }; },
    inventory: filters => { calls.push(['inventory', filters]); return { items: [], total: 0 }; },
    productSales: filters => { calls.push(['productSales',filters]); return {views:[]}; },
    returns: filters => { calls.push(['returns', filters]); return { items: [], total: 0 }; },
    financialCases: (kind, filters) => { calls.push(['financialCases', kind, filters]); return { items: [], total: 0 }; },
    financialCaseDetail: (kind, storeId, caseId) => { calls.push(['financialCaseDetail', kind, storeId, caseId]); return caseId === 'missing' ? null : { kind, storeId, caseId }; },
    saveFinancialReview: input => { calls.push(['saveFinancialReview', input]); return { ...input, version: input.expectedVersion + 1 }; },
    saveFinancialReviews: input => {
      calls.push(['saveFinancialReviews', input]);
      return { updatedCount: input.items.length, unchangedCount: 0, reviews: input.items.map(item => ({
        storeId: item.storeId, caseId: item.caseId, review: { status: input.status, version: item.expectedVersion + 1 },
      })) };
    },
    customerReturns: (filters, returnId) => {
      calls.push(['customerReturns', filters, returnId]);
      return returnId === `return-${'f'.repeat(64)}` ? null : returnId ? { storeId: filters.storeId, returnId }
        : { items: [], total: 0, coverage: { state: 'missing', sources: [] } };
    },
    safeTCases: filters => { calls.push(['safeTCases', filters]); return { items: [], total: 0, eligibilityAssessed: false }; },
    refundManagement: filters => { calls.push(['refundManagement',filters]); return { items:[],total:0 }; },
    refundManagementDetail: (storeId,id) => { calls.push(['refundManagementDetail',storeId,id]); return { storeId,managementId:id }; },
    syncRefundManagement: input => { calls.push(['syncRefundManagement',input]); return { created:0,updated:0 }; },
    saveRefundManagement: input => { calls.push(['saveRefundManagement',input]); return { changed:input.items.length,items:[] }; },
    reviewStatusSettings: () => { calls.push(['reviewStatusSettings']); return settings; },
    saveReviewStatus: input => { calls.push(['saveReviewStatus', input]); return { status: { ...input, code: input.code ?? `custom_${'a'.repeat(32)}`, version: input.expectedVersion + 1 }, settings }; },
    localReview: input => { calls.push(['localReview', input]); return { ...input, review, reviewHistory: [], reviewStatuses: [pending] }; },
    saveLocalReview: input => { calls.push(['saveLocalReview', input]); return { ...review, status: input.status, notes: input.notes, version: input.expectedVersion + 1 }; },
    loadWorkspace: async () => { calls.push(['loadWorkspace']); return { imported: 2, skipped: 3, errors: [] }; },
    ...overrides,
  };
  const app = await startWebServer({ repository, rootDir, config: { historyStart: '2026-01-01', clientSecret: 'never-expose-config-value' }, ...serverOptions });
  t.after(async () => {
    await new Promise((resolve, reject) => app.server.close(error => error ? reject(error) : resolve()));
    // Only the directory allocated above can be removed by this fixture.
    assert.equal(path.dirname(path.resolve(rootDir)), base);
    assert.ok(path.basename(rootDir).startsWith('synthamazon-web-test-'));
    await rm(rootDir, { recursive: true, force: true });
  });
  const capability = new URL(app.url);
  const origin = capability.origin;
  const connect = async () => {
    const result = await request(origin, capability.pathname);
    const cookie = result.headers['set-cookie']?.[0]?.split(';')[0];
    return { ...result, cookie };
  };
  return { ...app, origin, capability, connect, calls, repository };
}

test('product sales stays authenticated and store scoped, rejecting unsupported filters', async t => {
  const app=await fixture(t,{}, {storeScope:'test-store'});
  for(const route of ['/api/product-sales','/product-sales.js','/product-sales.css']) assert.equal((await request(app.origin,route)).status,403);
  const {cookie}=await app.connect();const headers={cookie};
  for(const route of ['/product-sales.js','/product-sales.css']) assert.equal((await request(app.origin,route,{headers})).status,200);
  assert.equal((await request(app.origin,'/api/product-sales?storeId=all',{headers})).status,200);
  assert.deepEqual(app.calls.at(-1),['productSales',{storeId:'test-store'}]);
  assert.equal((await request(app.origin,'/api/product-sales?storeId=all&channels=FBA,DBA,MFN',{headers})).status,200);
  assert.deepEqual(app.calls.at(-1),['productSales',{storeId:'test-store',channels:'FBA,DBA,MFN'}]);
  assert.equal((await request(app.origin,'/api/product-sales?storeId=all&channels=FBA&from=2026-09-10&to=2026-09-12',{headers})).status,200);
  assert.deepEqual(app.calls.at(-1),['productSales',{storeId:'test-store',channels:'FBA',from:'2026-09-10',to:'2026-09-12'}]);
  const before=app.calls.length;
  for(const query of ['from=2026-09-10','to=2026-09-10','from=2026-09-12&to=2026-09-10','from=2026-02-30&to=2026-03-01','from=2026-09-10T00:00:00Z&to=2026-09-11'])
    assert.equal((await request(app.origin,`/api/product-sales?${query}`,{headers})).status,400);
  for(const channels of ['', 'FBA,FBA', 'UNKNOWN', 'FBA,DBA,MFN,ALL', 'FBA&channels=DBA'])
    assert.equal((await request(app.origin,`/api/product-sales?channels=${channels}`,{headers})).status,400);
  assert.equal((await request(app.origin,'/api/product-sales?storeId=other',{headers})).status,403);
  assert.equal((await request(app.origin,'/api/product-sales?mode=FBA',{headers})).status,400);
  assert.equal((await request(app.origin,'/api/product-sales?storeId=all&storeId=test-store',{headers})).status,400);
  assert.equal(app.calls.length,before);
});

test('inventory planning keeps authentication, validates forecast input and preserves store scope', async t => {
  const app = await fixture(t, {}, { storeScope: 'test-store' });
  assert.equal((await request(app.origin, '/inventory-planning.js')).status,403);
  assert.equal((await request(app.origin, '/api/inventory?forecast=true')).status,403);
  const { cookie } = await app.connect(); const headers = { cookie };
  assert.equal((await request(app.origin, '/inventory-planning.js', { headers })).status,200);
  assert.equal((await request(app.origin, '/api/inventory?storeId=all&forecast=true', { headers })).status,200);
  assert.deepEqual(app.calls.at(-1),['inventory',{storeId:'test-store',forecast:'true'}]);
  for (const value of ['false','1','anything']) assert.equal((await request(app.origin, `/api/inventory?forecast=${value}`, { headers })).status,400);
  assert.equal((await request(app.origin, '/api/orders?forecast=true', { headers })).status,400);
  const before = app.calls.length;
  assert.equal((await request(app.origin, '/api/inventory?storeId=other&forecast=true', { headers })).status,403);
  assert.equal(app.calls.length,before);
});

test('a scoped server rejects another store before any data read and pins all-store requests', async t => {
  const app = await fixture(t, {}, { storeScope: 'origem-comercio' });
  const { cookie } = await app.connect();
  const headers = { cookie };
  const before = app.calls.length;
  assert.equal((await request(app.origin, '/api/orders?storeId=hd-comercio', { headers })).status, 403);
  assert.equal((await request(app.origin, '/api/orders/702-1234567-1234567?storeId=hd-comercio', { headers })).status, 403);
  assert.equal(app.calls.length, before);
  assert.equal((await request(app.origin, '/api/orders?storeId=all', { headers })).status, 200);
  assert.deepEqual(app.calls.at(-1), ['orders', {storeId:'origem-comercio'}]);
});

test('HTTPS tunnel preserves authentication, Host, CSRF and expiry without exposing the network interface', async t => {
  const publicOrigin = 'https://test-link.trycloudflare.com';
  const expiresAt = Date.now() + 3_600_000;
  const app = await fixture(t, {}, { publicOrigin, expiresAt });
  const localOrigin = `http://127.0.0.1:${app.server.address().port}`;
  const baseHeaders = { host: new URL(publicOrigin).host, 'x-forwarded-proto': 'https' };
  const remote = (route, options = {}) => request(localOrigin, route, { ...options, headers: { ...baseHeaders, ...options.headers } });
  assert.equal(app.server.address().address, '127.0.0.1');
  assert.equal(app.origin, publicOrigin);
  assert.equal((await remote('/api/bootstrap')).status, 403);
  assert.equal((await remote(app.capability.pathname, { headers: { 'x-forwarded-proto': 'http' } })).status, 403);
  assert.equal((await remote(app.capability.pathname, { headers: { host: 'attacker.invalid' } })).status, 403);
  assert.equal((await remote(app.capability.pathname, { method: 'HEAD' })).status, 405);
  for (let preview = 0; preview < 3; preview++) {
    const landing = await remote(app.capability.pathname);
    assert.equal(landing.status, 200);
    assert.equal(landing.headers['set-cookie'], undefined);
    assert.match(landing.text, /Entrar no sistema/);
    assert.match(landing.text, /<form method="post">/);
    assert.equal(landing.text.includes('Test Store'), false);
    assert.equal(landing.headers['referrer-policy'], 'same-origin');
  }
  const login = { method: 'POST', headers: { origin: publicOrigin, 'content-type': 'application/x-www-form-urlencoded' }, body: 'confirm=enter' };
  for (const headers of [{ ...login.headers, origin: 'https://other.invalid' }, { ...login.headers, origin: '' }, { ...login.headers, 'content-type': 'application/json' }]) {
    assert.equal((await remote(app.capability.pathname, { ...login, headers })).status, 403);
  }
  assert.equal((await remote(app.capability.pathname, { ...login, body: 'confirm=wrong' })).status, 403);
  assert.equal((await remote(app.capability.pathname, { ...login, body: 'x'.repeat(129) })).status, 403);
  const connected = await remote(app.capability.pathname, login);
  assert.equal(connected.status, 303);
  assert.match(connected.headers['set-cookie'][0], /HttpOnly; SameSite=Strict; Secure; Max-Age=\d+/);
  assert.equal(connected.headers['referrer-policy'], 'no-referrer');
  assert.equal(connected.headers['x-robots-tag'], 'noindex, nofollow, noarchive');
  const cookie = connected.headers['set-cookie'][0].split(';')[0];
  assert.equal((await remote(app.capability.pathname)).status, 403);
  assert.equal((await remote(app.capability.pathname, login)).status, 403);
  assert.match((await remote(app.capability.pathname)).text, /já foi ativado em outro navegador/);
  assert.match((await remote('/')).text, /Abra o link de acesso completo/);
  assert.equal((await remote('/', { headers: { cookie } })).status, 200);
  const bootstrap = await remote('/api/bootstrap', { headers: { cookie } });
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.json.meta.localOnly, false);
  assert.equal(bootstrap.json.meta.accessExpiresAt, new Date(expiresAt).toISOString());
  const good = { cookie, origin: publicOrigin, 'x-csrf-token': bootstrap.json.meta.csrfToken };
  assert.equal((await remote('/api/reload', { method: 'POST', headers: { ...good, origin: localOrigin } })).status, 403);
  assert.equal((await remote('/api/reload', { method: 'POST', headers: { ...good, 'x-csrf-token': 'wrong' } })).status, 403);
  assert.equal((await remote('/api/reload', { method: 'POST', headers: good })).status, 200);
  assert.equal((await remote('/data/synthamazon.sqlite', { headers: { cookie } })).status, 404);
  t.mock.timers.enable({ apis: ['Date'], now: expiresAt + 1 });
  assert.equal((await remote('/api/bootstrap', { headers: { cookie } })).status, 403);
  assert.equal((await remote(app.capability.pathname, { headers: { cookie } })).status, 403);
});

test('concurrent remote confirmations cannot consume the same invitation twice', async t => {
  const publicOrigin = 'https://test-link.trycloudflare.com';
  const app = await fixture(t, {}, { publicOrigin, expiresAt: Date.now() + 3_600_000 });
  const localOrigin = `http://127.0.0.1:${app.server.address().port}`;
  const login = { method: 'POST', headers: { host: new URL(publicOrigin).host, 'x-forwarded-proto': 'https', origin: publicOrigin, 'content-type': 'application/x-www-form-urlencoded' }, body: 'confirm=enter' };
  const results = await Promise.all([request(localOrigin, app.capability.pathname, login), request(localOrigin, app.capability.pathname, login)]);
  assert.deepEqual(results.map(result => result.status).sort(), [303, 403]);
  assert.equal(results.filter(result => result.headers['set-cookie']).length, 1);
});

test('binds only loopback on an ephemeral port and authenticates through a single-use capability', async t => {
  const app = await fixture(t);
  assert.equal(app.server.address().address, '127.0.0.1');
  assert.ok(app.server.address().port > 0);
  assert.match(app.capability.pathname, /^\/connect\/[A-Za-z0-9_-]{43}$/);
  for (const route of ['/', '/app.js', '/api/bootstrap', '/api/dashboard/transactions', '/api/orders', '/api/inventory', '/api/returns', '/api/refunds', '/api/charges', '/api/reviews', '/api/reviews/bulk', '/api/settings/statuses', '/api/local-reviews', '/api/customer-returns', `/api/customer-returns/return-${'a'.repeat(64)}?storeId=test-store`]) {
    assert.equal((await request(app.origin, route)).status, 403);
  }
  const connected = await app.connect();
  assert.equal(connected.status, 303);
  assert.equal(connected.headers.location, '/');
  assert.match(connected.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
  assert.equal(connected.headers['referrer-policy'], 'no-referrer');
  const csp = connected.headers['content-security-policy'];
  assert.equal(csp.split(';').map(part => part.trim()).find(part => part.startsWith('form-action ')),
    "form-action 'self'");
  assert.match(csp, /connect-src 'self';/);
  assert.equal((await app.connect()).status, 403, 'The capability cannot create a second independent session');
  assert.equal((await request(app.origin, app.capability.pathname, { headers: { cookie: connected.cookie } })).status, 303);
  const bootstrap = await request(app.origin, '/api/bootstrap', { headers: { cookie: connected.cookie } });
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.json.meta.appName, 'SynthAmazon');
  assert.equal(bootstrap.json.meta.reloadLabel, 'Recarregar dados locais');
  assert.equal(bootstrap.json.meta.historyStart, '2026-01-01');
  assert.match(bootstrap.json.meta.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(bootstrap.text.includes('never-expose-config-value'), false);
});

test('requires exact Host and keeps sessions isolated across server instances', async t => {
  const first = await fixture(t);
  const second = await fixture(t);
  const a = await first.connect();
  const b = await second.connect();
  assert.notEqual(a.cookie.split('=')[0], b.cookie.split('=')[0]);
  assert.equal((await request(first.origin, '/api/bootstrap', { headers: { cookie: b.cookie } })).status, 403);
  assert.equal((await request(first.origin, '/api/bootstrap', { headers: { cookie: a.cookie, host: `localhost:${first.server.address().port}` } })).status, 403);
  assert.equal((await request(first.origin, '/api/bootstrap', { headers: { cookie: a.cookie, host: 'attacker.invalid' } })).status, 403);
  assert.equal((await request(first.origin, '/api/bootstrap', { headers: { cookie: `${a.cookie}; ${a.cookie}` } })).status, 403);
});

test('GET API routes preserve validated filters and serialize monetary integers safely', async t => {
  const app = await fixture(t);
  const { cookie } = await app.connect();
  const query = '?storeId=test-store&from=2026-01-01&to=2026-01-31&query=SKU%20%2B%20%C3%A7&mode=MFN&status=all&limit=25&offset=50';
  const result = await request(app.origin, `/api/dashboard${query}`, { headers: { cookie } });
  assert.equal(result.status, 200);
  assert.equal(result.json.amountCents, '12');
  assert.deepEqual(app.calls[0], ['dashboard', { storeId: 'test-store', from: '2026-01-01', to: '2026-01-31', query: 'SKU + ç', mode: 'MFN', status: 'all', limit: 25, offset: 50 }]);
  assert.equal((await request(app.origin, '/api/orders?storeId=all', { headers: { cookie } })).status, 200);
  assert.equal((await request(app.origin, '/api/inventory?query=produto', { headers: { cookie } })).status, 200);
  assert.deepEqual(app.calls.slice(1), [['orders', { storeId: 'all' }], ['inventory', { query: 'produto' }]]);
});

test('invalid, duplicate and unknown filters fail before the repository is called', async t => {
  const app = await fixture(t);
  const { cookie } = await app.connect();
  for (const query of ['?limit=501', '?offset=-1', '?limit=2&limit=3', '?buyerEmail=private', '?from=2026-02-31', '?from=2026-03-01&to=2026-01-01', '?mode=arbitrary', '?storeId=../secret', '?query=%00', '?query=' + 'a'.repeat(201)]) {
    const result = await request(app.origin, '/api/orders' + query, { headers: { cookie } });
    assert.equal(result.status, 400);
    assert.deepEqual(result.json.error, { code: 'BAD_REQUEST', message: 'Pedido inválido.' });
  }
  assert.equal(app.calls.length, 0);
});

test('returns require authenticated read access and allow only return filters', async t => {
  const app = await fixture(t);
  const { cookie } = await app.connect();
  const headers = { cookie };
  assert.equal((await request(app.origin, '/api/returns?storeId=test-store&status=without_refund&query=order&limit=25', { headers })).status, 200);
  assert.deepEqual(app.calls[0], ['returns', { storeId: 'test-store', status: 'without_refund', query: 'order', limit: 25 }]);
  assert.equal((await request(app.origin, '/api/returns?status=cancelled', { headers })).status, 400);
  assert.equal((await request(app.origin, '/api/returns?mode=FBA', { headers })).status, 400);
});

test('order detail requires one store and responds with 404 for an unknown order', async t => {
  const app = await fixture(t);
  const { cookie } = await app.connect();
  assert.equal((await request(app.origin, '/api/orders/order-1', { headers: { cookie } })).status, 400);
  assert.equal((await request(app.origin, '/api/orders/order-1?storeId=all', { headers: { cookie } })).status, 400);
  const result = await request(app.origin, '/api/orders/order-1?storeId=test-store', { headers: { cookie } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, { storeId: 'test-store', orderId: 'order-1' });
  assert.equal((await request(app.origin, '/api/orders/missing?storeId=test-store', { headers: { cookie } })).status, 404);
  assert.deepEqual(app.calls[0], ['orderDetail', 'test-store', 'order-1']);
});

test('local reload requires cookie, exact Origin and CSRF token; never echoes import error details', async t => {
  let reloadCalls = 0;
  const app = await fixture(t, { loadWorkspace: async () => { reloadCalls++; return { imported: 2, skipped: 1, errors: [{ privatePath: 'never-expose-import-path' }] }; } });
  const { cookie } = await app.connect();
  const bootstrap = await request(app.origin, '/api/bootstrap', { headers: { cookie } });
  const csrf = bootstrap.json.meta.csrfToken;
  for (const headers of [{}, { cookie }, { cookie, origin: app.origin }, { cookie, origin: 'https://attacker.invalid', 'x-csrf-token': csrf }, { cookie, origin: app.origin, 'x-csrf-token': 'wrong' }]) {
    assert.equal((await request(app.origin, '/api/reload', { method: 'POST', headers })).status, 403);
  }
  assert.equal(reloadCalls, 0);
  const correct = { cookie, origin: app.origin, 'x-csrf-token': csrf };
  assert.equal((await request(app.origin, '/api/reload', { method: 'POST', headers: { ...correct, 'content-length': '2' }, body: '{}' })).status, 400);
  const result = await request(app.origin, '/api/reload', { method: 'POST', headers: correct });
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, false);
  assert.deepEqual(result.json.reload, { imported: 2, skipped: 1, errorCount: 1 });
  assert.equal(result.json.bootstrap.meta.csrfToken, csrf);
  assert.equal(result.text.includes('never-expose-import-path'), false);
  assert.equal(reloadCalls, 1);
});

test('reload concurrency is bounded and method mutations are denied elsewhere', async t => {
  let finish;
  let markEntered;
  const entered = new Promise(resolve => { markEntered = resolve; });
  const app = await fixture(t, { loadWorkspace: () => { markEntered(); return new Promise(resolve => { finish = resolve; }); } });
  const { cookie } = await app.connect();
  const bootstrap = await request(app.origin, '/api/bootstrap', { headers: { cookie } });
  const options = { method: 'POST', headers: { cookie, origin: app.origin, 'x-csrf-token': bootstrap.json.meta.csrfToken } };
  const pending = request(app.origin, '/api/reload', options);
  await entered;
  assert.equal((await request(app.origin, '/api/reload', options)).status, 409);
  finish({ imported: 0, skipped: 0, errors: [] });
  assert.equal((await pending).status, 200);
  assert.equal((await request(app.origin, '/api/orders', options)).status, 405);
  assert.equal((await request(app.origin, '/api/reload', { headers: { cookie } })).status, 405);
});

test('serves only whitelisted assets, without traversal or raw snapshot routes', async t => {
  const app = await fixture(t);
  const { cookie } = await app.connect();
  for (const [route, mime] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/list-data.js', 'text/javascript'], ['/styles.css', 'text/css'], ['/design.css', 'text/css'], ['/favicon.svg', 'image/svg+xml']]) {
    const result = await request(app.origin, route, { headers: { cookie } });
    assert.equal(result.status, 200);
    assert.ok(result.headers['content-type'].startsWith(mime));
    assert.equal(result.headers['x-content-type-options'], 'nosniff');
  }
  for (const route of ['/../index.html', '/%2e%2e/index.html', '/x/../app.js', '/%5c..%5capp.js', '/public/index.html', '/data/orders.json', '/credentials/private.json', '/api/private', '/app.js?path=other']) {
    assert.equal((await request(app.origin, route, { headers: { cookie } })).status, 404, route);
  }
});

test('response policies prevent cross-origin reads and API caching', async t => {
  const app = await fixture(t);
  const { cookie } = await app.connect();
  const result = await request(app.origin, '/api/dashboard', { headers: { cookie } });
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['referrer-policy'], 'same-origin');
  assert.equal(result.headers['access-control-allow-origin'], undefined);
  assert.ok(result.headers['content-security-policy'].includes("script-src 'self'"));
  assert.ok(result.headers['content-security-policy'].includes("style-src 'self'"));
  assert.equal(result.headers['content-security-policy'].includes('unsafe-inline'), false);
  assert.equal((await request(app.origin, '/api/dashboard', { headers: { cookie, origin: 'http://127.0.0.1:1' } })).status, 403);
});

test('repository exceptions return fixed safe messages without underlying details', async t => {
  const app = await fixture(t, { dashboard: () => { throw new Error('never-expose-private-value'); }, orders: () => { throw new TypeError('never-expose-filter'); } });
  const { cookie } = await app.connect();
  for (const [route, status, code] of [['/api/dashboard', 500, 'INTERNAL_ERROR'], ['/api/orders', 400, 'BAD_REQUEST']]) {
    const result = await request(app.origin, route, { headers: { cookie } });
    assert.equal(result.status, status);
    assert.equal(result.json.error.code, code);
    assert.equal(result.text.includes('never-expose'), false);
    assert.equal(Object.hasOwn(result.json.error, 'stack'), false);
  }
});

test('refunds and charges stay separate and validate review filters and case identities', async t => {
  const app = await fixture(t), { cookie } = await app.connect();
  const headers = { cookie };
  const refund = await request(app.origin, '/api/refunds?storeId=test-store&from=2026-09-01&to=2026-09-25&status=request_safe_t&query=SKU&limit=10', { headers });
  assert.equal(refund.status, 200);
  assert.deepEqual(app.calls[0], ['financialCases', 'refunds', { storeId: 'test-store', from: '2026-09-01', to: '2026-09-25', status: 'request_safe_t', query: 'SKU', limit: 10 }]);
  assert.equal((await request(app.origin, '/api/charges?type=ServiceFee&status=pending', { headers })).status, 200);
  assert.deepEqual(app.calls[1], ['financialCases', 'charges', { type: 'ServiceFee', status: 'pending' }]);
  assert.equal((await request(app.origin, '/api/refunds/case_one?storeId=test-store', { headers })).status, 200);
  assert.deepEqual(app.calls[2], ['financialCaseDetail', 'refunds', 'test-store', 'case_one']);
  assert.equal((await request(app.origin, '/api/charges/missing?storeId=test-store', { headers })).status, 404);
  for (const route of ['/api/refunds?mode=FBA', '/api/refunds?status=cancelled', '/api/refunds?type=%00', '/api/refunds?type=x&type=y', '/api/refunds/case?storeId=all', '/api/refunds/case/extra?storeId=test-store']) {
    assert.equal((await request(app.origin, route, { headers })).status, 400, route);
  }
  assert.equal((await request(app.origin, '/api/charges?status=request_safe_t', { headers })).status, 200, 'Catalogue assignments are validated by the domain, not hardcoded by the route');
});

test('reimbursement filters are restricted to refunds and preserve their exact scope', async t => {
  const app = await fixture(t), { cookie } = await app.connect();
  const headers = { cookie };
  for (const reimbursement of ['all', 'identified', 'unidentified', 'safe_t', 'easy_ship']) {
    assert.equal((await request(app.origin, `/api/refunds?storeId=test-store&reimbursement=${reimbursement}&status=in_review`, { headers })).status, 200);
    assert.deepEqual(app.calls.at(-1), ['financialCases', 'refunds', { storeId: 'test-store', reimbursement, status: 'in_review' }]);
  }
  const count = app.calls.length;
  for (const route of ['/api/charges?reimbursement=identified', '/api/charges?reimbursement=all', '/api/refunds?reimbursement=paid', '/api/refunds?reimbursement=', '/api/refunds?reimbursement=safe_t&reimbursement=easy_ship', '/api/orders?reimbursement=identified']) {
    assert.equal((await request(app.origin, route, { headers })).status, 400);
  }
  assert.equal(app.calls.length, count, 'Invalid filters never reach the repository');
});

test('order net filter is validated and remains scoped to the orders route', async t => {
  const app = await fixture(t), { cookie } = await app.connect();
  const headers = { cookie };
  for (const net of ['all', 'positive', 'receivable']) {
    assert.equal((await request(app.origin, `/api/orders?storeId=test-store&net=${net}&limit=20&offset=20`, { headers })).status, 200);
    assert.deepEqual(app.calls.at(-1), ['orders', { storeId: 'test-store', net, limit: 20, offset: 20 }]);
  }
  const count = app.calls.length;
  for (const route of ['/api/orders?net=', '/api/orders?net=invalid', '/api/orders?net=positive&net=receivable', '/api/dashboard?net=positive', '/api/refunds?net=positive', '/api/returns?net=positive']) {
    assert.equal((await request(app.origin, route, { headers })).status, 400, route);
  }
  assert.equal(app.calls.length, count);
});

test('multiple status and reimbursement filters preserve union selections only on their intended routes', async t => {
  const app = await fixture(t), { cookie } = await app.connect();
  const headers = { cookie };
  assert.equal((await request(app.origin, '/api/orders?storeId=test-store&status=CANCELLED,DELIVERED&limit=1&offset=1', { headers })).status, 200);
  assert.deepEqual(app.calls.at(-1), ['orders', { storeId: 'test-store', status: 'CANCELLED,DELIVERED', limit: 1, offset: 1 }]);
  assert.equal((await request(app.origin, '/api/refunds?reimbursement=safe_t,unidentified&status=in_review', { headers })).status, 200);
  assert.deepEqual(app.calls.at(-1), ['financialCases', 'refunds', { reimbursement: 'safe_t,unidentified', status: 'in_review' }]);
  assert.equal((await request(app.origin, '/api/refunds?reimbursement=identified,unidentified,safe_t,easy_ship', { headers })).status, 200);
  const count = app.calls.length;
  const invalid = ['/api/orders?status=', '/api/orders?status=CANCELLED,', '/api/orders?status=,CANCELLED',
    '/api/orders?status=CANCELLED,,DELIVERED', '/api/orders?status=all,CANCELLED', '/api/orders?status=ALL,CANCELLED',
    '/api/orders?status=CANCELLED,cancelled', '/api/orders?status=CANCELLED,%20DELIVERED',
    '/api/refunds?status=pending,resolved', '/api/dashboard?status=CANCELLED,DELIVERED', '/api/returns?status=all,refunded',
    '/api/refunds?reimbursement=all,safe_t', '/api/refunds?reimbursement=safe_t,safe_t', '/api/refunds?reimbursement=safe_t,',
    '/api/refunds?reimbursement=safe_t,invalid', '/api/charges?reimbursement=safe_t,unidentified',
    `/api/orders?status=${Array.from({ length: 51 }, (_, index) => `CODE_${'A'.repeat(index + 1)}`).join(',')}`];
  for (const route of invalid) assert.equal((await request(app.origin, route, { headers })).status, 400, route);
  assert.equal(app.calls.length, count, 'Malformed selections never reach the repository');
});

test('local review writes require exact Origin and CSRF with a bounded validated JSON body', async t => {
  const app = await fixture(t), { cookie } = await app.connect();
  const bootstrap = await request(app.origin, '/api/bootstrap', { headers: { cookie } });
  const good = { cookie, origin: app.origin, 'x-csrf-token': bootstrap.json.meta.csrfToken, 'content-type': 'application/json' };
  const input = { kind: 'refunds', storeId: 'test-store', caseId: 'case_one', status: 'in_review', notes: 'Conferir lançamento\nObservação interna.', expectedVersion: 0 };
  const body = JSON.stringify(input);
  for (const headers of [{ cookie }, { ...good, origin: 'http://attacker.invalid' }, { ...good, 'x-csrf-token': 'wrong' }]) {
    assert.equal((await request(app.origin, '/api/reviews', { method: 'POST', headers, body })).status, 403);
  }
  assert.equal(app.calls.length, 0);
  for (const value of [{ ...input, notes: 'x'.repeat(2001) }, { ...input, kind: 'orders' }, { ...input, storeId: 'all' }, { ...input, expectedVersion: -1 }, { ...input, expectedVersion: undefined }, { ...input, unexpected: true }, null, []]) {
    assert.equal((await request(app.origin, '/api/reviews', { method: 'POST', headers: good, body: JSON.stringify(value) })).status, 400);
  }
  assert.equal((await request(app.origin, '/api/reviews', { method: 'POST', headers: good, body: '{' })).status, 400);
  assert.equal((await request(app.origin, '/api/reviews', { method: 'POST', headers: { ...good, 'content-type': 'text/plain' }, body })).status, 400);
  assert.equal((await request(app.origin, '/api/reviews', { method: 'POST', headers: good, body: JSON.stringify({ ...input, notes: 'x'.repeat(17000) }) })).status, 400);
  assert.equal(app.calls.length, 0);
  const saved = await request(app.origin, '/api/reviews', { method: 'POST', headers: good, body });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.review.version, 1);
  assert.deepEqual(app.calls, [['saveFinancialReview', input]]);
  assert.equal((await request(app.origin, '/api/reviews', { method: 'GET', headers: { cookie } })).status, 405);
});

test('review conflicts and missing cases remain explicit without leaking internal errors', async t => {
  let code = 'REVIEW_CONFLICT';
  const app = await fixture(t, { saveFinancialReview() { throw Object.assign(new Error('PRIVATE DATABASE DETAIL'), { code }); } });
  const { cookie } = await app.connect();
  const bootstrap = await request(app.origin, '/api/bootstrap', { headers: { cookie } });
  const headers = { cookie, origin: app.origin, 'x-csrf-token': bootstrap.json.meta.csrfToken, 'content-type': 'application/json' };
  const body = JSON.stringify({ kind: 'charges', storeId: 'test-store', caseId: 'case_one', status: 'resolved', notes: '', expectedVersion: 1 });
  for (const [errorCode, status] of [['REVIEW_CONFLICT', 409], ['CASE_NOT_FOUND', 404], ['INVALID_REVIEW', 400], ['UNKNOWN_FAILURE', 500]]) {
    code = errorCode;
    const result = await request(app.origin, '/api/reviews', { method: 'POST', headers, body });
    assert.equal(result.status, status);
    assert.equal(result.text.includes('PRIVATE'), false);
  }
});

const refundCaseId = value => `refunds-${Number(value).toString(16).padStart(64, '0')}`;
const returnId = value => `return-${Number(value).toString(16).padStart(64, '0')}`;
function bulkInput(extra = {}) {
  return { kind: 'refunds', status: 'in_review', items: [
    { storeId: 'test-store', caseId: refundCaseId(1), expectedVersion: 0 },
    { storeId: 'test-store', caseId: refundCaseId(2), expectedVersion: 7 },
  ], ...extra };
}
async function writeSession(app) {
  const { cookie } = await app.connect();
  const bootstrap = await request(app.origin, '/api/bootstrap', { headers: { cookie } });
  return { cookie, origin: app.origin, 'x-csrf-token': bootstrap.json.meta.csrfToken, 'content-type': 'application/json' };
}

const managementId = `management-${'a'.repeat(64)}`;
const managementInput = (extra = {}) => ({ action:'edit',items:[{storeId:'test-store',managementId,expectedVersion:0}],status:'in_review',...extra });

test('refund management filters and details are authenticated reads and do not trigger synchronization', async t => {
  const app = await fixture(t), headers = await writeSession(app);
  assert.equal((await request(app.origin,'/api/refund-management')).status,403);
  const route = '/api/refund-management?storeId=test-store&workflow=active&payment=pending&returnFilter=withReturn&deadline=upcoming&mode=DBA&status=none&limit=20&offset=40';
  assert.equal((await request(app.origin,route,{headers})).status,200);
  assert.deepEqual(app.calls.at(-1),['refundManagement',{storeId:'test-store',workflow:'active',payment:'pending',returnFilter:'withReturn',deadline:'upcoming',mode:'DBA',status:'none',limit:20,offset:40}]);
  assert.equal((await request(app.origin,`/api/refund-management/${managementId}?storeId=test-store`,{headers})).status,200);
  assert.deepEqual(app.calls.at(-1),['refundManagementDetail','test-store',managementId]);
  assert.ok(!app.calls.some(call => call[0] === 'syncRefundManagement'));
  for (const suffix of ['workflow=closed','payment=bank','deadline=amazon','returnFilter=true','limit=501','workflow=all&workflow=active']) {
    assert.equal((await request(app.origin,`/api/refund-management?${suffix}`,{headers})).status,400);
  }
  assert.equal((await request(app.origin,`/api/refund-management/${managementId}?storeId=all`,{headers})).status,400);
  for (const asset of ['/refund-management.js','/refund-management.css']) assert.equal((await request(app.origin,asset,{headers})).status,200);
});

test('refund management order status selections remain separate from manual status and read without synchronization', async t => {
  const app = await fixture(t), { cookie } = await app.connect(), headers = { cookie };
  const filters = {
    storeId: 'test-store', query: 'SKU azul', mode: 'DBA', workflow: 'active', payment: 'pending',
    status: 'in_review', orderStatus: 'CANCELLED,DELIVERED', limit: '20', offset: '40',
  };
  assert.equal((await request(app.origin, `/api/refund-management?${new URLSearchParams(filters)}`, { headers })).status, 200);
  assert.deepEqual(app.calls.at(-1), ['refundManagement', { ...filters, limit: 20, offset: 40 }]);

  const fiftyCodes = Array.from({ length: 50 }, (_, index) =>
    `CODE_${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + index % 26)}`).join(',');
  for (const orderStatus of ['all', 'PICKED_UP', 'FUTURE_STATUS', 'null', 'undefined', fiftyCodes]) {
    assert.equal((await request(app.origin, `/api/refund-management?${new URLSearchParams({ orderStatus })}`, { headers })).status, 200);
    assert.deepEqual(app.calls.at(-1), ['refundManagement', { orderStatus }]);
  }
  assert.ok(app.calls.every(call => call[0] === 'refundManagement'), 'Filtering is read-only and cannot synchronize or save a case');
});

test('refund management rejects malformed operational selections without expanding manual status or other routes', async t => {
  const app = await fixture(t), { cookie } = await app.connect(), headers = { cookie };
  const fiftyOneCodes = Array.from({ length: 51 }, (_, index) =>
    `CODE_${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + index % 26)}`).join(',');
  const invalidValues = ['', ',DELIVERED', 'DELIVERED,', 'DELIVERED,,CANCELLED', 'DELIVERED,delivered',
    'all,DELIVERED', 'ALL,DELIVERED', 'DELIVERED, DELIVERED', ' DELIVERED', 'DELIVERED ',
    '[DELIVERED]', '{"code":"DELIVERED"}', 'DELIVERED\t', 'NEW_STATUS_2',
    'A'.repeat(51), fiftyOneCodes];
  for (const orderStatus of invalidValues) {
    const route = `/api/refund-management?${new URLSearchParams({ orderStatus })}`;
    const response = await request(app.origin, route, { headers });
    assert.equal(response.status, 400, route);
    assert.deepEqual(response.json.error, { code: 'BAD_REQUEST', message: 'Pedido inválido.' });
  }
  for (const query of ['orderStatus=DELIVERED&orderStatus=CANCELLED',
    'orderStatus=DELIVERED&status=in_review,rm_concluded', 'orderStatus=DELIVERED&status=all,in_review']) {
    assert.equal((await request(app.origin, `/api/refund-management?${query}`, { headers })).status, 400, query);
  }
  for (const route of ['/api/orders', '/api/dashboard', '/api/inventory', '/api/returns', '/api/customer-returns',
    '/api/refunds', '/api/charges', '/api/safe-t', `/api/refund-management/${managementId}?storeId=test-store&`]) {
    const target = route.includes('?') ? `${route}orderStatus=DELIVERED` : `${route}?orderStatus=DELIVERED`;
    assert.equal((await request(app.origin, target, { headers })).status, 400, target);
  }
  assert.equal(app.calls.length, 0, 'Invalid selections must never reach any repository method');
});

test('refund management sync and mutations require exact session Origin and CSRF and cannot send financial fields', async t => {
  const app = await fixture(t), headers = await writeSession(app);
  for (const route of ['/api/refund-management','/api/refund-management/sync']) {
    const body = JSON.stringify(route.endsWith('sync') ? {storeId:'test-store'} : managementInput());
    for (const bad of [{},{cookie:headers.cookie},{...headers,origin:'https://other.invalid'},{...headers,'x-csrf-token':'wrong'}]) {
      assert.equal((await request(app.origin,route,{method:'POST',headers:bad,body})).status,403);
    }
  }
  assert.equal(app.calls.length,0);
  assert.equal((await request(app.origin,'/api/refund-management/sync',{method:'POST',headers,body:'{"storeId":"test-store"}'})).status,200);
  assert.deepEqual(app.calls.at(-1),['syncRefundManagement',{storeId:'test-store'}]);
  const before = app.calls.length;
  const invalid = [managementInput({totalCents:'100'}),managementInput({action:'send-amazon'}),managementInput({items:[]}),
    managementInput({items:[{storeId:'test-store',managementId,expectedVersion:'0'}]}),
    managementInput({action:'finalize',acknowledgePaymentVariance:'true'}),managementInput({shortNote:'x'.repeat(501)}),
    managementInput({action:'bulk-edit',caseId:'123'}),managementInput({items:Array(101).fill(managementInput().items[0])})];
  for (const value of invalid) assert.equal((await request(app.origin,'/api/refund-management',{method:'POST',headers,body:JSON.stringify(value)})).status,400);
  assert.equal(app.calls.length,before);
  const input = managementInput({caseId:'Caso 123-456',note:'Conferir comprovante.'});
  assert.equal((await request(app.origin,'/api/refund-management',{method:'POST',headers,body:JSON.stringify(input)})).status,200);
  assert.equal(app.calls.at(-1)[1].caseId,'123456');
});

test('management workflow validation conflicts retain safe actionable codes and new status settings stay scoped', async t => {
  let code = 'PAYMENT_VARIANCE_REQUIRED';
  const app = await fixture(t,{saveRefundManagement:()=>{throw Object.assign(new Error('private financial details'),{code});}});
  const headers = await writeSession(app), body = JSON.stringify(managementInput());
  for (const expected of ['PAYMENT_VARIANCE_REQUIRED','FINALIZATION_REASON_REQUIRED','FINALIZATION_STATUS_REQUIRED','REVIEW_CONFLICT','WORKFLOW_CONFLICT']) {
    code=expected;
    const result=await request(app.origin,'/api/refund-management',{method:'POST',headers,body});
    assert.equal(result.status,409); assert.equal(result.json.error.code,expected); assert.ok(!result.text.includes('private'));
  }
  code='CASE_NOT_FOUND'; assert.equal((await request(app.origin,'/api/refund-management',{method:'POST',headers,body})).status,404);
  code='INVALID_MANAGEMENT'; assert.equal((await request(app.origin,'/api/refund-management',{method:'POST',headers,body})).status,400);
  const status={code:'rm_concluded',label:'Concluído',color:'#059669',menus:['refund-management'],active:true,closesCase:false,expectedVersion:1};
  assert.equal((await request(app.origin,'/api/settings/statuses',{method:'POST',headers,body:JSON.stringify(status)})).status,200);
  assert.equal((await request(app.origin,'/api/local-reviews',{method:'POST',headers,body:JSON.stringify({menu:'orders',storeId:'test-store',entityId:'order-a',status:'rm_concluded',notes:'',expectedVersion:0})})).status,400);
});

test('bulk review writes require session, exact Origin and CSRF before any case reaches the repository', async t => {
  const app = await fixture(t), good = await writeSession(app), body = JSON.stringify(bulkInput());
  const invalidHeaders = [
    {}, { cookie: good.cookie }, { ...good, cookie: '' }, { ...good, origin: '' },
    { ...good, origin: 'https://attacker.invalid' }, { ...good, origin: `${app.origin}/` },
    { ...good, 'x-csrf-token': '' }, { ...good, 'x-csrf-token': 'wrong' },
  ];
  for (const headers of invalidHeaders) {
    assert.equal((await request(app.origin, '/api/reviews/bulk', { method: 'POST', headers, body })).status, 403);
  }
  assert.equal(app.calls.length, 0);
  assert.equal((await request(app.origin, '/api/reviews/bulk', { headers: { cookie: good.cookie } })).status, 405);
  assert.equal((await request(app.origin, '/api/reviews/bulk?status=resolved', { method: 'POST', headers: good, body })).status, 400);
  assert.equal(app.calls.length, 0);
});

test('bulk reviews validate bounds, identities, versions and forbid overwriting notes or finance in the request', async t => {
  const app = await fixture(t), headers = await writeSession(app), base = bulkInput(), first = base.items[0];
  const malformed = [null, [], { ...base, kind: 'charges' }, { ...base, status: 'all' }, { ...base, status: 'pending,resolved' },
    { ...base, items: [] }, { ...base, items: {} }, { ...base, items: null },
    { ...base, items: Array.from({ length: 101 }, (_, i) => ({ ...first, caseId: refundCaseId(i) })) },
    { ...base, items: [first, { ...first }] }, { ...base, notes: 'Do not replace individual notes' },
    { ...base, totalCents: '-100' }, { ...base, items: [{ ...first, notes: 'Forbidden' }] },
    { ...base, items: [{ ...first, storeId: 'all' }] }, { ...base, items: [{ ...first, storeId: '../other' }] },
    { ...base, items: [{ ...first, storeId: ['test-store'] }] }, { ...base, items: [{ ...first, storeId: 1 }] },
    { ...base, items: [{ ...first, caseId: [refundCaseId(1)] }] },
    { ...base, items: [{ ...first, caseId: 'case-one' }] }, { ...base, items: [{ ...first, caseId: `charges-${'a'.repeat(64)}` }] },
    { ...base, items: [{ ...first, caseId: `refunds-${'g'.repeat(64)}` }] },
    ...[-1, 0.5, '0', null, undefined, Number.MAX_SAFE_INTEGER + 1].map(expectedVersion => ({ ...base, items: [{ ...first, expectedVersion }] })),
    { ...base, items: [null] }, { ...base, items: [[]] },
  ];
  for (const input of malformed) {
    const response = await request(app.origin, '/api/reviews/bulk', { method: 'POST', headers, body: JSON.stringify(input) });
    assert.equal(response.status, 400, JSON.stringify(input));
    assert.deepEqual(response.json.error, { code: 'BAD_REQUEST', message: 'Pedido inválido.' });
  }
  const body = JSON.stringify(base);
  for (const [bodyValue, headerValues] of [['{', headers], [body, { ...headers, 'content-type': 'text/plain' }], [body + ' '.repeat(65_537), headers]]) {
    assert.equal((await request(app.origin, '/api/reviews/bulk', { method: 'POST', headers: headerValues, body: bodyValue })).status, 400);
  }
  assert.equal(app.calls.length, 0, 'Rejected batches never reach the repository');
});

test('valid bulk reviews preserve every store and optimistic version and return the single batch result', async t => {
  const app = await fixture(t), headers = await writeSession(app);
  const input = bulkInput({ status: 'request_safe_t', items: [
    { storeId: 'test-store', caseId: refundCaseId(1), expectedVersion: 0 },
    { storeId: 'other-store', caseId: refundCaseId(1), expectedVersion: 4 },
  ] });
  const response = await request(app.origin, '/api/reviews/bulk', { method: 'POST', headers, body: JSON.stringify(input) });
  assert.equal(response.status, 200);
  assert.deepEqual(app.calls, [['saveFinancialReviews', input]]);
  assert.deepEqual(response.json, { updatedCount: 2, unchangedCount: 0, reviews: [
    { storeId: 'test-store', caseId: refundCaseId(1), review: { status: 'request_safe_t', version: 1 } },
    { storeId: 'other-store', caseId: refundCaseId(1), review: { status: 'request_safe_t', version: 5 } },
  ] });
  const maximum = bulkInput({ items: Array.from({ length: 100 }, (_, index) => ({ storeId: 'test-store', caseId: refundCaseId(index), expectedVersion: index })) });
  assert.equal((await request(app.origin, '/api/reviews/bulk', { method: 'POST', headers, body: JSON.stringify(maximum) })).json.updatedCount, 100);
  assert.deepEqual(app.calls[1], ['saveFinancialReviews', maximum]);
});

test('bulk conflict and missing-case responses are atomic repository failures with no partial success or leaked details', async t => {
  let code, attempts = 0;
  const app = await fixture(t, { saveFinancialReviews() { attempts++; throw Object.assign(new Error('PRIVATE BULK DATABASE DETAIL'), { code }); } });
  const headers = await writeSession(app), body = JSON.stringify(bulkInput());
  for (const [errorCode, status, publicCode] of [['REVIEW_CONFLICT', 409, 'REVIEW_CONFLICT'], ['CASE_NOT_FOUND', 404, 'NOT_FOUND'],
    ['INVALID_REVIEW', 400, 'BAD_REQUEST'], ['UNEXPECTED', 500, 'INTERNAL_ERROR']]) {
    code = errorCode;
    const response = await request(app.origin, '/api/reviews/bulk', { method: 'POST', headers, body });
    assert.equal(response.status, status); assert.equal(response.json.error.code, publicCode);
    assert.equal(Object.hasOwn(response.json, 'reviews'), false);
    assert.equal(Object.hasOwn(response.json, 'updatedCount'), false);
    assert.equal(response.text.includes('PRIVATE'), false);
  }
  assert.equal(attempts, 4, 'One repository call handles each whole batch');
  assert.equal(app.calls.some(call => call[0] === 'saveFinancialReview'), false);
});

test('customer return list preserves validated dates, store, query, mode and refund filters', async t => {
  const app = await fixture(t), { cookie } = await app.connect(), headers = { cookie };
  const response = await request(app.origin, '/api/customer-returns?storeId=test-store&from=2026-09-01&to=2026-09-25&query=SKU%20%2B%20%C3%A7&mode=DBA&refund=recorded&limit=20&offset=40', { headers });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json.coverage, { state: 'missing', sources: [] });
  assert.deepEqual(app.calls[0], ['customerReturns', { storeId: 'test-store', from: '2026-09-01', to: '2026-09-25', query: 'SKU + ç', mode: 'DBA', refund: 'recorded', limit: 20, offset: 40 }, undefined]);
  for (const mode of ['all', 'FBA', 'DBA', 'MFN', 'unknown']) {
    assert.equal((await request(app.origin, `/api/customer-returns?storeId=all&mode=${mode}&refund=not_found`, { headers })).status, 200);
    assert.deepEqual(app.calls.at(-1), ['customerReturns', { storeId: 'all', mode, refund: 'not_found' }, undefined]);
  }
  assert.equal((await request(app.origin, '/api/customer-returns?refund=all', { headers })).status, 200);
  assert.equal((await request(app.origin, '/api/customer-returns', { method: 'POST', headers })).status, 405);
});

test('invalid customer return filters cannot reach the repository or spill into other list routes', async t => {
  const app = await fixture(t), { cookie } = await app.connect(), headers = { cookie };
  const invalid = ['?storeId=../private', '?storeId=', '?storeId=test-store&storeId=other-store',
    '?mode=merchant', '?mode=fba', '?mode=FBA,DBA', '?refund=paid', '?refund=', '?refund=recorded,not_found', '?refund=all&refund=recorded',
    '?status=Approved', '?reimbursement=identified', '?buyerEmail=private', '?from=2026-02-30',
    '?from=2026-09-20&to=2026-09-01', '?query=%00', '?query=' + 'x'.repeat(201), '?limit=0', '?limit=501', '?offset=-1'];
  for (const query of invalid) assert.equal((await request(app.origin, '/api/customer-returns' + query, { headers })).status, 400, query);
  for (const route of ['/api/orders?refund=recorded', '/api/returns?refund=recorded', '/api/refunds?refund=recorded']) {
    assert.equal((await request(app.origin, route, { headers })).status, 400, route);
  }
  assert.equal(app.calls.length, 0);
});

test('customer return detail requires one store and a valid opaque return identity', async t => {
  const app = await fixture(t), { cookie } = await app.connect(), headers = { cookie }, id = returnId(1);
  const response = await request(app.origin, `/api/customer-returns/${id}?storeId=test-store`, { headers });
  assert.equal(response.status, 200); assert.deepEqual(response.json, { storeId: 'test-store', returnId: id });
  assert.deepEqual(app.calls[0], ['customerReturns', { storeId: 'test-store' }, id]);
  const count = app.calls.length;
  for (const route of [`/api/customer-returns/${id}`, `/api/customer-returns/${id}?storeId=all`,
    `/api/customer-returns/${id}?storeId=../private`, `/api/customer-returns/${id}?storeId=test-store&mode=FBA`,
    `/api/customer-returns/${id}?storeId=test-store&storeId=other-store`,
    '/api/customer-returns/return-short?storeId=test-store', `/api/customer-returns/${id}/extra?storeId=test-store`]) {
    assert.equal((await request(app.origin, route, { headers })).status, 400, route);
  }
  assert.equal(app.calls.length, count);
  const missing = await request(app.origin, `/api/customer-returns/return-${'f'.repeat(64)}?storeId=test-store`, { headers });
  assert.equal(missing.status, 404); assert.equal(missing.json.error.code, 'NOT_FOUND');
});

const customCode = `custom_${'b'.repeat(32)}`;
const statusInput = (extra = {}) => ({ label: 'Aguardando conferência', color: 'amber', menus: ['orders', 'refunds', 'charges', 'customer-returns', 'returns'], active: true, closesCase: false, expectedVersion: 0, ...extra });

test('returned summary cards accept only supported filters on their authenticated route', async t => {
  const app = await fixture(t), {cookie} = await app.connect();
  for (const card of ['all','refunded','reimbursed','already_returned']) {
    assert.equal((await request(app.origin,`/api/returns?card=${card}`,{headers:{cookie}})).status,200);
    assert.equal(app.calls.at(-1)[1].card,card);
  }
  for (const route of ['/api/returns?card=', '/api/returns?card=invalid','/api/returns?card=all&card=refunded','/api/orders?card=refunded']) {
    assert.equal((await request(app.origin,route,{headers:{cookie}})).status,400);
  }
  assert.equal((await request(app.origin,'/api/returns?card=refunded')).status,403);
});
const localInput = (extra = {}) => ({ menu: 'orders', storeId: 'test-store', entityId: '701-1111111-2222222', status: customCode, notes: 'Observação interna\nConferir item.', expectedVersion: 0, ...extra });

test('status settings return the catalogue shape and both new write routes require exact session, Origin and CSRF', async t => {
  const app = await fixture(t), good = await writeSession(app);
  for (const [route, input] of [['/api/settings/statuses', statusInput()], ['/api/local-reviews', localInput()]]) {
    for (const headers of [{}, { cookie: good.cookie }, { ...good, cookie: '' }, { ...good, origin: '' },
      { ...good, origin: `${app.origin}/` }, { ...good, origin: 'https://attacker.invalid' }, { ...good, 'x-csrf-token': 'wrong' }]) {
      assert.equal((await request(app.origin, route, { method: 'POST', headers, body: JSON.stringify(input) })).status, 403);
    }
    assert.equal((await request(app.origin, route, { method: 'DELETE', headers: good })).status, 405);
    assert.equal((await request(app.origin, `${route}?unexpected=true`, { method: 'POST', headers: good, body: JSON.stringify(input) })).status, 400);
  }
  assert.equal(app.calls.length, 0);
  const settings = await request(app.origin, '/api/settings/statuses', { headers: { cookie: good.cookie } });
  assert.equal(settings.status, 200); assert.equal(settings.json.items[0].label, 'Novo');
  assert.deepEqual(settings.json.menus.map(menu => menu.code), ['orders', 'refunds', 'charges', 'customer-returns', 'returns']);
  assert.equal(settings.headers['cache-control'], 'no-store');
  assert.equal((await request(app.origin, '/api/settings/statuses?menu=orders', { headers: good })).status, 400);
  assert.deepEqual(app.calls, [['reviewStatusSettings']]);
});

test('status configuration validates label, strict booleans, menu mappings and optimistic versions before persistence', async t => {
  const app = await fixture(t), headers = await writeSession(app), base = statusInput();
  const malformed = [null, [], { ...base, label: '' }, { ...base, label: '   ' }, { ...base, label: 'x'.repeat(61) }, { ...base, label: 'unsafe\nlabel' },
    { ...base, label: 123 }, { ...base, color: 'purple' }, { ...base, active: 'true' }, { ...base, active: 1 }, { ...base, closesCase: 'false' },
    { ...base, closesCase: null }, { ...base, menus: [] }, { ...base, menus: ['orders', 'orders'] }, { ...base, menus: ['inventory'] },
    { ...base, menus: 'orders' }, { ...base, code: 'invented' }, { ...base, code: `custom_${'G'.repeat(32)}` },
    { ...base, expectedVersion: -1 }, { ...base, expectedVersion: '0' }, { ...base, expectedVersion: 0.5 }, { ...base, expectedVersion: undefined },
    { ...base, role: 'admin' }, { ...base, notes: 'Not a review' }];
  for (const input of malformed) assert.equal((await request(app.origin, '/api/settings/statuses', { method: 'POST', headers, body: JSON.stringify(input) })).status, 400);
  assert.equal(app.calls.length, 0);
  const response = await request(app.origin, '/api/settings/statuses', { method: 'POST', headers, body: JSON.stringify(base) });
  assert.equal(response.status, 200); assert.equal(response.json.status.label, base.label); assert.equal(response.json.status.version, 1);
  assert.ok(response.json.settings.items); assert.deepEqual(app.calls, [['saveReviewStatus', base]]);
  const edit = statusInput({ code: customCode, label: 'Concluído manualmente', color: 'good', active: false, closesCase: true, menus: [], expectedVersion: 2 });
  assert.equal((await request(app.origin, '/api/settings/statuses', { method: 'POST', headers, body: JSON.stringify(edit) })).status, 200);
  assert.deepEqual(app.calls.at(-1), ['saveReviewStatus', edit]);
  assert.ok(app.calls.every(call => call[0] === 'saveReviewStatus'), 'Settings writes never reload or collect Amazon data');
});

test('status conflict, duplicate label and domain validation errors remain explicit and sanitized', async t => {
  let code;
  const app = await fixture(t, { saveReviewStatus() { throw Object.assign(new Error('PRIVATE STATUS DATABASE DETAIL'), { code }); } });
  const headers = await writeSession(app), body = JSON.stringify(statusInput({ code: customCode, expectedVersion: 1 }));
  for (const [failure, status, publicCode] of [['STATUS_CONFLICT', 409, 'STATUS_CONFLICT'], ['DUPLICATE_STATUS', 409, 'DUPLICATE_STATUS'],
    ['INVALID_STATUS', 400, 'BAD_REQUEST'], ['UNKNOWN_FAILURE', 500, 'INTERNAL_ERROR']]) {
    code = failure;
    const response = await request(app.origin, '/api/settings/statuses', { method: 'POST', headers, body });
    assert.equal(response.status, status); assert.equal(response.json.error.code, publicCode);
    assert.equal(response.text.includes('PRIVATE'), false); assert.equal(Object.hasOwn(response.json, 'status'), false);
  }
});

test('status route accepts full HEX and legacy colors but rejects CSS payloads before calling the repository', async t => {
  const app = await fixture(t), headers = await writeSession(app);
  for (const color of ['#A1B2Cf', '#ffffff', '#000000', 'neutral', 'blue', 'amber', 'good', 'red']) {
    const input = statusInput({ color });
    const response = await request(app.origin, '/api/settings/statuses', { method: 'POST', headers, body: JSON.stringify(input) });
    assert.equal(response.status, 200);
    assert.deepEqual(app.calls.at(-1), ['saveReviewStatus', input]);
  }
  const callCount = app.calls.length;
  for (const color of ['#abc', '#12345678', '#12345g', '#123456\n', ' #123456', '#123456 ',
    '#123456;background:url(https://invalid.test)', 'rgb(10,20,30)', 'var(--color)', '</style><script>alert(1)</script>',
    null, 123456, [], {}]) {
    assert.equal((await request(app.origin, '/api/settings/statuses', { method: 'POST', headers,
      body: JSON.stringify(statusInput({ color })) })).status, 400);
  }
  assert.equal(app.calls.length, callCount);
});

test('SAFE-T is authenticated read-only and passes its own bounded OR filters to the repository', async t => {
  const app = await fixture(t);
  assert.equal((await request(app.origin, '/api/safe-t')).status, 403);
  const { cookie } = await app.connect(), headers = { cookie };
  const query = '?storeId=test-store&from=2026-09-01&to=2026-09-25&query=SKU%20AZUL&mode=DBA&status=CUSTOMER_RETURN,LOST&limit=25&offset=50';
  const result = await request(app.origin, `/api/safe-t${query}`, { headers });
  assert.equal(result.status, 200); assert.equal(result.json.eligibilityAssessed, false);
  assert.deepEqual(app.calls.at(-1), ['safeTCases', { storeId: 'test-store', from: '2026-09-01', to: '2026-09-25',
    query: 'SKU AZUL', mode: 'DBA', status: 'CUSTOMER_RETURN,LOST', limit: 25, offset: 50 }]);
  for (const status of ['all', 'LOST', 'FUTURE_STATUS_2', 'OTHER_STATUS_1234567890ABCDEF']) {
    assert.equal((await request(app.origin, `/api/safe-t?status=${status}`, { headers })).status, 200);
  }
  assert.equal((await request(app.origin, '/api/orders?status=FUTURE_STATUS_2', { headers })).status, 400,
    'The SAFE-T route must not widen the existing Orders filter');
  const count = app.calls.length;
  for (const query of ['status=', 'status=LOST,', 'status=LOST,LOST', 'status=LOST,lost', 'status=all,LOST',
    `status=${'A'.repeat(81)}`, 'status=LOST%20STATUS', 'status=LOST&status=DELIVERED', 'mode=unsafe',
    'reviewStatus=pending', 'reimbursement=safe_t', 'from=2026-02-30', 'limit=501', 'offset=-1', 'storeId=../outside']) {
    assert.equal((await request(app.origin, `/api/safe-t?${query}`, { headers })).status, 400, query);
  }
  for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await request(app.origin, '/api/safe-t', { method, headers })).status, 405);
  assert.equal(app.calls.length, count, 'Invalid input and writes never reach the repository');
});

test('local review routes preserve store, menu and entity identity and return review metadata and history', async t => {
  const app = await fixture(t), headers = await writeSession(app);
  for (const input of [localInput(), localInput({ storeId: 'other-store' }), localInput({ menu: 'returns' }), localInput({ menu: 'customer-returns', entityId: returnId(1) })]) {
    const identity = { menu: input.menu, storeId: input.storeId, entityId: input.entityId };
    const read = await request(app.origin, '/api/local-reviews?' + new URLSearchParams(identity), { headers });
    assert.equal(read.status, 200); assert.equal(read.json.storeId, input.storeId); assert.equal(read.json.entityId, input.entityId);
    assert.deepEqual(read.json.reviewHistory, []); assert.equal(read.json.review.color, 'neutral'); assert.equal(read.json.review.closesCase, false);
    assert.deepEqual(app.calls.at(-1), ['localReview', identity]);
    const saved = await request(app.origin, '/api/local-reviews', { method: 'POST', headers, body: JSON.stringify(input) });
    assert.equal(saved.status, 200); assert.equal(saved.json.review.status, customCode); assert.equal(saved.json.review.version, 1);
    assert.equal(saved.json.review.notes, input.notes); assert.deepEqual(app.calls.at(-1), ['saveLocalReview', input]);
  }
  assert.ok(app.calls.every(call => ['localReview', 'saveLocalReview'].includes(call[0])), 'Operational reviews only call their local repository methods');
});

test('local review identity and input bounds reject malformed or cross-menu requests before repository calls', async t => {
  const app = await fixture(t), headers = await writeSession(app), base = localInput();
  for (const patch of [{ menu: 'refunds' }, { menu: 'charges' }, { menu: 'inventory' }, { storeId: 'all' }, { storeId: '../other' },
    { entityId: '' }, { entityId: ['order'] }, { entityId: 'x'.repeat(81) }, { menu: 'customer-returns' },
    { status: 'unknown-code' }, { status: 'all' }, { notes: 'x'.repeat(2001) }, { notes: 'hidden\u007f' },
    { expectedVersion: '0' }, { expectedVersion: -1 }, { expectedVersion: undefined }, { totalCents: '100' }, { reviewer: 'other' }]) {
    assert.equal((await request(app.origin, '/api/local-reviews', { method: 'POST', headers, body: JSON.stringify({ ...base, ...patch }) })).status, 400);
  }
  const validIdentity = 'menu=orders&storeId=test-store&entityId=order-one';
  for (const query of ['', 'menu=orders&storeId=all&entityId=order-one', 'menu=customer-returns&storeId=test-store&entityId=order-one',
    validIdentity + '&storeId=other-store', validIdentity + '&status=resolved', validIdentity + '&entityId=order-two']) {
    assert.equal((await request(app.origin, '/api/local-reviews?' + query, { headers })).status, 400);
  }
  assert.equal((await request(app.origin, '/api/local-reviews', { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await request(app.origin, '/api/local-reviews', { method: 'POST', headers: { ...headers, 'content-type': 'text/plain' }, body: JSON.stringify(base) })).status, 400);
  assert.equal(app.calls.length, 0);
});

test('custom local status reaches domain validation and conflicts or missing entities never leak internal data', async t => {
  let code = 'INVALID_STATUS', attempts = 0;
  const error = () => { attempts++; throw Object.assign(new Error('PRIVATE REVIEW DETAIL'), { code }); };
  const app = await fixture(t, { saveLocalReview: error, localReview: error }), headers = await writeSession(app), body = JSON.stringify(localInput());
  for (const [failure, status, publicCode] of [['INVALID_STATUS', 400, 'BAD_REQUEST'], ['INVALID_REVIEW', 400, 'BAD_REQUEST'],
    ['REVIEW_CONFLICT', 409, 'REVIEW_CONFLICT'], ['CASE_NOT_FOUND', 404, 'NOT_FOUND'], ['UNKNOWN_FAILURE', 500, 'INTERNAL_ERROR']]) {
    code = failure;
    const result = await request(app.origin, '/api/local-reviews', { method: 'POST', headers, body });
    assert.equal(result.status, status); assert.equal(result.json.error.code, publicCode); assert.equal(result.text.includes('PRIVATE'), false);
  }
  assert.equal(attempts, 5, 'Syntactically valid custom code is validated by the domain');
  code = 'CASE_NOT_FOUND';
  assert.equal((await request(app.origin, '/api/local-reviews?menu=orders&storeId=test-store&entityId=order-one', { headers })).status, 404);
});

test('operational review filters only belong to their three lists while financial lists retain status', async t => {
  const app = await fixture(t), { cookie } = await app.connect(), headers = { cookie };
  for (const route of ['/api/orders', '/api/returns', '/api/customer-returns']) {
    for (const status of ['all', 'pending', 'rm_safe_t_granted', customCode]) {
      assert.equal((await request(app.origin, `${route}?storeId=test-store&reviewStatus=${status}`, { headers })).status, 200);
      assert.equal(app.calls.at(-1)[1].reviewStatus, status);
    }
  }
  const count = app.calls.length;
  for (const route of ['/api/inventory', '/api/dashboard', '/api/refunds', '/api/charges']) {
    assert.equal((await request(app.origin, `${route}?reviewStatus=${customCode}`, { headers })).status, 400);
  }
  for (const query of ['reviewStatus=unknown', 'reviewStatus=rm_unknown', 'reviewStatus=pending,resolved', `reviewStatus=${customCode}&reviewStatus=pending`]) {
    assert.equal((await request(app.origin, '/api/orders?' + query, { headers })).status, 400);
  }
  assert.equal(app.calls.length, count);
  for (const kind of ['refunds', 'charges']) {
    assert.equal((await request(app.origin, `/api/${kind}?status=${customCode}`, { headers })).status, 200);
    assert.deepEqual(app.calls.at(-1), ['financialCases', kind, { status: customCode }]);
  }
  const writeHeaders = { ...headers, origin: app.origin, 'content-type': 'application/json', 'x-csrf-token': (await request(app.origin, '/api/bootstrap', { headers })).json.meta.csrfToken };
  const financial = { kind: 'charges', storeId: 'test-store', caseId: 'case-one', status: 'request_safe_t', notes: '', expectedVersion: 0 };
  assert.equal((await request(app.origin, '/api/reviews', { method: 'POST', headers: writeHeaders, body: JSON.stringify(financial) })).status, 200);
  assert.deepEqual(app.calls.at(-1), ['saveFinancialReview', financial]);
});


test('dashboard drilldown validates its selection and retains store/date scope', async t => {
  const app = await fixture(t), { cookie } = await app.connect(), headers = { cookie };
  const route = '/api/dashboard/transactions?storeId=test-store&from=2026-09-01&to=2026-09-25&bucket=type&type=ServiceFee&currency=BRL&limit=50&offset=50';
  assert.equal((await request(app.origin, route, { headers })).status, 200);
  assert.deepEqual(app.calls.at(-1), ['dashboardTransactions', { storeId:'test-store', from:'2026-09-01', to:'2026-09-25', bucket:'type', type:'ServiceFee', currency:'BRL', limit:50, offset:50 }]);
  for (const query of ['bucket=bad', 'bucket=type', 'bucket=net&type=Refund', 'currency=brl', 'currency=BRL,USD', 'bucket=net&bucket=net', 'limit=501', 'offset=-1', 'secret=x']) {
    assert.equal((await request(app.origin, `/api/dashboard/transactions?${query}`, { headers })).status, 400, query);
  }
  assert.equal((await request(app.origin, '/api/dashboard/transactions', { method:'POST', headers })).status, 405);
});

test('returned management writes validate identity, session, CSRF and preserve atomic conflict responses', async t => {
  const calls=[];
  const app=await fixture(t,{saveReturnedManagement:input=>{calls.push(input);return {updated:input.items.length};}});
  const {cookie}=await app.connect();
  const bootstrap=await request(app.origin,'/api/bootstrap',{headers:{cookie}});
  const csrf=bootstrap.json.meta.csrfToken;
  const payload={action:'finalize',items:[{storeId:'test-store',orderId:'order-a',expectedVersion:0}],status:'resolved'};
  const headers={cookie,origin:app.origin,'content-type':'application/json','x-csrf-token':csrf};
  const post=(body=payload,extra={})=>request(app.origin,'/api/returns/manage',{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
  assert.equal((await post(payload,{'x-csrf-token':'bad'})).status,403);
  assert.equal((await post(payload,{origin:'https://example.com'})).status,403);
  assert.equal((await post({...payload,totalCents:'1000'})).status,400);
  assert.equal(calls.length,0);
  assert.equal((await post()).status,200); assert.deepEqual(calls,[payload]);
  app.repository.saveReturnedManagement=()=>{throw Object.assign(new Error('private detail'),{code:'REVIEW_CONFLICT'});};
  const conflict=await post(); assert.equal(conflict.status,409); assert.equal(conflict.json.error.code,'REVIEW_CONFLICT');
  assert.ok(!conflict.text.includes('private detail'));
  const filtered=await request(app.origin,'/api/returns?workflow=finalized',{headers:{cookie}});
  assert.equal(filtered.status,200); assert.equal(app.calls.at(-1)[1].workflow,'finalized');
});


test('product cost links require a scoped order, owner session, Origin and CSRF; conflicts remain reviewable', async t => {
  let conflict = false;
  const calls = [];
  const app = await fixture(t, {
    productCostLink: input => { calls.push(['read',input]);return {...input,products:[]}; },
    saveProductCostLink: input => { calls.push(['save',input]);if(conflict)throw Object.assign(new Error('conflict'),{code:'COST_LINK_CONFLICT'});return {saved:true}; }
  }, {storeScope:'test-store'});
  const identity={storeId:'test-store',orderId:'order',sku:'SKU / DBA+á'};
  const route='/api/product-cost-link?'+new URLSearchParams(identity);
  assert.equal((await request(app.origin,route)).status,403);
  const {cookie}=await app.connect(),headers={cookie};
  assert.equal((await request(app.origin,route,{headers})).status,200);
  assert.deepEqual(calls[0],['read',identity]);
  for(const extra of ['&storeId=test-store','&unknown=true'])assert.equal((await request(app.origin,route+extra,{headers})).status,400);
  assert.equal((await request(app.origin,'/api/product-cost-link?'+new URLSearchParams({...identity,storeId:'other'}),{headers})).status,403);
  const bootstrap=await request(app.origin,'/api/bootstrap',{headers});
  const body=JSON.stringify({...identity,companyId:'company',productId:'product',expectedVersion:0});
  const post={...headers,origin:app.origin,'content-type':'application/json','x-csrf-token':bootstrap.json.meta.csrfToken};
  for(const override of [{origin:'https://elsewhere.invalid'},{'x-csrf-token':'bad'}])assert.equal((await request(app.origin,'/api/product-cost-link',{method:'POST',headers:{...post,...override},body})).status,403);
  assert.equal((await request(app.origin,'/api/product-cost-link',{method:'POST',headers:post,body})).status,200);
  conflict=true;
  const rejected=await request(app.origin,'/api/product-cost-link',{method:'POST',headers:post,body});
  assert.equal(rejected.status,409);assert.equal(rejected.json.error.code,'COST_LINK_CONFLICT');
  assert.equal((await request(app.origin,'/api/product-cost-link',{method:'POST',headers:post,body:JSON.stringify({...identity,storeId:'other',companyId:'company',productId:'product',expectedVersion:0})})).status,403);
});


test('settings SKU catalogue is authenticated, paginated and store-scoped without allowing expanded writes',async t=>{
  const calls=[];
  const app=await fixture(t,{productSkuList:filters=>{calls.push(filters);return {items:[],total:0};}}, {storeScope:'test-store'});
  const route='/api/settings/product-links';assert.equal((await request(app.origin,route)).status,403);
  const {cookie}=await app.connect(),headers={cookie};
  assert.equal((await request(app.origin,route+'?storeId=all&linkStatus=unlinked&mode=DBA&limit=50&offset=50',{headers})).status,200);
  assert.deepEqual(calls.at(-1),{storeId:'test-store',query:'',linkStatus:'unlinked',mode:'DBA',limit:50,offset:50});
  for(const query of ['storeId=other','storeId=test-store,other'])assert.equal((await request(app.origin,route+'?'+query,{headers})).status,403);
  for(const query of ['linkStatus=bad','mode=UNKNOWN','limit=101','offset=-1','query='+encodeURIComponent('x'.repeat(201)),'storeId=all&storeId=test-store'])assert.equal((await request(app.origin,route+'?'+query,{headers})).status,400);
  assert.equal((await request(app.origin,route,{method:'POST',headers})).status,405);
});


test('ASIN group API enforces sessions, scoped membership, CSRF and optimistic conflicts',async t=>{
  let conflict=false;const calls=[];
  const app=await fixture(t,{
    productCostGroup:input=>{calls.push(['read',input]);return {...input,members:[],expectedRevision:'a'.repeat(64)};},
    saveProductCostGroup:input=>{calls.push(['save',input]);if(conflict)throw Object.assign(new Error('conflict'),{code:'COST_LINK_CONFLICT'});return {saved:true};}
  },{storeScope:'test-store'});
  const route='/api/product-cost-group',identity={storeId:'all',asin:'B012345678'},get=route+'?'+new URLSearchParams(identity);
  assert.equal((await request(app.origin,get)).status,403);
  const {cookie}=await app.connect(),headers={cookie};
  assert.equal((await request(app.origin,get,{headers})).status,200);
  assert.deepEqual(calls.at(-1),['read',{...identity,storeId:'test-store'}]);
  for(const params of ['storeId=other&asin=B012345678','storeId=test-store,other&asin=B012345678'])assert.equal((await request(app.origin,route+'?'+params,{headers})).status,403);
  for(const extra of ['&asin=B012345678','&sku=unknown'])assert.equal((await request(app.origin,get+extra,{headers})).status,400);
  const bootstrap=await request(app.origin,'/api/bootstrap',{headers});
  const input={...identity,storeId:'test-store',companyId:'company',productId:'product',expectedRevision:'a'.repeat(64)};
  const body=JSON.stringify(input),post={...headers,origin:app.origin,'content-type':'application/json','x-csrf-token':bootstrap.json.meta.csrfToken};
  for(const override of [{origin:'https://elsewhere.invalid'},{'x-csrf-token':'bad'}])assert.equal((await request(app.origin,route,{method:'POST',headers:{...post,...override},body})).status,403);
  assert.equal((await request(app.origin,route,{method:'POST',headers:post,body})).status,200);
  for(const storeId of ['all','other','test-store,other'])assert.equal((await request(app.origin,route,{method:'POST',headers:post,body:JSON.stringify({...input,storeId})})).status,403);
  conflict=true;const rejected=await request(app.origin,route,{method:'POST',headers:post,body});
  assert.equal(rejected.status,409);assert.equal(rejected.json.error.code,'COST_LINK_CONFLICT');
});
