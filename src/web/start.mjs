import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStoreConfigs } from '../stores.mjs';
import { Repository } from '../domain/repository.mjs';
import { startWebServer } from './server.mjs';
import { startSalesAlertMonitor } from './sales-alert-monitor.mjs';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const dataRoot = path.join(projectRoot, 'data');
let repository;
let application;
let closing;

async function close() {
  if (closing) return closing;
  closing = (async () => {
    try {
      if (application?.server) {
        await new Promise((resolve, reject) => application.server.close(error => error ? reject(error) : resolve()));
      }
    } finally {
      repository?.close();
    }
  })();
  return closing;
}

function stop() {
  close().catch(() => {
    console.error('Não foi possível concluir o encerramento da interface local.');
    process.exitCode = 1;
  });
}

try {
  const stores = await loadStoreConfigs();
  const config = stores[0];
  repository = new Repository({ rootDir: dataRoot, dbPath: path.join(dataRoot, 'synthamazon.sqlite'), stores });
  const imported = await repository.loadWorkspace();
  if (imported.errors.length) {
    console.warn('Algumas coletas locais não puderam ser importadas; os dados exibidos podem estar incompletos.');
  }
  application = await startWebServer({ repository, config, rootDir: projectRoot, port: Number(process.env.SYNTHAMAZON_PORT || 0) });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const stopAlerts = startSalesAlertMonitor(repository);
  application.server.once('close', stopAlerts);
  console.log(`Abra a interface local: ${application.url}`);
  console.log('A interface usa as coletas já salvas. Encerre com Ctrl+C.');
} catch {
  console.error('Não foi possível iniciar a interface local. Confira a versão do Node e o acesso à pasta de dados.');
  await close().catch(() => {});
  process.exitCode = 1;
}
