import { fileURLToPath } from 'node:url';
import { loadConfig, getCredentials } from './config.mjs';
import { loadCredentials } from './credentials.mjs';
import { readProductionCredentials } from './production-secrets.mjs';

const configurations = new Map([
  ['origem-comercio', new URL('../config/pilot.json', import.meta.url)],
  ['hd-comercio', new URL('../config/hd-comercio.json', import.meta.url)],
  ['multivendas-prime', new URL('../config/multivendas-prime.json', import.meta.url)],
]);
export const DEFAULT_STORE_ID = 'origem-comercio';

export async function loadStoreConfig(storeId = DEFAULT_STORE_ID) {
  const url = configurations.get(storeId);
  if (!url) throw new TypeError('Loja não cadastrada.');
  const config = await loadConfig(url);
  if (config.storeId !== storeId) throw new TypeError('Configuração pertence a outra loja.');
  return config;
}

export async function loadStoreConfigs() {
  return Promise.all([...configurations.keys()].map(loadStoreConfig));
}

export function storeVaultPath(config) {
  if (!configurations.has(config?.storeId)) throw new TypeError('Loja não cadastrada.');
  return fileURLToPath(new URL(`../data/credentials/${config.storeId}.dpapi`, import.meta.url));
}

export async function readStoreCredentials(config, { env = process.env, readVault = loadCredentials } = {}) {
  const vaultPath = storeVaultPath(config);
  if (env.SYNTHAMAZON_SECRETS_DIR) return readProductionCredentials(env.SYNTHAMAZON_SECRETS_DIR, config.storeId);
  const { credentials, missing } = getCredentials(config, env);
  if (!missing.length) return credentials;
  // An unavailable store vault must never fall back to another store's credentials.
  return readVault({ vaultPath });
}

export function storeArguments(args) {
  let storeId = DEFAULT_STORE_ID, selected = false;
  const remaining = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== '--store') { remaining.push(args[index]); continue; }
    if (selected || !configurations.has(args[index + 1])) throw new TypeError('Loja inválida.');
    selected = true; storeId = args[++index];
  }
  return { storeId, args: remaining };
}
