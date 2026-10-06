import test from 'node:test';
import assert from 'node:assert/strict';
import { collectPilot } from '../src/pilot.mjs';

function fixture() {
  const saved = [];
  const manifests = [];
  const store = { async savePage(page) { saved.push(page); return { hash: 'hash', relativePath: 'objects/sample.json' }; }, async saveRun(run) { manifests.push(run); } };
  const config = { storeId: 'origem-comercio', marketplaceId: 'A2Q3Y263D00KWC' };
  const window = { from: '2026-09-01T03:00:00Z', to: '2026-09-02T03:00:00Z' };
  return { saved, manifests, store, config, window, sellerId: 'test-seller' };
}

test('falha na última página mantém fonte parcial e permite coletar estoque FBA', async () => {
  const f = fixture();
  const client = {
    async *searchOrders() { yield { rawBody: '{"orders":[{"orderId":"test"}]}', orders: [{}], nextToken: 'opaque' }; throw Object.assign(new Error('TOKEN-NAO-DEVE-VAZAR'), { status: 429 }); },
    async *getInventorySummaries(params) { assert.equal(params.details, true); yield { rawBody: '{"payload":{"inventorySummaries":[]}}', inventorySummaries: [] }; }
  };
  const run = await collectPilot({ ...f, client, sources: ['orders', 'fba-inventory'] });
  assert.equal(run.status, 'partial');
  assert.equal(run.sources[0].status, 'partial');
  assert.equal(run.sources[0].cancellationStatusStatus, 'failed');
  assert.equal(run.sources[1].status, 'api-pages-complete');
  assert.equal(run.sources[1].requestedWindow, null);
  assert.equal(JSON.stringify(f.manifests).includes('TOKEN-NAO-DEVE-VAZAR'), false);
  assert.equal(JSON.stringify(f.manifests).includes('opaque'), false);
});

test('páginas completas preservam valores originais mas não declaram conciliação financeira', async () => {
  const f = fixture();
  const rawBody = '{"payload":{"transactions":[{"amount":10.0100}]}}';
  const client = { async *listTransactions(params) { assert.equal(params.marketplaceId, f.config.marketplaceId); yield { rawBody, transactions: [{ amount: 10.01 }] }; } };
  const run = await collectPilot({ ...f, client, sources: ['transactions'] });
  assert.equal(f.saved[0].body, rawBody);
  assert.equal(run.status, 'collected-awaiting-validation');
  assert.equal(run.reconciliationStatus, 'pending');
  assert.equal(run.costStatus, 'pending');
  assert.equal(run.sources[0].recordsObserved, 1);
});

test('updated order collection catches old orders whose status changed and records its date basis', async () => {
  const f = fixture();
  const requests = [];
  const client = { async *searchOrders(params) { requests.push(params); yield { rawBody: '{"orders":[]}', orders: [] }; } };
  const run = await collectPilot({ ...f, client, sources: ['orders'], orderDateBasis: 'updated' });
  assert.equal(run.sources[0].dateBasis, 'updated');
  assert.equal(requests.length, 4);
  for (const params of requests) {
    assert.equal(params.createdAfter, undefined);
    assert.equal(params.lastUpdatedAfter, f.window.from);
    assert.equal(params.lastUpdatedBefore, f.window.to);
    assert.ok(params.includedData.includes('FULFILLMENT'));
  }
});

test('generator interrompido sem página final não declara cobertura completa', async () => {
  const f = fixture();
  const client = { async *searchOrders() { yield { rawBody: '{"orders":[]}', orders: [], nextToken: 'next' }; } };
  const run = await collectPilot({ ...f, client, sources: ['orders'] });
  assert.equal(run.sources[0].status, 'partial');
});

test('resposta sem lista esperada não vira falso zero', async () => {
  const f = fixture();
  const client = { async *searchOrders() { yield { rawBody: '{}' }; } };
  const run = await collectPilot({ ...f, client, sources: ['orders'] });
  assert.equal(run.status, 'failed');
  assert.equal(f.saved.length, 0);
});

