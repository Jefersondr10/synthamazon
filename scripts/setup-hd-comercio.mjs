import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { startCredentialSetup } from '../src/setup.mjs';
import { protectCredentials } from '../src/credentials.mjs';

if (process.platform !== 'win32' || /codexsandbox/i.test(userInfo().username)) {
  console.error('Abra a configuração com o usuário do Windows que executará as consultas.');
  process.exitCode = 2;
} else {
  const vaultPath = fileURLToPath(new URL('../data/credentials/hd-comercio.dpapi', import.meta.url));
  const { url } = await startCredentialSetup({
    storeName: 'HD COMÉRCIO',
    save: credentials => protectCredentials(credentials, { vaultPath }),
  });
  console.log(url);
}
