import { readFile } from 'node:fs/promises';
import path from 'node:path';

const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

/** Read-only public status; never return process IDs, paths or arbitrary file contents. */
export async function readMonitorStatus({ rootDir, storeIds, now = new Date(), isProcessAlive = alive }) {
  const statuses = await Promise.all(storeIds.map(async storeId => {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(storeId)) throw new TypeError('Invalid store.');
    try {
      const data = JSON.parse(await readFile(path.join(rootDir, storeId, 'monitor-status.json'), 'utf8'));
      const lastStartedAt = date(data.lastStartedAt);
      const lastCompletedAt = date(data.lastCompletedAt);
      const latest = Math.max(Date.parse(lastStartedAt) || 0, Date.parse(lastCompletedAt) || 0);
      const fresh = latest > 0 && Date.parse(now) - latest <= 3 * 3600_000;
      const running = data.state === 'running' && Number.isSafeInteger(data.pid) && data.pid > 0 && fresh && isProcessAlive(data.pid);
      return { storeId, state: running ? 'running' : 'stopped', lastStartedAt, lastCompletedAt,
        nextRunAt: running ? date(data.nextRunAt) : null,
        intervalMinutes: running && Number.isSafeInteger(data.intervalMinutes) && data.intervalMinutes >= 1 && data.intervalMinutes <= 1440 ? data.intervalMinutes : null,
        trackingLookbackDays: 120, orderLookbackDays: 7, financialLookbackDays: 30,
        lastErrorCode: /^[A-Z_]{1,60}$/.test(data.lastErrorCode ?? '') ? data.lastErrorCode : null,
        trackingChecked: count(data.trackingChecked), trackingFailed: count(data.trackingFailed) };
    } catch { return { storeId, state: 'unknown', intervalMinutes: null, lastCompletedAt: null, nextRunAt: null, lastErrorCode: null }; }
  }));
  if (statuses.length === 1) return statuses[0];
  const allRunning = statuses.length > 0 && statuses.every(item => item.state === 'running');
  const completed = statuses.map(item => item.lastCompletedAt).filter(Boolean).sort();
  const next = statuses.map(item => item.nextRunAt).filter(Boolean).sort();
  const intervalMinutes = allRunning && statuses.every(item => item.intervalMinutes === statuses[0].intervalMinutes) ? statuses[0].intervalMinutes : null;
  return { state: allRunning ? 'running' : 'unknown', intervalMinutes,
    lastCompletedAt: completed.length === statuses.length ? completed[0] : null,
    nextRunAt: allRunning ? next[0] ?? null : null, lastErrorCode: statuses.find(item => item.lastErrorCode)?.lastErrorCode ?? null, stores: statuses };
}