test('orders esgota as bases e CANCELLED por modo e registra consultas sem alterar rawBody', async () => {
  const f = fixture();
  const requests = [];
  const raw = '{ "orders": [{"orderId":"test","proceeds":{"grandTotal":{"amount":"10.0100"}}}] }';
  const client = {
    async *searchOrders(params) {
      requests.push(structuredClone(params));
      yield { rawBody: raw, orders: [{}], nextToken: 'opaque', requestFilters: { fulfilledBy: ['WRONG_FROM_RESPONSE'], fulfillmentStatuses: ['SHIPPED'] } };
      yield { rawBody: '{"orders":[]}', orders: [] };
    }
  };
  const run = await collectPilot({ ...f, client, sources: ['orders'] });
  assert.equal(run.status, 'collected-awaiting-validation');
  const source = run.sources[0];
  assert.equal(source.status, 'api-pages-complete');
  assert.deepEqual(source.requestedFulfilledBy, ['AMAZON', 'MERCHANT']);
  assert.deepEqual(source.requestedFulfillmentStatuses, ['CANCELLED']);
  assert.equal(source.cancellationStatusStatus, 'complete');
  assert.deepEqual(requests.map(request => request.fulfilledBy), [['AMAZON'], ['MERCHANT'], ['AMAZON'], ['MERCHANT']]);
  assert.deepEqual(requests.map(request => request.fulfillmentStatuses), [undefined, undefined, ['CANCELLED'], ['CANCELLED']]);
  for (const request of requests) {
    assert.equal(request.createdAfter, f.window.from);
    assert.equal(request.createdBefore, f.window.to);
    assert.deepEqual(request.marketplaceIds, [f.config.marketplaceId]);
    assert.deepEqual(request.includedData, ['PROCEEDS', 'EXPENSE', 'PROMOTION', 'PACKAGES', 'FULFILLMENT']);
  }
  assert.deepEqual(source.pages.map(page => page.requestFilters), [
    { fulfilledBy: ['AMAZON'] }, { fulfilledBy: ['AMAZON'] },
    { fulfilledBy: ['MERCHANT'] }, { fulfilledBy: ['MERCHANT'] },
    { fulfilledBy: ['AMAZON'], fulfillmentStatuses: ['CANCELLED'] }, { fulfilledBy: ['AMAZON'], fulfillmentStatuses: ['CANCELLED'] },
    { fulfilledBy: ['MERCHANT'], fulfillmentStatuses: ['CANCELLED'] }, { fulfilledBy: ['MERCHANT'], fulfillmentStatuses: ['CANCELLED'] },
  ]);
  assert.deepEqual(source.pages.map(page => page.hasNextPage), [true, false, true, false, true, false, true, false]);
  assert.equal(source.recordsObserved, 4);
  assert.equal(f.saved[0].body, raw);
  assert.equal(f.saved[2].body, raw);
  assert.equal(f.saved[4].body, raw);
  assert.equal(f.saved[6].body, raw);
  assert.equal(JSON.stringify(source).includes('WRONG_FROM_RESPONSE'), false);
  assert.equal(JSON.stringify(source).includes('SHIPPED'), false);
  assert.equal(JSON.stringify(source).includes('opaque'), false);
});

test('base incompleta não é encoberta pela conclusão das consultas CANCELLED', async () => {
  for (const incomplete of ['AMAZON', 'MERCHANT']) {
    const f = fixture();
    const client = {
      async *searchOrders({ fulfilledBy, fulfillmentStatuses }) {
        yield { rawBody: '{"orders":[]}', orders: [], ...(!fulfillmentStatuses && fulfilledBy[0] === incomplete ? { nextToken: 'missing-final-page' } : {}) };
      }
    };
    const run = await collectPilot({ ...f, client, sources: ['orders'] });
    assert.equal(run.sources[0].pages.length, 4);
    assert.equal(run.sources[0].cancellationStatusStatus, 'complete');
    assert.equal(run.sources[0].status, 'partial');
    assert.equal(run.status, 'partial');
  }
});

test('partição sem qualquer página não é tratada como conjunto vazio confirmado', async () => {
  for (const emptyGenerator of ['AMAZON', 'MERCHANT']) {
    const f = fixture();
    const client = {
      async *searchOrders({ fulfilledBy, fulfillmentStatuses }) {
        if (!fulfillmentStatuses && fulfilledBy[0] === emptyGenerator) return;
        yield { rawBody: '{"orders":[]}', orders: [] };
      }
    };
    const run = await collectPilot({ ...f, client, sources: ['orders'] });
    assert.equal(run.sources[0].pages.length, 3);
    assert.equal(run.sources[0].cancellationStatusStatus, 'complete');
    assert.equal(run.sources[0].status, 'partial');
  }
});

