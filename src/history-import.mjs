import { mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { collectPilot } from './pilot.mjs';
import { SnapshotStore } from './storage.mjs';
import { syncCustomerReturnReports } from './customer-returns-collect.mjs';
import { collectAccountBalance } from './domain/account-balances.mjs';
import { collectMissingSafeTOrders, recoverOrderEnrichment } from './order-enrichment.mjs';
import { collectSafeTClaimIds } from './domain/safe-t-claims.mjs';

export function historyWindows(historyStart, now = new Date()) {
  const start = Date.parse(historyStart), end = now.getTime() - 300_000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new TypeError('Período inválido.');
  const windows = [];
  for (let from = start; from < end; from += 30 * 86_400_000) {
    windows.push({ from: new Date(from).toISOString(), to: new Date(Math.min(from + 30 * 86_400_000, end)).toISOString() });
  }
  return windows.reverse();
}

export async function importStoreHistory({ repository, client, config, now = new Date(), report = () => {}, signal }) {
  const store = new SnapshotStore({ rootDir: repository.rootDir, storeId: config.storeId });
  const progress = { storeId: config.storeId, pid: process.pid, requestedAt: now.toISOString(), startedAt: new Date().toISOString(), status: 'running', steps: [], errors: [] };
  const directory = path.join(repository.rootDir, config.storeId);
  await mkdir(directory, { recursive: true });
  const publish = async step => {
    signal?.throwIfAborted();
    progress.steps.push(step);
    const target = path.join(directory, 'history-import-status.json');
    await writeFile(`${target}.tmp`, JSON.stringify(progress, null, 2));
    await rename(`${target}.tmp`, target);
    report(step);
  };
  const safeError = error => /^[A-Z_0-9]+$/.test(error?.code) ? error.code : 'IMPORT_FAILED';
  const supplementary = async (stage, work) => {
    try {
      const result = await work();
      if (result?.failed) progress.errors.push({ stage, code:'PARTIAL', count:result.failed });
      await publish({ stage, result }); return result;
    }
    catch (error) { const code = safeError(error); progress.errors.push({ stage, code }); await publish({ stage, code }); }
  };
  const collect = async (source, window) => {
    signal?.throwIfAborted();
    if (window && repository.db.prepare(`SELECT 1 FROM coverage WHERE store_id=? AND source=? AND date_basis=? AND status='api-pages-complete' AND from_at<=? AND to_at>=? LIMIT 1`)
      .get(config.storeId, source, source === 'orders' ? 'created' : 'posted', window.from, window.to)) {
      await publish({ source, window, status: 'already-imported' }); return;
    }
    const run = await collectPilot({ client, config, store, window, sources: [source] });
    await repository.importRun(run);
    const entry = run.sources[0];
    if (entry.status !== 'api-pages-complete') progress.errors.push({ source, window, ...(entry.error ?? { code:'PARTIAL' }) });
    await publish({ source, window, status: entry.status, records: entry.recordsObserved, ...(entry.error ? { error: entry.error } : {}) });
  };
  await supplementary('return-reports-requested', () => syncCustomerReturnReports({ db: repository.db, client, config, maxCreate: 10 }));
  await collect('fba-inventory');
  const windows = historyWindows(config.historyStart, now);
  // Publish finance and returns first; full order history has a much lower API quota.
  for (const window of windows) {
    await collect('transactions', window);
    repository.syncRefundManagement({ storeId: config.storeId });
  }
  await supplementary('account-balance', () => collectAccountBalance({ db: repository.db, client, config }));
  for (let pass = 0; pass < 24; pass++) {
    const result = await supplementary('return-reports-imported', () => syncCustomerReturnReports({ db: repository.db, client, config, create: false }));
    if (!result?.pending) break;
    if (pass < 23) await sleep(20_000);
    else progress.errors.push({ stage:'return-reports-imported', code:'REPORTS_PENDING' });
  }
  await recoverOrderEnrichment({ repository, config, rootDir: repository.rootDir });
  for (;;) {
    const result = await supplementary('missing-refunded-orders', () => collectMissingSafeTOrders({ repository, client, config, rootDir: repository.rootDir, maxOrders: 100 }));
    if (!result || result.failed || result.insertedOrders === 0 || result.missingBefore <= result.selected) break;
  }
  await supplementary('safe-t-identifiers', () => collectSafeTClaimIds({ db: repository.db, client, config }));
  for (const window of windows) await collect('orders', window);
  repository.syncRefundManagement({ storeId: config.storeId });
  progress.status = progress.errors.length ? 'partial' : 'complete';
  progress.finishedAt = new Date().toISOString();
  await publish({ stage: 'finished', status: progress.status });
  return progress;
}
