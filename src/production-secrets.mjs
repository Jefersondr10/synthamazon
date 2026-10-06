import path from 'node:path';
import { lstat, readFile } from 'node:fs/promises';

export async function readProductionCredentials(directory, storeId) {
  const fail = () => Object.assign(new Error('CREDENTIALS_UNAVAILABLE'), { code: 'CREDENTIALS_UNAVAILABLE' });
  try {
    if (!path.isAbsolute(directory) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(storeId)) throw fail();
    const filename = path.join(directory, `${storeId}.json`);
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 32_768
      || process.platform !== 'win32' && (info.mode & 0o077)) throw fail();
    const value = JSON.parse(await readFile(filename, 'utf8'));
    if (value.storeId !== storeId || Object.keys(value).some(key => !['storeId', 'clientId', 'clientSecret', 'refreshToken', 'sellerId'].includes(key))) throw fail();
    for (const key of ['clientId', 'clientSecret', 'refreshToken']) {
      if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 16_384 || /[\r\n\0]/.test(value[key])) throw fail();
    }
    if (value.sellerId !== undefined && (typeof value.sellerId !== 'string' || !/^[A-Za-z0-9]+$/.test(value.sellerId))) throw fail();
    const { storeId: _storeId, ...credentials } = value;
    return credentials;
  } catch { throw fail(); }
}
