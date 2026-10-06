import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { SnapshotStore } from './storage.mjs';
import { normalizeTransactions } from './domain/normalize.mjs';

export const REFUND_HISTORY_IMPORT = 'refund-history-by-order-v2';
const LEGACY_REFUND_HISTORY_IMPORT = 'refund-history-by-order-v1';
const ORDER = /^\d{3}-\d{7}-\d{7}$/;
const fail = () => { throw Object.assign(new Error('INVALID_ENRICHMENT_MANIFEST'), { code: 'INVALID_ENRICHMENT_MANIFEST' }); };

export function validateRefundHistoryRun(manifest) {
  if (![REFUND_HISTORY_IMPORT, LEGACY_REFUND_HISTORY_IMPORT].includes(manifest?.importMode)) return false;
  const source = manifest.sources?.[0];
  if (manifest.status !== 'targeted-observations' || manifest.sources?.length !== 1
    || source?.source !== 'transactions' || source.operation !== 'listTransactions'
    || source.apiVersion !== '2024-06-19' || source.status !== 'targeted-observations'
    || source.dateBasis !== 'order-id' || source.requestedWindow !== null
    || !ORDER.test(source.requestedOrderId ?? '') || !Array.isArray(source.pages) || !source.pages.length
    || source.relatedIdentifierName !== 'ORDER_ID' || source.relatedIdentifierValue !== source.requestedOrderId) fail();
  for (const [index, page] of source.pages.entries()) {
    if (page.page !== index + 1 || page.requestedOrderId !== source.requestedOrderId
      || page.hasNextPage !== (index < source.pages.length - 1) || page.requestFilters !== undefined
      || !Number.isInteger(page.records) || page.records < 0) fail();
  }
  return true;
}

export function refundHistoryRecords(records, importMode) {
  return records.filter(item => item.type === 'Refund' || importMode === REFUND_HISTORY_IMPORT && item.type === 'Adjustment');
}

/** Import refunds and adjustments, retaining the original raw bytes and explicit
 * release references. A targeted query never claims date-range coverage.
 */
