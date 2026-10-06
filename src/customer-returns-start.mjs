import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { userInfo } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadStoreConfig, readStoreCredentials, storeArguments } from './stores.mjs';
import { AmazonClient } from './amazon/client.mjs';
import { Repository } from './domain/repository.mjs';
import { syncCustomerReturnReports } from './customer-returns-collect.mjs';

const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
let repository;
try {
  if (process.platform !== 'win32' || /codexsandbox/i.test(userInfo().username)) throw new Error('Unavailable credentials context.');
  const selected = storeArguments(process.argv.slice(2));
  if (selected.args.length) throw new TypeError('Argumentos inválidos.');
  const config = await loadStoreConfig(selected.storeId), credentials = await readStoreCredentials(config);
  const rootDir = fileURLToPath(new URL('../data/', import.meta.url));
  repository = new Repository({ rootDir, dbPath: path.join(rootDir, 'synthamazon.sqlite'), stores: [config] });
  const client = new AmazonClient({ ...credentials, maxAttempts: 2, fetchImpl: (url, options) => fetch(url, { ...options, signal: AbortSignal.any([options.signal, abort.signal]) }) });
  for (let pass = 0; pass < 24 && !abort.signal.aborted; pass++) {
    const result = await syncCustomerReturnReports({ db: repository.db, client, config, maxCreate: pass === 0 ? 10 : 0,
      create: pass === 0, signal: abort.signal, report: progress => console.log(JSON.stringify(progress)) });
    console.log(JSON.stringify({ pass: pass + 1, ...result }));
    if (!result.pending) break;
    await sleep(20_000, undefined, { signal: abort.signal });
  }
} catch {
  if (!abort.signal.aborted) { console.error('RETURN_REPORT_COLLECTION_FAILED'); process.exitCode = 1; }
} finally { repository?.close(); }
