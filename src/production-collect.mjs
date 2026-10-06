import path from 'node:path';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadStoreConfig, readStoreCredentials, storeArguments } from './stores.mjs';
import { AmazonClient } from './amazon/client.mjs';
import { Repository } from './domain/repository.mjs';
import { SnapshotStore } from './storage.mjs';
import { runMonitorCycle, monitorErrorCode } from './monitor.mjs';
import { monitorIntervalMinutes } from './config.mjs';

const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
let repository;
let status, saveStatus;
try {
  if (!process.env.SYNTHAMAZON_SECRETS_DIR) throw new Error('Missing production secret directory.');
  const selected = storeArguments(process.argv.slice(2));
  if (selected.args.length) throw new TypeError('Invalid arguments.');
  const config = await loadStoreConfig(selected.storeId);
  const credentials = await readStoreCredentials(config);
  const rootDir = fileURLToPath(new URL('../data/', import.meta.url));
  const directory = path.join(rootDir, config.storeId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  status = { state: 'running', pid: process.pid, lastStartedAt: new Date().toISOString(),
    lastCompletedAt: null, nextRunAt: null, intervalMinutes: monitorIntervalMinutes(config),
    lastErrorCode: null, trackingChecked: 0, trackingFailed: 0 };
  saveStatus = async () => {
    const temporary = path.join(directory, 'monitor-status.production.tmp');
    await writeFile(temporary, JSON.stringify(status), { mode: 0o600 });
    await rename(temporary, path.join(directory, 'monitor-status.json'));
  };
  await saveStatus();
  repository = new Repository({ rootDir, stores: [config] });
  const loadWorkspace = repository.loadWorkspace.bind(repository);
  repository.loadWorkspace = () => loadWorkspace({ storeId: config.storeId });
  const client = new AmazonClient({ ...credentials, maxPages: 100,
    fetchImpl: (url, options) => fetch(url, { ...options,
      signal: AbortSignal.any([options?.signal, abort.signal].filter(Boolean)) }) });
  const result = await runMonitorCycle({ repository, client, config, sellerId: credentials.sellerId,
    store: new SnapshotStore({ rootDir, storeId: config.storeId }), signal: abort.signal,
    onError: code => console.error(`${config.storeId}: ${code}`) });
  if (!abort.signal.aborted) repository.syncRefundManagement({ storeId: config.storeId });
  Object.assign(status, result, { state: abort.signal.aborted ? 'stopped' : 'running',
    lastCompletedAt: new Date().toISOString(), nextRunAt: abort.signal.aborted ? null
      : new Date(Date.now() + status.intervalMinutes * 60_000).toISOString() });
  await saveStatus();
  console.log(`${config.storeId}: coleta concluída`);
} catch (error) {
  if (status && saveStatus) {
    Object.assign(status, { state: 'stopped', lastErrorCode: monitorErrorCode(error),
      nextRunAt: abort.signal.aborted ? null : new Date(Date.now() + status.intervalMinutes * 60_000).toISOString() });
    await saveStatus().catch(() => console.error('MONITOR_STATUS_WRITE_FAILED'));
  }
  console.error(monitorErrorCode(error)); process.exitCode = 1;
} finally { repository?.close(); }