export async function collectMissingRefundHistory({ repository, client, config,
  store = new SnapshotStore({ rootDir: repository.rootDir, storeId: config.storeId }),
  now = () => new Date(), sleep = delay, signal, maxOrders = 25, orderIds = null }) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(config?.storeId ?? '') || config.storeId === 'all'
    || !Number.isInteger(maxOrders) || maxOrders < 1 || maxOrders > 100
    || orderIds !== null && (!Array.isArray(orderIds) || !orderIds.length || orderIds.length > 100
      || orderIds.some(id => typeof id !== 'string' || !ORDER.test(id)))) fail();
  const db = repository.db, timestamp = new Date(now()).toISOString();
  db.exec(`CREATE TABLE IF NOT EXISTS refund_history_queries (
    store_id TEXT NOT NULL,order_id TEXT NOT NULL,checked_at TEXT NOT NULL,run_id TEXT NOT NULL,
    PRIMARY KEY(store_id,order_id));
    CREATE TABLE IF NOT EXISTS refund_history_query_versions (
    store_id TEXT NOT NULL,order_id TEXT NOT NULL,version INTEGER NOT NULL,
    PRIMARY KEY(store_id,order_id));`);
  const cutoff = new Date(Date.parse(timestamp) - 86400000).toISOString();
  const candidates = db.prepare(`SELECT r.order_id FROM refund_management r
    LEFT JOIN refund_history_queries q ON q.store_id=r.store_id AND q.order_id=r.order_id
    LEFT JOIN refund_history_query_versions v ON v.store_id=r.store_id AND v.order_id=r.order_id
    WHERE r.store_id=? AND (COALESCE(v.version,1)<2 OR r.workflow_state='active'
      OR json_extract(r.source_json,'$.refund.dateKnown')=0 OR json_extract(r.source_json,'$.refund.firstEventAt') IS NULL)
    AND COALESCE(json_extract(r.source_json,'$.financialEligibility.included'),1)<>0
    AND (? IS NULL OR r.order_id IN (SELECT value FROM json_each(?)))
    AND (COALESCE(v.version,1)<2 OR q.checked_at IS NULL OR q.checked_at<=?)
    ORDER BY COALESCE(q.checked_at,''),r.order_id LIMIT ?`)
    .all(config.storeId, orderIds === null ? null : JSON.stringify(orderIds), orderIds === null ? null : JSON.stringify(orderIds), cutoff, maxOrders)
    .filter(row => ORDER.test(row.order_id));
  const result = { selected: candidates.length, checked: 0, recoveredDates: 0, failed: 0, interrupted: false };
  let requested = false;
  for (const { order_id: orderId } of candidates) {
    if (signal?.aborted) { result.interrupted = true; break; }
    try {
      if (requested) await sleep(2100, undefined, { signal });
      requested = true;
      const source = { source: 'transactions', operation: 'listTransactions', apiVersion: '2024-06-19',
        requestedOrderId: orderId, relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: orderId,
        dateBasis: 'order-id', requestedWindow: null, status: 'targeted-observations',
        startedAt: new Date(now()).toISOString(), pages: [] };
      for await (const page of client.listTransactions({ relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: orderId, marketplaceId: config.marketplaceId })) {
        if (signal?.aborted) throw new Error('ABORTED');
        if (!Array.isArray(page.transactions) || typeof page.rawBody !== 'string') fail();
        const normalized = normalizeTransactions(page.rawBody, { storeId: config.storeId, observedAt: new Date(now()).toISOString() });
        if (normalized.length !== page.transactions.length || refundHistoryRecords(normalized, REFUND_HISTORY_IMPORT)
          .some(item => item.orderIds.length !== 1 || item.orderIds[0] !== orderId
            || item.marketplaceId && item.marketplaceId !== config.marketplaceId)) fail();
        const saved = await store.savePage({ source: 'transactions', body: page.rawBody });
        source.pages.push({ ...saved, page: source.pages.length + 1, requestedOrderId: orderId,
          observedAt: new Date(now()).toISOString(), requestId: page.requestId ?? null,
          records: page.transactions.length, hasNextPage: Boolean(page.nextToken) });
        if (page.nextToken) await sleep(2100, undefined, { signal });
      }
      if (signal?.aborted) throw new Error('ABORTED');
      source.finishedAt = new Date(now()).toISOString();
      const manifest = { id: randomUUID(), importMode: REFUND_HISTORY_IMPORT, schemaVersion: 1,
        storeId: config.storeId, marketplaceId: config.marketplaceId, status: 'targeted-observations',
        startedAt: source.startedAt, finishedAt: source.finishedAt, sources: [source] };
      validateRefundHistoryRun(manifest);
      // Persist before import so a crash can be recovered by loadWorkspace.
      await store.saveRun(manifest);
      await repository.importRun(manifest);
      repository.syncRefundManagement({ storeId: config.storeId, now: source.finishedAt });
      const updated = db.prepare('SELECT source_json FROM refund_management WHERE store_id=? AND order_id=?').get(config.storeId, orderId);
      if (updated && JSON.parse(updated.source_json).refund.dateKnown) result.recoveredDates++;
      db.prepare(`INSERT INTO refund_history_queries VALUES(?,?,?,?) ON CONFLICT(store_id,order_id)
        DO UPDATE SET checked_at=excluded.checked_at,run_id=excluded.run_id`).run(config.storeId, orderId, source.finishedAt, manifest.id);
      db.prepare(`INSERT INTO refund_history_query_versions VALUES(?,?,2) ON CONFLICT(store_id,order_id)
        DO UPDATE SET version=excluded.version`).run(config.storeId, orderId);
      result.checked++;
    } catch (error) {
      if (signal?.aborted) { result.interrupted = true; break; }
      result.failed++;
      if ([401,403].includes(error?.status)) break;
    }
  }
  return result;
}
