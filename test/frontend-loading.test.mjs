import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createReadScope, loadRecordPage, loadAllRecords, fetchReadWithRetry } from '../public/list-data.js';
import { bindReturnedManagement, renderReturnedManagement } from '../public/returned-management.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

test('leaving a screen cancels its in-flight reads, prevents its next page, and preserves edits', async () => {
  const calls = [], pending = deferred();
  const scope = createReadScope((url, options) => {
    calls.push({ url, options });
    if (options.method === 'POST') return pending.promise;
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  });
  const reading = loadAllRecords(scope.api, '/api/returns', { storeId: 'a' });
  const saving = scope.api('/api/returns/manage', { method: 'POST', body: '{}' });
  scope.cancel();
  await assert.rejects(reading, { name: 'AbortError' });
  assert.throws(() => scope.api('/api/returns?offset=500'), { name: 'AbortError' });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.signal.aborted, true);
  assert.equal(calls[1].options.signal, undefined);
  pending.resolve({ ok: true });
  assert.deepEqual(await saving, { ok: true });
  const next = createReadScope(async (_url, options) => options.signal.aborted);
  assert.equal(await next.api('/api/orders'), false);
});

test('a cancelled retry stops immediately and does not send a duplicate request', async () => {
  const controller = new AbortController(), paused = deferred();
  let requests = 0;
  const result = fetchReadWithRetry('/api/returns', { signal: controller.signal }, {
    fetchImpl: async () => { requests++; return { status: 503 }; },
    pause: () => { paused.resolve(); return new Promise(() => {}); },
  });
  await paused.promise;
  controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(requests, 1);
  await assert.rejects(fetchReadWithRetry('/api/returns', { signal: controller.signal }, { fetchImpl: () => { requests++; } }), { name: 'AbortError' });
  assert.equal(requests, 1);
});

test('returned orders load only the visible batch while keeping global counts and every filter', async () => {
  const calls = [], filters = new URLSearchParams({ storeId: 'a,b', workflow: 'active', card: 'reimbursed', reviewStatus: 'safe-t', query: 'track', offset: '999' });
  const summary = { total: 8000, workflowCounts: { active: 8000, finalized: 1000, all: 9000 } };
  const data = await loadRecordPage(async url => {
    const params = new URL(url, 'http://localhost').searchParams;
    calls.push(params);
    return { items: Array.from({ length: 100 }, (_, index) => ({ orderId: `order-${index + 200}` })), offset: 200, limit: 100, total: 7500, hasMore: true, summary };
  }, '/api/returns', filters, { page: 2 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].get('offset'), '200'); assert.equal(calls[0].get('limit'), '100');
  for (const key of ['storeId', 'workflow', 'card', 'reviewStatus', 'query']) assert.equal(calls[0].get(key), filters.get(key));
  assert.equal(filters.get('offset'), '999');
  assert.equal(data.items.length, 100); assert.equal(data.total, 7500); assert.equal(data.hasMore, true);
  assert.equal(data.summary, summary);
});

test('finalizing the last batch returns to a valid page without mistaking an empty page for an empty queue', async () => {
  const offsets = [];
  const result = await loadRecordPage(async url => {
    const offset = Number(new URL(url, 'http://localhost').searchParams.get('offset'));
    offsets.push(offset);
    return { items: offset < 150 ? [{ orderId: 'still-active' }] : [], total: 150, offset, hasMore: false };
  }, '/api/returns', { storeId: 'a' }, { page: 2 });
  assert.deepEqual(offsets, [200, 100]);
  assert.equal(result.offset, 100); assert.equal(result.items[0].orderId, 'still-active');
  let current = true, requests = 0;
  assert.equal(await loadRecordPage(async () => { requests++; current = false; return { total: 150 }; }, '/api/returns', {}, { page: 2, isCurrent: () => current }), null);
  assert.equal(requests, 1);
});

function checkbox(index) {
  let checked = false, writes = 0;
  return { dataset: { returnSelect: String(index) }, events: {},
    addEventListener(name, fn) { this.events[name] = fn; },
    set checked(value) { writes++; checked = value; }, get checked() { return checked; },
    get writes() { return writes; }, click(value) { checked = value; this.events.change(); },
  };
}

test('selecting a returned order does not rewrite every checkbox, while select-all and clearing still update the whole visible batch', () => {
  const inputs = Array.from({ length: 100 }, (_, index) => checkbox(index));
  const all = checkbox(), bar = { events: {}, addEventListener(name, fn) { this.events[name] = fn; } };
  const root = {
    querySelector(selector) { return selector === '[data-return-select-all]' ? all : selector === '[data-return-selection]' ? bar : null; },
    querySelectorAll(selector) { return selector === '[data-return-select]' ? inputs : []; },
  };
  const data = { items: inputs.map((_, index) => ({ storeId: 'a', orderId: `order-${index}`, review: { workflowState: 'active' } })) };
  bindReturnedManagement(root, { data, state: {}, helpers: { applyReviewColors() {} } });
  inputs[3].click(true);
  assert.match(bar.innerHTML, /1 selecionado/); assert.equal(all.indeterminate, true);
  assert.equal(inputs.reduce((total, input) => total + input.writes, 0), 0);
  all.click(true);
  assert.equal(inputs.every(input => input.checked), true); assert.equal(all.indeterminate, false); assert.match(bar.innerHTML, /100 selecionados/);
  bar.events.click({ target: { closest: () => ({ hasAttribute: () => true }) } });
  assert.equal(inputs.every(input => !input.checked), true); assert.equal(bar.hidden, true);
});

