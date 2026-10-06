// Local monitor: runs only while this process and this computer remain on.
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { collectPilot } from './pilot.mjs';
import { makeWindow, monitorIntervalMinutes } from './config.mjs';
import { normalizeOrders } from './domain/normalize.mjs';
import { SnapshotStore } from './storage.mjs';
import { syncCustomerReturnReports } from './customer-returns-collect.mjs';
import { collectMissingSafeTOrders, recoverOrderEnrichment } from './order-enrichment.mjs';
import { collectAccountBalance } from './domain/account-balances.mjs';
import { collectSafeTClaimIds } from './domain/safe-t-claims.mjs';
import { collectMissingRefundHistory } from './refund-history-enrichment.mjs';

const DAY = 86_400_000;
const TRACKING_DELAY_MS = 2_100;
const BATCH_SIZE = 50;
const SAFE_CODES = new Set(['RATE_LIMITED', 'HTTP_ERROR', 'TIMEOUT', 'NETWORK_ERROR', 'PAGINATION_LIMIT', 'PAGINATION_CYCLE', 'INVALID_RESPONSE', 'INVALID_PARAMETERS', 'INVALID_SNAPSHOT', 'UNEXPECTED_RESTRICTED_DATA', 'MISSING_CREDENTIALS', 'CREDENTIALS_NOT_FOUND', 'CREDENTIALS_UNAVAILABLE', 'ENOSPC', 'EACCES', 'COLLECTION_PARTIAL', 'IMPORT_FAILED', 'MONITOR_ALREADY_RUNNING', 'MONITOR_LOCK_BUSY', 'MONITOR_LOCK_INVALID', 'MONITOR_FAILED', 'INVALID_CONFIG']);

export function monitorErrorCode(error) { return SAFE_CODES.has(error?.code) ? error.code : 'MONITOR_FAILED'; }
function failure(code) { return Object.assign(new Error(code), { code }); }
function clock(now) {
  const value = new Date(now());
  if (!Number.isFinite(value.getTime())) throw failure('INVALID_CONFIG');
  return value;
}
function checkConfig(config) {
  if (!config || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(config.storeId ?? '') || !Number.isFinite(Date.parse(config.historyStart))) throw failure('INVALID_CONFIG');
}
function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
function emit(onError, code) { try { onError(code); } catch {} }

