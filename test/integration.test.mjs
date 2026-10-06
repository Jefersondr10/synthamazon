import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AmazonClient } from '../src/amazon/client.mjs';
import { SnapshotStore } from '../src/storage.mjs';
import { collectPilot } from '../src/pilot.mjs';

test('cliente, coletor e armazenamento percorrem as três fontes mantendo a evidência original', async t => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'synthamazon-integration-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const requests = [];
  const financeRaw = '{"payload":{"transactions":[{"transactionId":"test-1","totalAmount":{"currencyCode":"BRL","currencyAmount":10.0100}}]}}';
  const amazonRaw = '{ "orders": [{"orderId":"test-amazon","proceeds":{"grandTotal":{"amount":"10.0100","currencyCode":"BRL"}}}] }';
  const cancelledRaw = '{ "orders": [{"orderId":"test-merchant-cancelled"}] }';
  const client = new AmazonClient({
    clientId: 'test-client', clientSecret: 'test-secret', refreshToken: 'test-refresh', now: () => Date.parse('2026-09-24T15:00:00Z'),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url === 'https://api.amazon.com/auth/o2/token') return new Response('{"access_token":"test-access","expires_in":3600}');
      const endpoint = new URL(url);
      assert.equal(endpoint.origin, 'https://sellingpartnerapi-na.amazon.com');
      assert.equal(options.method, 'GET');
      if (endpoint.pathname.startsWith('/orders/')) {
        assert.ok(['AMAZON', 'MERCHANT'].includes(endpoint.searchParams.get('fulfilledBy')));
        assert.equal(endpoint.searchParams.get('includedData'), 'PROCEEDS,EXPENSE,PROMOTION,PACKAGES,FULFILLMENT');
        if (endpoint.searchParams.has('fulfillmentStatuses')) {
          assert.equal(endpoint.searchParams.get('fulfillmentStatuses'), 'CANCELLED');
          return new Response(endpoint.searchParams.get('fulfilledBy') === 'MERCHANT' ? cancelledRaw : '{"orders":[]}');
        }
        return new Response(endpoint.searchParams.get('fulfilledBy') === 'AMAZON' ? amazonRaw : '{"orders":[]}');
      }
      if (endpoint.pathname.startsWith('/finances/')) return new Response(financeRaw);
      if (endpoint.pathname.startsWith('/fba/')) return new Response('{"payload":{"granularity":{"granularityType":"Marketplace","granularityId":"A2Q3Y263D00KWC"},"inventorySummaries":[]}}');
      throw new Error('Endpoint inesperado.');
    }
  });
  const store = new SnapshotStore({ rootDir, storeId: 'origem-comercio' });
  const run = await collectPilot({ client, store, config: { storeId: 'origem-comercio', marketplaceId: 'A2Q3Y263D00KWC' }, sellerId: 'test-seller', window: { from: '2026-09-01T03:00:00Z', to: '2026-09-08T03:00:00Z' } });
  assert.equal(run.status, 'collected-awaiting-validation');
  assert.equal(run.sources.length, 3);
  const financePage = run.sources.find(source => source.source === 'transactions').pages[0];
  assert.equal(await store.readPage({ source: 'transactions', hash: financePage.hash }), financeRaw);
  const orders = run.sources.find(source => source.source === 'orders');
  assert.deepEqual(orders.requestedFulfilledBy, ['AMAZON', 'MERCHANT']);
  assert.deepEqual(orders.requestedFulfillmentStatuses, ['CANCELLED']);
  assert.equal(orders.cancellationStatusStatus, 'complete');
  assert.deepEqual(orders.pages.map(page => page.requestFilters), [
    { fulfilledBy: ['AMAZON'] }, { fulfilledBy: ['MERCHANT'] },
    { fulfilledBy: ['AMAZON'], fulfillmentStatuses: ['CANCELLED'] },
    { fulfilledBy: ['MERCHANT'], fulfillmentStatuses: ['CANCELLED'] }
  ]);
  assert.equal(await store.readPage({ source: 'orders', hash: orders.pages[0].hash }), amazonRaw);
  assert.equal(await store.readPage({ source: 'orders', hash: orders.pages[3].hash }), cancelledRaw);
  const orderRequests = requests.filter(request => new URL(request.url).pathname.startsWith('/orders/'));
  assert.deepEqual(orderRequests.map(request => new URL(request.url).searchParams.get('fulfilledBy')), ['AMAZON', 'MERCHANT', 'AMAZON', 'MERCHANT']);
  assert.deepEqual(orderRequests.map(request => new URL(request.url).searchParams.get('fulfillmentStatuses')), [null, null, 'CANCELLED', 'CANCELLED']);
  assert.equal(requests.filter(request => request.options.method === 'POST').length, 1);
  assert.equal(requests.filter(request => request.options.method === 'GET').length, 6);
  const manifest = await readFile(path.join(rootDir, 'origem-comercio', 'runs', `${run.id}.json`), 'utf8');
  assert.equal(/test-secret|test-refresh|test-access/.test(manifest), false);
  assert.equal(JSON.parse(manifest).reconciliationStatus, 'pending');
});
