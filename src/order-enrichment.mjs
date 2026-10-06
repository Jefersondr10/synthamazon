// Bounded, explicit enrichment of missing SAFE-T orders; never a history sync.
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SnapshotStore } from './storage.mjs';
import { normalizeOrders } from './domain/normalize.mjs';

export const MISSING_ORDER_IMPORT = 'missing-orders-only-v1';
const ORDER_ID = /^[A-Za-z0-9-]{1,80}$/;
const STORE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ORDERS = 100;
const DATASETS = ['PACKAGES', 'FULFILLMENT'];
const error = code => Object.assign(new Error(code), { code });

export function enrichmentErrorCode(value) {
  return new Set(['INVALID_PARAMETERS', 'INVALID_RESPONSE', 'INVALID_SNAPSHOT', 'UNEXPECTED_RESTRICTED_DATA',
    'INVALID_ENRICHMENT_MANIFEST', 'ENRICHMENT_CHECKPOINT_FAILED', 'ENRICHMENT_IMPORT_FAILED',
    'RATE_LIMITED', 'HTTP_ERROR', 'TIMEOUT', 'NETWORK_ERROR', 'MISSING_CREDENTIALS',
    'CREDENTIALS_NOT_FOUND', 'CREDENTIALS_UNAVAILABLE', 'ABORTED', 'EACCES', 'ENOSPC']).has(value?.code)
    ? value.code : 'ENRICHMENT_FAILED';
}

/** Reject mixed sources and fabricated query provenance before any import write. */
export function validateTargetedOrderRun(manifest) {
  if (manifest?.importMode === undefined) return false;
  const fail = () => { throw error('INVALID_ENRICHMENT_MANIFEST'); };
  if (manifest.importMode !== MISSING_ORDER_IMPORT || !UUID.test(manifest.id ?? '')
    || !STORE_ID.test(manifest.storeId ?? '') || manifest.storeId === 'all'
    || manifest.status !== 'targeted-observations' || !Array.isArray(manifest.sources) || manifest.sources.length !== 1) fail();
  const source = manifest.sources[0];
  if (source?.source !== 'orders' || source.operation !== 'getOrder' || source.status !== 'targeted-observations'
    || source.dateBasis !== 'order-id' || source.requestedWindow !== null
    || source.requestedFulfilledBy !== undefined || source.requestedFulfillmentStatuses !== undefined
    || !Array.isArray(source.includedData) || source.includedData.length !== DATASETS.length
    || DATASETS.some((value, index) => source.includedData[index] !== value)
    || !Array.isArray(source.requestedOrderIds) || source.requestedOrderIds.length < 1 || source.requestedOrderIds.length > MAX_ORDERS
    || source.requestedOrderIds.some(id => typeof id !== 'string' || !ORDER_ID.test(id))
    || new Set(source.requestedOrderIds).size !== source.requestedOrderIds.length || !Array.isArray(source.pages)) fail();
  const seen = new Set();
  for (const page of source.pages) {
    if (!page || !source.requestedOrderIds.includes(page.requestedOrderId) || seen.has(page.requestedOrderId)
      || page.requestFilters !== undefined || page.hasNextPage !== false || page.records !== 1) fail();
    seen.add(page.requestedOrderId);
  }
  return true;
}

/** The menu is the source of candidates; no creation-date or status restriction. */
export function selectMissingSafeTOrders(repository, { storeId, maxOrders = MAX_ORDERS } = {}) {
  if (!STORE_ID.test(storeId ?? '') || storeId === 'all' || !Number.isInteger(maxOrders) || maxOrders < 1 || maxOrders > MAX_ORDERS) {
    throw error('INVALID_PARAMETERS');
  }
  const existing = new Set(repository.db.prepare("SELECT source_id FROM entities WHERE store_id=? AND source='orders'").all(storeId).map(row => row.source_id));
  const missing = new Set();
  let offset = 0;
  while (true) {
    const page = repository.safeTCases({ storeId, limit: 500, offset });
    for (const row of page.items) {
      if (row.storeId !== storeId || !ORDER_ID.test(row.orderId ?? '')) throw error('INVALID_RESPONSE');
      if (!existing.has(row.orderId)) missing.add(row.orderId);
    }
    if (!page.hasMore) break;
    if (!page.items.length) throw error('INVALID_RESPONSE');
    offset += page.items.length;
  }
  return { orderIds: [...missing].sort().slice(0, maxOrders), missingCount: missing.size, maxOrders };
}