test('returned page shows global queue counters and a page footer without claiming all rows are visible', () => {
  const data = { items: [{ storeId: 'a', orderId: 'one', review: { workflowState: 'active' } }], total: 250, summary: { total: 250, workflowCounts: { active: 250, finalized: 10, all: 260 } } };
  const helpers = Object.fromEntries(['icon', 'orderNumber', 'tracking', 'detection', 'refund', 'alert', 'reviewBadge', 'reviewFilter', 'monitor', 'policy'].map(name => [name, () => '']));
  const html = renderReturnedManagement(data, { returnWorkflow: 'active' }, { ...helpers, number: String, pagination(total, visible) { assert.equal(total, 250); assert.equal(visible, 1); return '<div>1–1 de 250</div>'; } });
  assert.match(html, /Em acompanhamento \(250\)/); assert.match(html, /1–1 de 250/);
  assert.doesNotMatch(html, /todos os resultados dos filtros/);
});

test('the navigation badge reuses recent counts, merges concurrent reads, and switches store without leaking counts', async () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = source.indexOf("let alertCountStore = ''"), end = source.indexOf('\nsetInterval(', start);
  let now = 0;
  const calls = [], badge = { setAttribute() {} };
  const context = vm.createContext({
    state: { storeId: 'a', bootstrap: {} }, $: () => badge, createReadScope,
    Date: { now: () => now }, URLSearchParams,
    api: (path, options) => { const d = deferred(); calls.push({ path, options, ...d }); return d.promise; },
  });
  vm.runInContext(source.slice(start, end), context);
  const first = context.refreshSalesAlertCount(), duplicate = context.refreshSalesAlertCount();
  assert.equal(calls.length, 1);
  calls[0].resolve({ counts: { new: 7 } }); await Promise.all([first, duplicate]);
  assert.equal(badge.textContent, '7');
  await context.refreshSalesAlertCount(); assert.equal(calls.length, 1);
  now = 180001;
  const expired = context.refreshSalesAlertCount(); assert.equal(calls.length, 2);
  context.state.storeId = 'b';
  const switched = context.refreshSalesAlertCount(); assert.equal(calls.length, 3); assert.equal(calls[1].options.signal.aborted, true);
  calls[1].resolve({ counts: { new: 88 } }); await expired;
  calls[2].resolve({ counts: { new: 2 } }); await switched;
  assert.equal(badge.textContent, '2');
  now += 180001;
  const slow = context.refreshSalesAlertCount();
  context.updateSalesAlertCount(0); // Marking an alert read supplies a newer count.
  calls[3].resolve({ counts: { new: 2 } }); await slow;
  assert.equal(badge.hidden, true);
});

test('filtered alert counters never replace the global badge and a saved alert invalidates its cached global count', async () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const countStart = source.indexOf("let alertCountStore = ''"), countEnd = source.indexOf('\nsetInterval(', countStart);
  const apiStart = source.indexOf('async function api('), apiEnd = source.indexOf('\nfunction params', apiStart);
  const calls = [], badge = { setAttribute() {} }, nextRead = deferred();
  const context = vm.createContext({
    state: { storeId: 'a', bootstrap: {} }, $: () => badge, createReadScope, URLSearchParams,
    Date: { now: () => 1000 },
    fetchReadWithRetry: async (path, options) => {
      calls.push({ path, options });
      if (options.method === 'POST') return { ok: true, json: async () => ({ ok: true }) };
      return { ok: true, json: () => nextRead.promise };
    },
  });
  vm.runInContext(source.slice(apiStart, apiEnd) + '\n' + source.slice(countStart, countEnd), context);
  context.updateSalesAlertCountFromView({ counts: { new: 7 } }, { mode: 'all', type: 'all', query: '' });
  assert.equal(badge.textContent, '7');
  const filters = [
    { mode: 'FBA', type: 'all', query: '' },
    { mode: 'all', type: 'drop', query: '' },
    { mode: 'all', type: 'all', query: 'matching-only-one-product' },
  ];
  for (const filter of filters) {
    await context.updateSalesAlertCountFromView({ counts: { new: 0 } }, filter);
    assert.equal(badge.textContent, '7');
  }
  assert.equal(calls.length, 0, 'fresh global count is reused despite filtering the screen');
  await context.api('/api/sales-alerts', { method: 'POST', body: JSON.stringify({ id: 'alert', action: 'seen' }) });
  const refreshed = context.updateSalesAlertCountFromView({ counts: { new: 0 } }, filters[0]);
  const duplicate = context.refreshSalesAlertCount();
  assert.equal(calls.length, 2, 'one save and one deduplicated global read');
  const query = new URL(calls[1].path, 'http://localhost').searchParams;
  assert.equal(query.get('storeId'), 'a');
  for (const key of ['mode', 'type', 'query']) assert.equal(query.has(key), false);
  nextRead.resolve({ counts: { new: 6 } }); await Promise.all([refreshed, duplicate]);
  assert.equal(badge.textContent, '6');
});
