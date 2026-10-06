import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readMonitorStatus } from '../src/domain/monitor-status.mjs';

test('monitor status requires a live recent process and never exposes private status fields', async t => {
  const base = path.resolve(os.tmpdir());
  const rootDir = await mkdtemp(path.join(base, 'synth-monitor-status-'));
  t.after(async () => { assert.equal(path.dirname(rootDir), base); await rm(rootDir, { recursive: true, force: true }); });
  await mkdir(path.join(rootDir, 'store-a'));
  const write = data => writeFile(path.join(rootDir, 'store-a', 'monitor-status.json'), JSON.stringify(data));
  const options = { rootDir, storeIds: ['store-a'], now: new Date('2026-09-25T04:00:00Z'), isProcessAlive: () => true };
  await write({ state: 'running', pid: 123, lastStartedAt: '2026-09-25T03:00:00Z', nextRunAt: '2026-09-25T04:10:00Z', intervalMinutes: 15, credential: 'never-publish' });
  const current = await readMonitorStatus(options);
  assert.equal(current.state, 'running');
  assert.equal(current.intervalMinutes, 15);
  assert.equal(Object.hasOwn(current, 'pid'), false);
  assert.equal(JSON.stringify(current).includes('never-publish'), false);
  assert.equal((await readMonitorStatus({ ...options, isProcessAlive: () => false })).state, 'stopped');
  assert.equal((await readMonitorStatus({ ...options, isProcessAlive: () => false })).intervalMinutes, null);
  assert.equal((await readMonitorStatus({ ...options, now: new Date('2026-09-26T04:00:00Z') })).state, 'stopped');
  assert.equal((await readMonitorStatus({ ...options, storeIds: ['store-a', 'store-b'] })).state, 'unknown');
  await write({ state: 'running', pid: 123, lastStartedAt: '2026-09-25T03:00:00Z', intervalMinutes: 30 });
  assert.equal((await readMonitorStatus(options)).intervalMinutes, 30);
  await write({ state: 'running', pid: 123, lastStartedAt: '2026-09-25T03:00:00Z', intervalMinutes: -1 });
  assert.equal((await readMonitorStatus(options)).intervalMinutes, null);
});