function instant(now) {
  const date = now();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw error('INVALID_PARAMETERS');
  return date.toISOString();
}
function directory(rootDir, storeId) { return path.join(path.resolve(rootDir), storeId, 'order-enrichment'); }
async function checkpoint(rootDir, manifest) {
  const dir = directory(rootDir, manifest.storeId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, `${manifest.id}.json`), temporary = `${target}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(JSON.stringify(manifest), 'utf8');
    await file.sync(); await file.close(); file = null;
    await rename(temporary, target);
  } finally { await file?.close(); await unlink(temporary).catch(() => {}); }
}

async function publish({ repository, store, rootDir, manifest }) {
  validateTargetedOrderRun(manifest);
  // Runs are immutable. A crash after publication is recovered by checking that
  // the existing bytes describe the same manifest, then idempotently importing.
  try { await store.saveRun(manifest); }
  catch (failure) {
    if (failure.code !== 'EEXIST') throw failure;
    const existing = JSON.parse(await readFile(path.join(rootDir, manifest.storeId, 'runs', `${manifest.id}.json`), 'utf8'));
    if (JSON.stringify(existing) !== JSON.stringify(manifest)) throw error('INVALID_ENRICHMENT_MANIFEST');
  }
  const result = await repository.importRun(manifest);
  await unlink(path.join(directory(rootDir, manifest.storeId), `${manifest.id}.json`));
  return result;
}

/** Import saved checkpoints without contacting Amazon or reading credentials. */
export async function recoverOrderEnrichment({ repository, config, rootDir, store = new SnapshotStore({ rootDir, storeId: config.storeId }) }) {
  if (!STORE_ID.test(config.storeId ?? '') || config.storeId === 'all') throw error('INVALID_PARAMETERS');
  let files;
  try { files = await readdir(directory(rootDir, config.storeId)); }
  catch (failure) { if (failure.code === 'ENOENT') return { recoveredRuns: 0, insertedOrders: 0 }; throw failure; }
  const result = { recoveredRuns: 0, insertedOrders: 0 };
  for (const name of files.filter(name => name.endsWith('.json') && UUID.test(name.slice(0, -5))).sort()) {
    const manifest = JSON.parse(await readFile(path.join(directory(rootDir, config.storeId), name), 'utf8'));
    if (manifest.storeId !== config.storeId || manifest.id !== name.slice(0, -5)) throw error('INVALID_ENRICHMENT_MANIFEST');
    const imported = await publish({ repository, store, rootDir, manifest });
    result.recoveredRuns++; result.insertedOrders += imported.insertedOrders ?? 0;
  }
  return result;
}

/** Serial reads only, at most 100, with durable progress and aggregate output. */
export async function collectMissingSafeTOrders({ repository, client, config, rootDir,
  store = new SnapshotStore({ rootDir, storeId: config.storeId }), now = () => new Date(),
  sleep = delay, signal, report = () => {}, maxOrders = MAX_ORDERS }) {
  const selection = selectMissingSafeTOrders(repository, { storeId: config.storeId, maxOrders });
  const result = { selected: selection.orderIds.length, missingBefore: selection.missingCount, attempted: 0,
    collected: 0, failed: 0, skippedExisting: 0, insertedOrders: 0, interrupted: false, stoppedEarly: false, errorCounts: {} };
  if (!selection.orderIds.length) return result;
  const startedAt = instant(now);
  const source = { source: 'orders', operation: 'getOrder', apiVersion: '2026-01-01', includedData: DATASETS,
    requestedOrderIds: selection.orderIds, dateBasis: 'order-id', requestedWindow: null,
    status: 'targeted-observations', startedAt, finishedAt: startedAt, pages: [], failures: [], recordsObserved: 0 };
  const manifest = { id: randomUUID(), schemaVersion: 1, importMode: MISSING_ORDER_IMPORT,
    storeId: config.storeId, marketplaceId: config.marketplaceId, status: 'targeted-observations',
    startedAt, finishedAt: startedAt, outcome: 'interrupted', sources: [source] };
  validateTargetedOrderRun(manifest);
  await checkpoint(rootDir, manifest);
  const exists = repository.db.prepare("SELECT 1 FROM entities WHERE store_id=? AND source='orders' AND source_id=?");
  for (const orderId of selection.orderIds) {
    if (signal?.aborted) { result.interrupted = true; break; }
    if (exists.get(config.storeId, orderId)) { result.skippedExisting++; continue; }
    if (result.attempted) {
      try { await sleep(2100, undefined, { signal }); }
      catch (failure) { if (!signal?.aborted) throw failure; result.interrupted = true; break; }
    }
    if (signal?.aborted) { result.interrupted = true; break; }
    result.attempted++;
    try {
      const response = await client.getOrder(orderId, { includedData: [...DATASETS] });
      const observedAt = instant(now);
      if (response?.order?.orderId !== orderId || typeof response.rawBody !== 'string') throw error('INVALID_RESPONSE');
      const [normalized] = normalizeOrders(response.rawBody, { storeId: config.storeId, observedAt, envelope: 'individual', expectedOrderId: orderId });
      if (normalized.marketplaceId && normalized.marketplaceId !== config.marketplaceId) throw error('INVALID_RESPONSE');
      const saved = await store.savePage({ source: 'orders', body: response.rawBody });
      source.pages.push({ ...saved, page: source.pages.length + 1, requestedOrderId: orderId, observedAt,
        requestId: response.requestId ?? null, records: 1, hasNextPage: false });
      source.recordsObserved++; result.collected++;
    } catch (failure) {
      result.failed++;
      const code = signal?.aborted ? 'ABORTED' : enrichmentErrorCode(failure);
      result.errorCounts[code] = (result.errorCounts[code] ?? 0) + 1;
      result.stoppedEarly = [401, 403].includes(failure?.status);
      source.failures.push({ orderId, code,
        httpStatus: Number.isInteger(failure?.status) && failure.status >= 100 && failure.status <= 599 ? failure.status : null });
    }
    manifest.finishedAt = source.finishedAt = instant(now);
    // A checkpoint failure stops further network work. Previously committed
    // checkpoints/raw objects remain recoverable without mutable run manifests.
    try { await checkpoint(rootDir, manifest); }
    catch { throw error('ENRICHMENT_CHECKPOINT_FAILED'); }
    report({ ...result });
    if (result.stoppedEarly) break;
  }
  result.interrupted ||= Boolean(signal?.aborted);
  manifest.outcome = result.interrupted ? 'interrupted' : result.failed ? (result.collected ? 'partial' : 'failed') : 'complete';
  manifest.finishedAt = source.finishedAt = instant(now);
  await checkpoint(rootDir, manifest);
  try {
    const imported = await publish({ repository, store, rootDir, manifest });
    result.insertedOrders = imported.insertedOrders ?? 0;
    result.skippedExisting += imported.skippedExistingOrders ?? 0;
  } catch { throw error('ENRICHMENT_IMPORT_FAILED'); }
  return result;
}
