import { fileURLToPath } from 'node:url';
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadStoreConfig, readStoreCredentials, storeArguments } from './stores.mjs';
import { Repository } from './domain/repository.mjs';
import { AmazonClient } from './amazon/client.mjs';
import { importStoreHistory } from './history-import.mjs';
import { pacedHistoryClient, resumableOrderClient } from './history-client.mjs';
import { SnapshotStore } from './storage.mjs';

let repository, lock, lockPath, statusPath;
const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
try {
  const selected = storeArguments(process.argv.slice(2));
  if (selected.args.length) throw new TypeError('Argumentos inválidos.');
  const config = await loadStoreConfig(selected.storeId);
  const credentials = await readStoreCredentials(config);
  const rootDir = fileURLToPath(new URL('../data/', import.meta.url));
  const directory = path.join(rootDir, config.storeId);
  await mkdir(directory, { recursive: true });
  lockPath = path.join(directory, 'history-import.lock');
  statusPath = path.join(directory, 'history-import-status.json');
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = JSON.parse(await readFile(lockPath, 'utf8'));
    if (!Number.isSafeInteger(existing.pid) || existing.pid < 1) throw new Error('Invalid lock.');
    let alive = true;
    try { process.kill(existing.pid, 0); } catch (failure) { if (failure.code === 'ESRCH') alive = false; }
    if (alive) throw Object.assign(new Error(), { code:'IMPORT_ALREADY_RUNNING' });
    await unlink(lockPath);
    lock = await open(lockPath, 'wx', 0o600);
  }
  await lock.writeFile(JSON.stringify({ pid:process.pid, storeId:config.storeId }));
  let requestedAt = new Date();
  try {
    const prior = JSON.parse(await readFile(statusPath, 'utf8'));
    if (prior.storeId === config.storeId && prior.status !== 'complete') {
      const end = prior.steps?.find(step => step.window)?.window?.to;
      const saved = prior.requestedAt ? Date.parse(prior.requestedAt) : end ? Date.parse(end) + 300_000 : NaN;
      if (Number.isFinite(saved)) requestedAt = new Date(saved);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  repository = new Repository({ rootDir, stores: [config] });
  const report = progress => console.log(JSON.stringify(progress));
  const api = new AmazonClient({ ...credentials, maxPages: 100, maxAttempts: 4, minRetryDelayMs: 200_000, maxRetryDelayMs: 300_000,
    fetchImpl: (url, options) => fetch(url, { ...options, signal: AbortSignal.any([options.signal, abort.signal]) }) });
  const paced = pacedHistoryClient(api, { signal:abort.signal, onWait:report });
  const client = resumableOrderClient(paced, { store: new SnapshotStore({ rootDir, storeId:config.storeId }), onPage:report });
  const result = await importStoreHistory({ repository, client, config, now:requestedAt, signal:abort.signal, report });
  if (result.status !== 'complete') process.exitCode = 1;
} catch (error) {
  console.error(/^[A-Z_0-9]+$/.test(error?.code) ? error.code : 'HISTORY_IMPORT_FAILED');
  if (lock && statusPath) {
    try {
      const status = JSON.parse(await readFile(statusPath, 'utf8'));
      status.status = abort.signal.aborted ? 'interrupted' : 'failed';
      status.stoppedAt = new Date().toISOString();
      await writeFile(statusPath, JSON.stringify(status, null, 2));
    } catch {}
  }
  process.exitCode = 1;
} finally {
  repository?.close();
  if (lock) { await lock.close(); await unlink(lockPath).catch(() => {}); }
}
