// Lightweight balance collection, scheduled separately for each connected ERP store.
// Reuses the exact dashboard calculation and credentials already held by the collector.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { loadStoreConfig, readStoreCredentials, storeArguments } from './stores.mjs';
import { AmazonClient } from './amazon/client.mjs';
import { collectAccountBalance } from './domain/account-balances.mjs';

const allowedStores = new Set(['hd-comercio', 'origem-comercio']);
const safeCodes = new Set(['HTTP_ERROR', 'RATE_LIMITED', 'TIMEOUT', 'NETWORK_ERROR', 'PAGINATION_LIMIT', 'PAGINATION_CYCLE', 'INVALID_RESPONSE', 'INVALID_SNAPSHOT', 'ABORTED', 'BALANCE_COLLECTION_FAILED']);
const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
// Bound the whole collection, including retries, rather than just each request.
const deadline = setTimeout(stop, 240_000);
const hardDeadline = setTimeout(() => { console.error('BALANCE_COLLECTION_TIMEOUT'); process.exit(1); }, 270_000);
let db;
try {
  const args = process.argv.slice(2);
  const selected = storeArguments(args);
  if (!process.env.SYNTHAMAZON_SECRETS_DIR || !args.includes('--store') || selected.args.length || !allowedStores.has(selected.storeId)) throw new Error('Invalid balance collection target');
  const config = await loadStoreConfig(selected.storeId);
  const credentials = await readStoreCredentials(config);
  db = new DatabaseSync(path.join(fileURLToPath(new URL('../data/', import.meta.url)), 'synthamazon.sqlite'));
  db.exec('PRAGMA busy_timeout=5000');
  const client = new AmazonClient({ ...credentials, maxPages: 100, maxAttempts: 2, maxRetryDelayMs: 10_000,
    fetchImpl: (url, options) => fetch(url, { ...options, signal: AbortSignal.any([options?.signal, controller.signal].filter(Boolean)) }) });
  const result = await collectAccountBalance({ db, client, config, signal: controller.signal });
  console.log(JSON.stringify({ storeId: selected.storeId, observedAt: result.observedAt, status: 'complete' }));
} catch (error) {
  console.error(safeCodes.has(error?.code) ? error.code : 'BALANCE_COLLECTION_FAILED');
  process.exitCode = 1;
} finally {
  clearTimeout(deadline); clearTimeout(hardDeadline);
  process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
  db?.close();
}