async function atomicStatus(filename, status) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(`${JSON.stringify(status, null, 2)}\n`, 'utf8');
    await file.sync();
    await file.close(); file = undefined;
    await rename(temporary, filename);
  } finally {
    await file?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

async function acquireLock(filename, { isProcessAlive, now }) {
  const ownership = { pid: process.pid, token: randomUUID(), startedAt: clock(now).toISOString() };
  const create = async () => {
    const file = await open(filename, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(ownership), 'utf8'); await file.sync(); }
    catch (error) { await file.close(); await unlink(filename).catch(() => {}); throw error; }
    await file.close();
  };
  try { await create(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Serialize stale-lock recovery so one starter cannot delete another's lock.
    const recoveryPath = `${filename}.recovery`;
    let recovery;
    try { recovery = await open(recoveryPath, 'wx', 0o600); }
    catch (recoveryError) { if (recoveryError.code === 'EEXIST') throw failure('MONITOR_LOCK_BUSY'); throw recoveryError; }
    try {
      let previous;
      try { previous = JSON.parse(await readFile(filename, 'utf8')); }
      catch (readError) { if (readError.code !== 'ENOENT') throw failure('MONITOR_LOCK_INVALID'); }
      if (previous) {
        if (!Number.isInteger(previous.pid) || previous.pid <= 0) throw failure('MONITOR_LOCK_INVALID');
        if (await isProcessAlive(previous.pid)) throw failure('MONITOR_ALREADY_RUNNING');
        await unlink(filename);
      }
      try { await create(); }
      catch (createError) { if (createError.code === 'EEXIST') throw failure('MONITOR_ALREADY_RUNNING'); throw createError; }
    } finally {
      await recovery.close().catch(() => {});
      await unlink(recoveryPath).catch(() => {});
    }
  }
  return async () => {
    try {
      const current = JSON.parse(await readFile(filename, 'utf8'));
      if (current.token === ownership.token) await unlink(filename);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
}

/** One bounded pass. Tracking writes observations only, never financial/order entities. */
export async function runMonitorCycle({ repository, client, config, store, sellerId,
  now = () => new Date(), sleep = delay, collector = collectPilot,
  tracking, signal, onError = () => {} }) {
  checkConfig(config);
  const result = { trackingChecked: 0, trackingFailed: 0, lastErrorCode: null };
  const recordError = error => { result.lastErrorCode = monitorErrorCode(error); emit(onError, result.lastErrorCode); };
  const startedAt = clock(now);
  for (const [source, days] of [['orders', 7], ['transactions', 30]]) {
    if (signal?.aborted) return result;
    try {
      const to = new Date(startedAt.getTime() - 5 * 60_000);
      const from = new Date(Math.max(Date.parse(config.historyStart), to.getTime() - days * DAY));
      const window = makeWindow({ from: from.toISOString(), to: to.toISOString(), now: startedAt, historyStart: config.historyStart });
      const run = await collector({ client, config, store, sellerId, window, sources: [source], ...(source === 'orders' ? { orderDateBasis: 'updated' } : {}), now: () => clock(now) });
      if (!signal?.aborted && run?.status !== 'collected-awaiting-validation') {
        recordError({ code: run?.sources?.find(item => item.error)?.error?.code ?? 'COLLECTION_PARTIAL' });
      }
    } catch (error) { if (!signal?.aborted) recordError(error); }
  }
  if (signal?.aborted) return result;
  try {
    const imported = await repository.loadWorkspace();
    if (imported?.errors?.length) recordError({ code: 'IMPORT_FAILED' });
  } catch { recordError({ code: 'IMPORT_FAILED' }); }
  if (signal?.aborted) return result;
  // A refund may arrive long after an order's last update, outside the recent
  // orders window. Hydrate missing orders without replacing existing history.
  try {
    const options = { repository, client, config, rootDir: repository.rootDir, now: () => clock(now), sleep, signal };
    await recoverOrderEnrichment(options);
    const enriched = await collectMissingSafeTOrders(options);
    if (enriched.failed) recordError({ code: 'COLLECTION_PARTIAL' });
  } catch { recordError({ code: 'COLLECTION_PARTIAL' }); }
  if (signal?.aborted) return result;
  if (typeof client.listTransactions === 'function') {
    try {
      const history = await collectMissingRefundHistory({ repository, client, config, now: () => clock(now), sleep, signal });
      result.refundDatesRecovered = history.recoveredDates;
      if (history.failed) recordError({ code: 'COLLECTION_PARTIAL' });
    } catch (error) { if (!signal?.aborted) recordError(error); }
  }
  if (signal?.aborted) return result;
  if (typeof client.listFinancialEventsByOrderId === 'function') {
    try {
      const claims = await collectSafeTClaimIds({ db: repository.db, client, config, now: () => clock(now), sleep, signal });
      result.safeTClaimsChecked = claims.checked;
      result.safeTClaimsWithIds = claims.withIds;
      if (claims.failed) recordError({ code: claims.errorCodes[0] ?? 'COLLECTION_PARTIAL' });
    } catch (error) { if (!signal?.aborted) recordError(error); }
  }
  if (signal?.aborted) return result;
  if (typeof client.listFinancialEventGroups === 'function') {
    try { await collectAccountBalance({ db: repository.db, client, config, now: () => clock(now), signal }); }
    catch (error) { recordError(error); }
  }
  if (signal?.aborted) return result;
  if (typeof client.getInventorySummaries === 'function') {
    try {
      const run = await collector({ client, config, store, sellerId, sources: ['fba-inventory'], now: () => clock(now) });
      if (run?.status !== 'collected-awaiting-validation') recordError({ code: 'COLLECTION_PARTIAL' });
      const imported = await repository.loadWorkspace();
      if (imported?.errors?.length) recordError({ code: 'IMPORT_FAILED' });
    } catch (error) { recordError(error); }
  }
  if (signal?.aborted) return result;
  // The reports pipeline queues jobs asynchronously. It does not block tracking
  // while Amazon generates documents and never stores raw customer report text.
  if (typeof client.createReturnReport === 'function') {
    try { await syncCustomerReturnReports({ db: repository.db, client, config, now: () => clock(now), signal }); }
    catch { recordError({ code: 'COLLECTION_PARTIAL' }); }
  }
  try {
    const persistence = tracking ?? await import('./domain/returns.mjs');
    persistence.ensureReturnSchema(repository.db);
    const cutoff = new Date(startedAt.getTime() - 120 * DAY).toISOString();
    const end = startedAt.toISOString();
    const base = `FROM entities WHERE store_id=? AND source='orders'
      AND json_extract(payload_json,'$.fulfillmentMode')='DBA'
      AND json_array_length(payload_json,'$.packages')>0
      AND json_extract(payload_json,'$.createdAt')>=?
      AND json_extract(payload_json,'$.createdAt')<=?`;
    const lastId = repository.db.prepare(`SELECT MAX(source_id) AS id ${base}`).get(config.storeId, cutoff, end)?.id;
    if (!lastId) return result;
    const select = repository.db.prepare(`SELECT source_id AS orderId ${base} AND source_id>? AND source_id<=? ORDER BY source_id LIMIT ?`);
    let cursor = '';
    let attempted = false;
    while (cursor < lastId && !signal?.aborted) {
      const batch = select.all(config.storeId, cutoff, end, cursor, lastId, BATCH_SIZE);
      if (!batch.length) break;
      for (const { orderId } of batch) {
        if (signal?.aborted) return result;
        if (attempted) {
          try { await sleep(TRACKING_DELAY_MS, undefined, { signal }); }
          catch (error) { if (signal?.aborted) return result; throw error; }
        }
        if (signal?.aborted) return result;
        attempted = true;
        result.trackingChecked++;
        try {
          const response = await client.getOrder(orderId, { includedData: ['PACKAGES'] });
          if (signal?.aborted) return result;
          if (response?.order?.orderId !== orderId) throw failure('INVALID_RESPONSE');
          const observedAt = clock(now).toISOString();
          // Only packages cross into tracking persistence; money is never reserialized into entities.
          const rawBody = JSON.stringify({ orders: [{ orderId, orderItems: [], packages: response.order.packages }] });
          const packages = normalizeOrders(rawBody, { storeId: config.storeId, observedAt })[0].packages;
          await persistence.recordTrackingObservation(repository.db, { storeId: config.storeId, orderId, observedAt, packages });
        } catch (error) {
          if (signal?.aborted) return result;
          result.trackingFailed++;
          recordError(error);
        }
      }
      cursor = batch.at(-1).orderId;
    }
  } catch (error) { if (!signal?.aborted) recordError(error); }
  return result;
}

/** Starts immediately. The configured interval starts after the previous pass finishes. */
export async function startMonitor({ repository, client, config, rootDir, store, sellerId,
  now = () => new Date(), sleep = delay, collector = collectPilot, tracking,
  isProcessAlive = processAlive, abortController = new AbortController(), onError = () => {} }) {
  checkConfig(config);
  if (typeof rootDir !== 'string' || !rootDir || !repository?.db || typeof client?.getOrder !== 'function') throw failure('INVALID_CONFIG');
  const intervalMinutes = monitorIntervalMinutes(config);
  const directory = path.resolve(rootDir, config.storeId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const statusPath = path.join(directory, 'monitor-status.json');
  const release = await acquireLock(path.join(directory, 'monitor.lock'), { isProcessAlive, now });
  const status = { state: 'running', pid: process.pid, lastStartedAt: null, lastCompletedAt: null,
    nextRunAt: null, intervalMinutes, lastErrorCode: null, trackingChecked: 0, trackingFailed: 0 };
  const snapshotStore = store ?? new SnapshotStore({ rootDir, storeId: config.storeId });
  let stopping = false;
  const done = (async () => {
    try {
      while (!stopping && !abortController.signal.aborted) {
        status.lastStartedAt = clock(now).toISOString();
        status.nextRunAt = null;
        await atomicStatus(statusPath, status);
        const result = await runMonitorCycle({ repository, client, config, store: snapshotStore, sellerId, now, sleep, collector, tracking, signal: abortController.signal, onError });
        Object.assign(status, result);
        if (stopping || abortController.signal.aborted) break;
        status.lastCompletedAt = clock(now).toISOString();
        status.nextRunAt = new Date(Date.parse(status.lastCompletedAt) + intervalMinutes * 60_000).toISOString();
        await atomicStatus(statusPath, status);
        try { await sleep(intervalMinutes * 60_000, undefined, { signal: abortController.signal }); }
        catch (error) { if (!abortController.signal.aborted) throw error; }
      }
    } catch (error) {
      status.lastErrorCode = monitorErrorCode(error);
      emit(onError, status.lastErrorCode);
      throw failure(status.lastErrorCode);
    } finally {
      status.state = 'stopped';
      status.nextRunAt = null;
      try { await atomicStatus(statusPath, status); }
      finally { await release(); }
    }
  })();
  done.catch(() => {});
  return { statusPath, intervalMinutes, done, stop: async () => { stopping = true; abortController.abort(); await done; } };
}
