import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { loadStoreConfigs } from './stores.mjs';
import { monitorIntervalMinutes } from './config.mjs';

const abort = new AbortController();
let child;
const stop = () => { abort.abort(); child?.kill('SIGTERM'); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
const stores = await loadStoreConfigs();
const due = new Map(stores.map(store => [store.storeId, 0]));
let historyCursor = 0;
const needsHistory = async store => {
  try {
    const status = JSON.parse(await readFile(new URL(`../data/${store.storeId}/history-import-status.json`, import.meta.url), 'utf8'));
    return ['running', 'interrupted', 'failed'].includes(status.status);
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};
const runChild = async (script, store, duration = 0) => {
  let deadline, forced;
  try {
    return await new Promise(resolve => {
      child = spawn(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), '--store', store.storeId],
        { stdio: ['ignore', duration ? 'ignore' : 'inherit', 'inherit'], shell: false, windowsHide: true });
      child.once('error', () => resolve(1));
      child.once('exit', code => resolve(code ?? 1));
      if (duration) deadline = setTimeout(() => {
        child?.kill('SIGTERM');
        forced = setTimeout(() => child?.kill('SIGKILL'), 45_000);
      }, duration);
    });
  } finally { clearTimeout(deadline); clearTimeout(forced); child = undefined; }
};
// A single collector runs at a time; child exit releases memory between stores.
while (!abort.signal.aborted) {
  for (const store of stores) {
    if (abort.signal.aborted) break;
    if (Date.now() < due.get(store.storeId)) continue;
    const code = await runChild('./production-collect.mjs', store);
    if (code) console.error(`${store.storeId}: rodada interrompida; haverá nova tentativa`);
    due.set(store.storeId, Date.now() + monitorIntervalMinutes(store) * 60_000);
  }
  if (abort.signal.aborted) break;
  // Resume historical imports only between scheduled rounds, with checkpoints
  // and a time budget. This avoids overlapping Amazon calls or heavy imports.
  const available = Math.min(...due.values()) - Date.now();
  let resumed = false;
  if (available > 60_000) {
    for (let index = 0; index < stores.length; index++) {
      const store = stores[historyCursor++ % stores.length];
      if (!await needsHistory(store)) continue;
      await runChild('./history-import-start.mjs', store, Math.min(300_000, available - 15_000));
      resumed = true; break;
    }
  }
  if (!resumed && !abort.signal.aborted) await delay(Math.max(1000, Math.min(...due.values()) - Date.now()), undefined, { signal: abort.signal }).catch(() => {});
}
