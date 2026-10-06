import { userInfo } from 'node:os';
import { startCredentialSetup } from '../src/setup.mjs';
import { protectCredentials } from '../src/credentials.mjs';
import { loadStoreConfig, storeVaultPath } from '../src/stores.mjs';

if (process.platform !== 'win32' || /codexsandbox/i.test(userInfo().username)) {
  console.error('Abra a configuração com o usuário do Windows que executará as consultas.');
  process.exitCode = 2;
} else {
  const config = await loadStoreConfig('multivendas-prime');
  const { url } = await startCredentialSetup({
    storeName: config.displayName,
    save: credentials => protectCredentials(credentials, { vaultPath: storeVaultPath(config) }),
  });
  console.log(url);
}
