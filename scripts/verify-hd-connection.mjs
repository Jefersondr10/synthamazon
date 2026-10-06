import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { loadCredentials } from '../src/credentials.mjs';
import { loadConfig } from '../src/config.mjs';
import { AmazonClient } from '../src/amazon/client.mjs';

// Read one page per permission without importing account data into the dashboard.
try {
  const config = await loadConfig(new URL('../config/hd-comercio.json', import.meta.url));
  const credentials = await loadCredentials({
    vaultPath: fileURLToPath(new URL('../data/credentials/hd-comercio.dpapi', import.meta.url)),
  });
  const client = new AmazonClient({ ...credentials, maxPages: 1, maxAttempts: 2 });
  const before = new Date(Date.now() - 5 * 60_000).toISOString();
  const after = new Date(Date.parse(before) - 7 * 86_400_000).toISOString();
  const sources = [
    ['orders', 'orders', () => client.searchOrders({ createdAfter: after, createdBefore: before, maxResultsPerPage: 1, marketplaceIds: [config.marketplaceId] })],
    ['transactions', 'transactions', () => client.listTransactions({ postedAfter: after, postedBefore: before, marketplaceId: config.marketplaceId })],
    ['fba-inventory', 'inventorySummaries', () => client.getInventorySummaries({ marketplaceIds: [config.marketplaceId] })],
  ];
  const results = await Promise.allSettled(sources.map(async ([source, listKey, createPages]) => {
    const pages = createPages();
    try {
      const page = await pages.next();
      return { source, status: 'ok', sampleRecords: page.value?.[listKey]?.length ?? 0 };
    } finally { await pages.return(); }
  }));
  const checks = results.map((result, index) => result.status === 'fulfilled' ? result.value : {
    source: sources[index][0], status: 'failed',
    code: /^[A-Z_]+$/.test(result.reason?.code) ? result.reason.code : 'UNAVAILABLE',
    ...(Number.isInteger(result.reason?.status) ? { httpStatus: result.reason.status } : {}),
  });
  const validation = { storeId: config.storeId, checkedAt: new Date().toISOString(), apiConnected: checks.every(check => check.status === 'ok'), dataImported: false, checks };
  await mkdir(new URL('../data/runtime/', import.meta.url), { recursive: true });
  await writeFile(new URL('../data/runtime/hd-api-validation.json', import.meta.url), `${JSON.stringify(validation, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(validation, null, 2));
  if (!validation.apiConnected) process.exitCode = 1;
} catch {
  console.error('Não foi possível validar o acesso protegido da HD. Nenhuma credencial ou resposta da conta foi registrada.');
  process.exitCode = 1;
}
