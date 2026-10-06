import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadStoreConfig, loadStoreConfigs, readStoreCredentials, storeVaultPath, storeArguments } from '../src/stores.mjs';

test('cada loja resolve exclusivamente sua configuração e seu cofre', async () => {
  const configs = await loadStoreConfigs();
  assert.deepEqual(configs.map(store => store.storeId), ['origem-comercio', 'hd-comercio', 'multivendas-prime']);
  const hd = await loadStoreConfig('hd-comercio');
  let requested;
  const result = await readStoreCredentials(hd, { env: { ORIGEM_SPAPI_CLIENT_ID: 'wrong', ORIGEM_SPAPI_CLIENT_SECRET: 'wrong', ORIGEM_SPAPI_REFRESH_TOKEN: 'wrong', HD_SPAPI_CLIENT_ID: 'partial' },
    readVault: async options => { requested = options; return { clientId: 'hd' }; } });
  assert.equal(result.clientId, 'hd');
  assert.equal(path.basename(requested.vaultPath), 'hd-comercio.dpapi');
  assert.notEqual(requested.vaultPath, storeVaultPath(configs[0]));
  await assert.rejects(readStoreCredentials(hd, { env: {}, readVault: async () => { throw new Error('missing HD vault'); } }), /missing HD vault/);
  await assert.rejects(loadStoreConfig('../origem-comercio'), TypeError);
  const mv = await loadStoreConfig('multivendas-prime');
  const selected = await readStoreCredentials(mv, { env: {
    ORIGEM_SPAPI_CLIENT_ID:'wrong', ORIGEM_SPAPI_CLIENT_SECRET:'wrong', ORIGEM_SPAPI_REFRESH_TOKEN:'wrong',
    HD_SPAPI_CLIENT_ID:'wrong', HD_SPAPI_CLIENT_SECRET:'wrong', HD_SPAPI_REFRESH_TOKEN:'wrong',
  }, readVault: async options => { requested = options; return { clientId:'mv' }; } });
  assert.equal(selected.clientId, 'mv');
  assert.equal(path.basename(requested.vaultPath), 'multivendas-prime.dpapi');
  await assert.rejects(readStoreCredentials(mv, { env:{}, readVault:async () => { throw new Error('missing MV vault'); } }), /missing MV vault/);
});

test('seleção explícita de loja não aceita duplicatas nem altera a loja padrão', () => {
  assert.deepEqual(storeArguments(['--sources','orders']), { storeId:'origem-comercio', args:['--sources','orders'] });
  assert.deepEqual(storeArguments(['--store','hd-comercio','--sources','orders']), { storeId:'hd-comercio', args:['--sources','orders'] });
  for (const args of [['--store'], ['--store','all'], ['--store','hd-comercio','--store','origem-comercio']]) assert.throws(() => storeArguments(args), TypeError);
});
