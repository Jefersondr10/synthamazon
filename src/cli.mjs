import { fileURLToPath } from 'node:url';
import { userInfo } from 'node:os';
import { getCredentials, makeWindow } from './config.mjs';
import { loadStoreConfig, storeArguments, storeVaultPath } from './stores.mjs';
import { collectPilot, SOURCES } from './pilot.mjs';
import { readPilotStatus } from './status.mjs';

try {
  const [command = 'check', ...rawArgs] = process.argv.slice(2);
  const { storeId, args } = storeArguments(rawArgs);
  if (!['check', 'collect', 'setup'].includes(command)) throw new Error('Comando inválido.');
  const config = await loadStoreConfig(storeId);
  if (command === 'setup') {
    if (args.length) throw new Error('Argumentos inválidos.');
    if (process.platform !== 'win32' || /codexsandbox/i.test(userInfo().username)) {
      console.error('A configuração protegida precisa ser executada no Windows com o mesmo usuário que executará as consultas, fora do usuário temporário de isolamento.');
      process.exitCode = 2;
    } else {
      const { startCredentialSetup } = await import('./setup.mjs');
      const { protectCredentials } = await import('./credentials.mjs');
      const { url } = await startCredentialSetup({ storeName: config.displayName,
        save: credentials => protectCredentials(credentials, { vaultPath: storeVaultPath(config) }) });
      console.log(`Configuração local temporária: ${url}`);
    }
  } else {
  let { credentials, missing } = getCredentials(config);
  let credentialSource = missing.length ? 'pending' : 'environment';
  let vaultStatus = 'not-needed';
  if (missing.length) {
    try {
      const { loadCredentials } = await import('./credentials.mjs');
      credentials = await loadCredentials({ vaultPath: storeVaultPath(config) });
      missing = [];
      credentialSource = 'windows-protected-vault';
      vaultStatus = 'readable';
    } catch (error) {
      vaultStatus = error?.code === 'CREDENTIALS_NOT_FOUND' ? 'not-configured' : 'unavailable-for-current-user';
    }
  }
  if (command === 'check') {
    if (args.length) throw new Error('Argumentos inválidos.');
    const status = await readPilotStatus({ rootDir: fileURLToPath(new URL('../data/', import.meta.url)), storeId: config.storeId });
    console.log(JSON.stringify({
      loja: config.displayName, marketplace: 'Amazon Brasil',
      historicoPlanejado: config.historyStart, atualizacaoPlanejadaMinutos: config.plannedSyncMinutes,
      agendamentoAtivo: false, conexaoRealTestada: Boolean(status.lastSuccessfulApiReadAt),
      ultimaConsultaApiBemSucedida: status.lastSuccessfulApiReadAt, fontesConsultadas: status.sources,
      origemDoAcesso: credentialSource, armazenamentoLocal: vaultStatus,
      configuracaoPresente: missing.length === 0, camposAusentes: missing,
      proximoPasso: missing.length ? 'Disponibilizar o acesso protegido para este usuário Windows.' : status.lastSuccessfulApiReadAt ? 'Conferir amostras com Seller Central e validar a cobertura do histórico.' : 'Executar amostra e conferir os dados com o Seller Central.'
    }, null, 2));
    process.exitCode = missing.length ? 2 : 0;
  } else {
    if (missing.length) {
      console.error(`Acesso ainda não disponível. Armazenamento local: ${vaultStatus}. Campos de ambiente ausentes: ${missing.join(', ')}. Nenhuma consulta foi feita.`);
      process.exitCode = 2;
    } else {
      const options = parseArgs(args);
      const window = makeWindow({ from: options.from, to: options.to, historyStart: config.historyStart });
      const sources = options.sources ? options.sources.split(',') : SOURCES;
      if (sources.some(source => !SOURCES.includes(source))) throw new Error('Fonte inválida.');
      const [{ AmazonClient }, { SnapshotStore }] = await Promise.all([import('./amazon/client.mjs'), import('./storage.mjs')]);
      const client = new AmazonClient({ ...credentials, maxPages: 20 });
      const store = new SnapshotStore({ rootDir: fileURLToPath(new URL('../data/', import.meta.url)), storeId: config.storeId });
      const run = await collectPilot({ client, config, store, window, sellerId: credentials.sellerId, sources, report: event => console.log(JSON.stringify(event)) });
      console.log(JSON.stringify({ execucao: run.id, status: run.status, conciliacao: 'pendente', fontes: run.sources.map(source => ({ fonte: source.source, status: source.status, paginas: source.pages.length, registrosObservados: source.recordsObserved })) }, null, 2));
      process.exitCode = run.status === 'collected-awaiting-validation' ? 0 : 1;
    }
  }
  }
} catch {
  console.error('Não foi possível iniciar ou salvar a coleta. Confira os parâmetros e o acesso à pasta local; nenhum detalhe de credencial foi registrado.');
  process.exitCode = 1;
}

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]?.replace(/^--/, '');
    if (!args[index]?.startsWith('--') || !['from', 'to', 'sources'].includes(name) || !args[index + 1] || result[name]) throw new Error('Argumentos inválidos.');
    result[name] = args[index + 1];
  }
  return result;
}