test('falha na segunda partição preserva evidência da primeira e marca orders parcial', async () => {
  const f = fixture();
  const client = {
    async *searchOrders({ fulfilledBy }) {
      if (fulfilledBy[0] === 'MERCHANT') throw Object.assign(new Error('private-error-body'), { code: 'RATE_LIMITED', status: 429 });
      yield { rawBody: '{"orders":[]}', orders: [] };
    }
  };
  const run = await collectPilot({ ...f, client, sources: ['orders'] });
  assert.equal(run.status, 'partial');
  assert.equal(run.sources[0].status, 'partial');
  assert.equal(run.sources[0].cancellationStatusStatus, 'failed');
  assert.deepEqual(run.sources[0].pages[0].requestFilters, { fulfilledBy: ['AMAZON'] });
  assert.equal(run.sources[0].error.code, 'RATE_LIMITED');
  assert.equal(JSON.stringify(run).includes('private-error-body'), false);
});

test('quatro consultas com página vazia terminal comprovam conclusão sem inventar registros', async () => {
  const f = fixture();
  const client = { async *searchOrders() { yield { rawBody: '{"orders":[]}', orders: [] }; } };
  const run = await collectPilot({ ...f, client, sources: ['orders'] });
  assert.equal(run.status, 'collected-awaiting-validation');
  assert.equal(run.sources[0].recordsObserved, 0);
  assert.equal(run.sources[0].pages.length, 4);
  assert.equal(run.sources[0].cancellationStatusStatus, 'complete');
});

test('consulta CANCELLED incompleta não é encoberta pela página final da outra modalidade', async () => {
  for (const incomplete of ['AMAZON', 'MERCHANT']) {
    const f = fixture();
    const client = {
      async *searchOrders({ fulfilledBy, fulfillmentStatuses }) {
        yield { rawBody: '{"orders":[]}', orders: [], ...(fulfillmentStatuses && fulfilledBy[0] === incomplete ? { nextToken: 'missing-final-page' } : {}) };
      }
    };
    const run = await collectPilot({ ...f, client, sources: ['orders'] });
    assert.equal(run.sources[0].pages.length, 4);
    assert.equal(run.sources[0].cancellationStatusStatus, 'partial');
    assert.equal(run.sources[0].status, 'partial');
    assert.equal(run.status, 'partial');
  }
});

test('CANCELLED sem página terminal não comprova ausência de cancelamentos', async () => {
  for (const emptyGenerators of [['AMAZON'], ['MERCHANT'], ['AMAZON', 'MERCHANT']]) {
    const f = fixture();
    const client = {
      async *searchOrders({ fulfilledBy, fulfillmentStatuses }) {
        if (fulfillmentStatuses && emptyGenerators.includes(fulfilledBy[0])) return;
        yield { rawBody: '{"orders":[]}', orders: [] };
      }
    };
    const run = await collectPilot({ ...f, client, sources: ['orders'] });
    assert.equal(run.sources[0].pages.length, 4 - emptyGenerators.length);
    assert.equal(run.sources[0].cancellationStatusStatus, emptyGenerators.length === 2 ? 'failed' : 'partial');
    assert.equal(run.sources[0].status, 'partial');
  }
});

test('falha em CANCELLED preserva bases e evidências anteriores sem declarar status completo', async () => {
  for (const failingMode of ['AMAZON', 'MERCHANT']) {
    const f = fixture();
    const client = {
      async *searchOrders({ fulfilledBy, fulfillmentStatuses }) {
        if (fulfillmentStatuses && fulfilledBy[0] === failingMode) throw Object.assign(new Error('private-error-body'), { code: 'RATE_LIMITED', status: 429 });
        yield { rawBody: '{"orders":[]}', orders: [] };
      }
    };
    const run = await collectPilot({ ...f, client, sources: ['orders'] });
    assert.equal(run.sources[0].pages.length, failingMode === 'AMAZON' ? 2 : 3);
    assert.equal(run.sources[0].cancellationStatusStatus, failingMode === 'AMAZON' ? 'failed' : 'partial');
    assert.equal(run.sources[0].status, 'partial');
    assert.equal(run.sources[0].error.code, 'RATE_LIMITED');
    assert.equal(JSON.stringify(run).includes('private-error-body'), false);
  }
});
