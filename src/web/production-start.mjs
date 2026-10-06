import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadStoreConfigs } from '../stores.mjs';
import { createRepositoryWorkers } from './repository-worker.mjs';
import { startWebServer } from './server.mjs';
import { startSalesAlertMonitor } from './sales-alert-monitor.mjs';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const dataRoot = path.join(projectRoot, 'data');
let repository, application;
try {
  const stores = await loadStoreConfigs();
  const proxyPassword = (await readFile('/run/secrets/proxy-password', 'utf8')).trim();
  repository = await createRepositoryWorkers({ rootDir: dataRoot, stores });
  application = await startWebServer({ repository, config: stores[0], rootDir: projectRoot,
    port: 3000, production: { origin: process.env.SYNTHAMAZON_ORIGIN,
      ownerEmail: process.env.SYNTHAMAZON_OWNER_EMAIL, proxyPassword } });
  let stopping = false;
  const stop = () => {
    if (stopping) return; stopping = true;
    application.server.close(async () => { await repository.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 15_000).unref();
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  const stopAlerts = startSalesAlertMonitor(repository);
  application.server.once('close', stopAlerts);
  console.log('SynthAmazon pronto; acesso protegido pelo login Google.');
} catch {
  await repository?.close();
  console.error('PRODUCTION_START_FAILED'); process.exitCode = 1;
}
