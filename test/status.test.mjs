import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readPilotStatus } from '../src/status.mjs';

test('status usa somente fontes completas da loja correta e não inventa conexão a partir de tentativas', async t => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'synth-status-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  assert.equal((await readPilotStatus({ rootDir, storeId: 'origem-comercio' })).lastSuccessfulApiReadAt, null);
  const directory = path.join(rootDir, 'origem-comercio', 'runs');
  await mkdir(directory, { recursive: true });
  const source = { source:'orders', status:'failed', pages:[], finishedAt:'2026-09-24T21:00:00Z' };
  await writeFile(path.join(directory, '11111111-1111-4111-8111-111111111111.json'), JSON.stringify({storeId:'origem-comercio',sources:[source]}));
  assert.equal((await readPilotStatus({ rootDir, storeId:'origem-comercio' })).lastSuccessfulApiReadAt, null);
  await writeFile(path.join(directory, '22222222-2222-4222-8222-222222222222.json'), JSON.stringify({storeId:'outra-loja',sources:[{...source,status:'api-pages-complete',pages:[{}]}]}));
  assert.equal((await readPilotStatus({ rootDir, storeId:'origem-comercio' })).lastSuccessfulApiReadAt, null);
  await writeFile(path.join(directory, '33333333-3333-4333-8333-333333333333.json'), JSON.stringify({storeId:'origem-comercio',sources:[{...source,status:'api-pages-complete',pages:[{}]}]}));
  assert.equal((await readPilotStatus({ rootDir, storeId:'origem-comercio' })).lastSuccessfulApiReadAt, source.finishedAt);
});
