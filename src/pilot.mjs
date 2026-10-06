import { randomUUID } from 'node:crypto';

export const SOURCES = ['orders', 'transactions', 'fba-inventory'];

export async function collectPilot({ client, config, store, window, sellerId, sources = SOURCES, orderDateBasis = 'created', now = () => new Date(), report = () => {} }) {
  if (!['created', 'updated'].includes(orderDateBasis)) throw new Error('Base de data inválida.');
  if (!sources.length || sources.some(source => !SOURCES.includes(source))) throw new Error('Fonte inválida.');
  const run = {
    id: randomUUID(), schemaVersion: 1,
    storeId: config.storeId, marketplaceId: config.marketplaceId,
    configuredSellerId: sellerId,
    accountIdentityVerification: 'pending-check-against-authorization',
    startedAt: now().toISOString(), status: 'collecting',
    reconciliationStatus: 'pending', costStatus: 'pending',
    sources: [],
    notes: [
      'Arquivo de observações para validar a integração; ainda não é um livro financeiro.',
      'Paginação concluída não comprova conciliação nem ausência de dados ainda não publicados.',
      'Rastreio MERCHANT não identifica automaticamente DBA.',
      'Estoque FBA representa a posição observada durante a coleta, não a posição histórica do período.'
    ]
  };
  for (const source of [...new Set(sources)]) {
    const entry = {
      source,
      apiVersion: source === 'orders' ? '2026-01-01' : source === 'transactions' ? '2024-06-19' : 'v1',
      requestedWindow: source === 'fba-inventory' ? null : window,
      ...(source === 'orders' ? { requestedFulfilledBy: ['AMAZON', 'MERCHANT'], requestedFulfillmentStatuses: ['CANCELLED'], cancellationStatusStatus: 'failed' } : {}),
      dateBasis: source === 'orders' ? orderDateBasis : source === 'transactions' ? 'posted' : 'current-snapshot',
      status: 'collecting', startedAt: now().toISOString(), pages: [], recordsObserved: 0,
      validationStatus: 'pending'
    };
    run.sources.push(entry);
    report({ source, status: 'collecting' });
    try {
      const savePages = async (pages, listProperty, requestFilters) => {
        let nextToken;
        let partitionPages = 0;
        for await (const page of pages) {
          if (typeof page.rawBody !== 'string' || !Array.isArray(page[listProperty])) throw new Error('Resposta inválida.');
          const object = await store.savePage({ source, body: page.rawBody });
          entry.pages.push({ page: entry.pages.length + 1, ...object, observedAt: page.observedAt ?? now().toISOString(), requestId: page.requestId ?? null, records: page[listProperty].length, hasNextPage: Boolean(page.nextToken), ...(requestFilters ? { requestFilters } : {}) });
          if (requestFilters?.fulfillmentStatuses) entry.cancellationStatusStatus = 'partial';
          entry.recordsObserved += page[listProperty].length;
          partitionPages++;
          nextToken = page.nextToken;
          report({ source, status: 'page-saved', pages: entry.pages.length, recordsObserved: entry.recordsObserved });
        }
        // A partição precisa devolver pelo menos uma página e esgotar o cursor.
        return partitionPages > 0 && !nextToken;
      };
      let complete;
      if (source === 'orders') {
        complete = true;
        for (const fulfilledBy of ['AMAZON', 'MERCHANT']) {
          const pages = client.searchOrders({ ...(orderDateBasis === 'updated' ? { lastUpdatedAfter: window.from, lastUpdatedBefore: window.to } : { createdAfter: window.from, createdBefore: window.to }), marketplaceIds: [config.marketplaceId], maxResultsPerPage: 100, includedData: ['PROCEEDS', 'EXPENSE', 'PROMOTION', 'PACKAGES', 'FULFILLMENT'], fulfilledBy: [fulfilledBy] });
          // Proveniência gerada pelo coletor; não altera nem confia em campos do retorno.
          const partitionComplete = await savePages(pages, 'orders', { fulfilledBy: [fulfilledBy] });
          complete = complete && partitionComplete;
        }
        // Presença no filtro prova cancelamento; ausência não atribui estado ao pedido.
        let cancellationComplete = true;
        for (const fulfilledBy of ['AMAZON', 'MERCHANT']) {
          const requestFilters = { fulfilledBy: [fulfilledBy], fulfillmentStatuses: ['CANCELLED'] };
          const pages = client.searchOrders({ ...(orderDateBasis === 'updated' ? { lastUpdatedAfter: window.from, lastUpdatedBefore: window.to } : { createdAfter: window.from, createdBefore: window.to }), marketplaceIds: [config.marketplaceId], maxResultsPerPage: 100, includedData: ['PROCEEDS', 'EXPENSE', 'PROMOTION', 'PACKAGES', 'FULFILLMENT'], ...requestFilters });
          const partitionComplete = await savePages(pages, 'orders', requestFilters);
          cancellationComplete = cancellationComplete && partitionComplete;
        }
        if (cancellationComplete) entry.cancellationStatusStatus = 'complete';
        complete = complete && cancellationComplete;
      } else if (source === 'transactions') {
        complete = await savePages(client.listTransactions({ postedAfter: window.from, postedBefore: window.to, marketplaceId: config.marketplaceId }), 'transactions');
      } else {
        complete = await savePages(client.getInventorySummaries({ granularityType: 'Marketplace', granularityId: config.marketplaceId, marketplaceIds: [config.marketplaceId], details: true }), 'inventorySummaries');
      }
      // Orders exige as duas bases e as duas consultas CANCELLED, inclusive vazias.
      entry.status = complete ? 'api-pages-complete' : 'partial';
    } catch (error) {
      entry.status = entry.pages.length ? 'partial' : 'failed';
      entry.error = safeError(error);
    }
    entry.finishedAt = now().toISOString();
    report({ source, status: entry.status, pages: entry.pages.length });
  }
  const allComplete = run.sources.every(source => source.status === 'api-pages-complete');
  run.status = allComplete ? 'collected-awaiting-validation' : run.sources.some(source => source.pages.length) ? 'partial' : 'failed';
  run.finishedAt = now().toISOString();
  await store.saveRun(run);
  return run;
}

function safeError(error) {
  // Não persistir mensagens, URL ou corpo de erro de terceiros: podem conter credenciais/dados.
  const safeCodes = new Set(['RATE_LIMITED', 'HTTP_ERROR', 'TIMEOUT', 'NETWORK_ERROR', 'PAGINATION_LIMIT', 'PAGINATION_CYCLE', 'INVALID_RESPONSE', 'INVALID_PARAMETERS', 'UNEXPECTED_RESTRICTED_DATA', 'MISSING_CREDENTIALS', 'ENOSPC', 'EACCES']);
  return {
    code: safeCodes.has(error?.code) ? error.code : 'COLLECTION_FAILED',
    httpStatus: Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599 ? error.status : null
  };
}
