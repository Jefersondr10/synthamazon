import test from 'node:test';
import assert from 'node:assert/strict';
import { getCredentials, loadConfig, makeWindow, monitorIntervalMinutes } from '../src/config.mjs';

const historyStart = '2026-01-01T00:00:00-03:00';
const now = new Date('2026-09-24T15:00:00Z');

test('loja piloto Brasil não confunde o rótulo EUA do portal com marketplace', async () => {
  const config = await loadConfig();
  assert.equal(config.storeId, 'origem-comercio');
  assert.equal(config.marketplaceId, 'A2Q3Y263D00KWC');
  assert.equal(monitorIntervalMinutes(config), 15);
});

test('intervalo de coleta aceita minutos inteiros e rejeita valores que causariam espera incorreta', () => {
  assert.equal(monitorIntervalMinutes(), 15);
  assert.equal(monitorIntervalMinutes({ plannedSyncMinutes: 30 }), 30);
  for (const plannedSyncMinutes of [0, -1, 0.5, '15', NaN, Infinity, 1441]) {
    assert.throws(() => monitorIntervalMinutes({ plannedSyncMinutes }), { code: 'INVALID_CONFIG' });
  }
});

test('pré-verificação informa somente nomes de campos ausentes', () => {
  const result = getCredentials({ credentialEnvPrefix: 'ORIGEM_SPAPI' }, { ORIGEM_SPAPI_CLIENT_ID: 'private-id' });
  assert.equal(result.missing.length, 2);
  assert.ok(result.missing.every(name => name.startsWith('ORIGEM_SPAPI_')));
  assert.equal(JSON.stringify(result.missing).includes('private-id'), false);
});

test('janela padrão recente respeita atraso mínimo e início histórico', () => {
  assert.deepEqual(makeWindow({ now, historyStart }), { from: '2026-09-17T14:55:00.000Z', to: '2026-09-24T14:55:00.000Z' });
  const nearStart = makeWindow({ now: new Date('2026-01-02T10:00:00Z'), historyStart });
  assert.equal(nearStart.from, '2026-01-01T03:00:00.000Z');
});

test('rejeita período ambíguo, futuro, amplo ou anterior ao escopo', () => {
  for (const options of [
    { from: '2026-01-01', to: '2026-01-02' },
    { from: '2026-02-30T00:00:00-03:00', to: '2026-03-02T00:00:00-03:00' },
    { from: '2026-01-01T00:00:00-03:00', to: '2026-09-01T00:00:00-03:00' },
    { from: '2025-12-31T00:00:00-03:00', to: '2026-01-02T00:00:00-03:00' },
    { from: '2026-09-24T14:00:00Z', to: '2026-09-24T15:00:00Z' }
  ]) assert.throws(() => makeWindow({ ...options, now, historyStart }));
});
