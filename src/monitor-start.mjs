// Local monitor; this entry point does not install a Windows startup task.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { userInfo } from 'node:os';
import { loadStoreConfig, readStoreCredentials, storeArguments } from './stores.mjs';
import { AmazonClient } from './amazon/client.mjs';
import { Repository } from './domain/repository.mjs';
import { startMonitor, monitorErrorCode } from './monitor.mjs';

const abortController = new AbortController();
let repository;
let monitor;
let stopPromise;
const stop = () => {
  if (!stopPromise) {
    abortController.abort();
    stopPromise = monitor?.stop().catch(error => { console.error(monitorErrorCode(error)); process.exitCode = 1; });
  }
  return stopPromise;
};

try {
  if (process.platform !== 'win32' || /codexsandbox/i.test(userInfo().username)) {
    throw Object.assign(new Error('CREDENTIALS_UNAVAILABLE'), { code: 'CREDENTIALS_UNAVAILABLE' });
  }
  const selected = storeArguments(process.argv.slice(2));
  if (selected.args.length) throw new TypeError('Argumentos inválidos.');
  const config = await loadStoreConfig(selected.storeId);
  // DPAPI is read only here, under the real Windows user, and kept in memory.
  const credentials = await readStoreCredentials(config);
  const rootDir = fileURLToPath(new URL('../data/', import.meta.url));
  repository = new Repository({ rootDir, dbPath: path.join(rootDir, 'synthamazon.sqlite'), stores: [config] });
  const client = new AmazonClient({ ...credentials, maxPages: 20,
    fetchImpl: (url, options) => fetch(url, { ...options, signal: AbortSignal.any([options.signal, abortController.signal]) }) });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  monitor = await startMonitor({ repository, client, config, rootDir, sellerId: credentials.sellerId, abortController,
    onError: code => console.error(code) });
  console.log(`Monitor local iniciado. Próxima atualização ${monitor.intervalMinutes} minutos após concluir a rodada; mantenha o computador ligado.`);
  await monitor.done;
} catch (error) {
  console.error(monitorErrorCode(error));
  process.exitCode = 1;
} finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  repository?.close();
}
