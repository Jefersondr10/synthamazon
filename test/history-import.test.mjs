import test from 'node:test';
import assert from 'node:assert/strict';
import { historyWindows } from '../src/history-import.mjs';

test('carga histórica cobre janeiro até a margem da API sem lacunas nem janelas acima de 30 dias', () => {
  const now = new Date('2026-09-28T23:00:00Z');
  const start = '2026-01-01T00:00:00-03:00';
  const windows = historyWindows(start, now);
  assert.equal(windows[0].to, '2026-09-28T22:55:00.000Z');
  assert.equal(windows.at(-1).from, new Date(start).toISOString());
  windows.forEach((window, i) => {
    assert.ok(Date.parse(window.to) > Date.parse(window.from));
    assert.ok(Date.parse(window.to) - Date.parse(window.from) <= 30 * 86400000);
    if (i) assert.equal(window.to, windows[i - 1].from);
  });
  assert.throws(() => historyWindows('invalid', now), TypeError);
  assert.throws(() => historyWindows(now.toISOString(), now), TypeError);
});
