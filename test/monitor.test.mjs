import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Repository } from '../src/domain/repository.mjs';
import { runMonitorCycle, startMonitor, monitorErrorCode } from '../src/monitor.mjs';

const NOW = Date.parse('2026-09-25T18:00:00Z');
const DAY = 86_400_000;
const config = { storeId: 'monitor-test', marketplaceId: 'A2Q3Y263D00KWC', historyStart: '2026-01-01T00:00:00-03:00' };
const complete = { status: 'collected-awaiting-validation', sources: [] };

async function fixture(t) {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'synthamazon-monitor-'));
  const repository = new Repository({ rootDir, dbPath: ':memory:', stores: [config] });
  t.after(async () => { repository.close(); await rm(rootDir, { recursive: true, force: true }); });
  const observations = [], calls = [], waits = [], errors = [], collections = [];
  const tracking = {
    ensureReturnSchema(db) { assert.equal(db, repository.db); },
    recordTrackingObservation(db, observation) { assert.equal(db, repository.db); observations.push(structuredClone(observation)); return { recorded: true }; }
  };
  const client = {
    async getOrder(orderId, params) {
      calls.push({ orderId, params });
      return { order: { orderId, packages: [{ packageReferenceId: 'package', trackingNumber: 'tracking-test', carrier: 'AMZBR', packageStatus: { status: 'IN_TRANSIT', detailedStatus: 'PICKED_UP' }, packageItems: [], shipTime: '2026-09-01T12:00:00Z' }], proceeds: { grandTotal: { amount: 9007199254740993000n } } } };
    }
  };
  const seed = (id, overrides = {}, storeId = config.storeId, source = 'orders') => {
    if (storeId !== config.storeId) repository.registerStore({ storeId });
    const order = { storeId, items: [], orderIds: [], breakdowns: [], transactionId: id, orderId: id, fulfillmentMode: 'DBA', createdAt: new Date(NOW - DAY).toISOString(), packages: [{ detailedStatus: 'RETURNED_TO_SELLER' }], grandTotalCents: '9007199254740993000', ...overrides };
    repository.db.prepare('INSERT INTO entities VALUES(?,?,?,?,?,?,?,?,?)').run(storeId, source, id, new Date(NOW).toISOString(), new Date(NOW).toISOString(), 'fixture', null, 1, JSON.stringify(order));
  };
  return { repository, rootDir, config, tracking, client, seed, observations, calls, waits, errors, collections,
    now: () => new Date(NOW), sleep: async ms => { waits.push(ms); }, onError: code => errors.push(code),
    collector: async options => { collections.push(options); return complete; } };
}

test('ciclo consulta apenas DBA com pacotes até 120 dias, incluindo devolvidos, e preserva finanças', async t => {
  const f = await fixture(t);
  f.seed('eligible-returned');
  f.seed('eligible-boundary', { createdAt: new Date(NOW - 120 * DAY).toISOString() });
  f.seed('old', { createdAt: new Date(NOW - 120 * DAY - 1).toISOString() });
  f.seed('future', { createdAt: new Date(NOW + 1).toISOString() });
  f.seed('fba', { fulfillmentMode: 'FBA' });
  f.seed('mfn', { fulfillmentMode: 'MFN' });
  f.seed('no-packages', { packages: [] });
  f.seed('other-store', {}, 'other-store');
  f.seed('financial-row', { totalCents: '123456789123456789' }, config.storeId, 'transactions');
  const before = f.repository.db.prepare('SELECT * FROM entities ORDER BY store_id,source,source_id').all();
  const result = await runMonitorCycle(f);
  assert.deepEqual(f.calls.map(call => call.orderId), ['eligible-boundary', 'eligible-returned']);
  assert.ok(f.calls.every(call => JSON.stringify(call.params) === '{"includedData":["PACKAGES"]}'));
  assert.equal(result.trackingChecked, 2);
  assert.equal(result.trackingFailed, 0);
  assert.equal(result.lastErrorCode, null);
  assert.deepEqual(f.waits, [2100]);
  assert.deepEqual(f.collections.map(call => call.sources), [['orders'], ['transactions']]);
  assert.equal(f.collections[0].orderDateBasis, 'updated');
  assert.equal(f.collections[1].orderDateBasis, undefined);
  assert.deepEqual(f.collections.map(call => Date.parse(call.window.to) - Date.parse(call.window.from)), [7 * DAY, 30 * DAY]);
  assert.ok(f.collections.every(call => Date.parse(call.window.to) === NOW - 300000));
  assert.deepEqual(f.repository.db.prepare('SELECT * FROM entities ORDER BY store_id,source,source_id').all(), before);
  for (const observation of f.observations) {
    assert.deepEqual(Object.keys(observation).sort(), ['observedAt', 'orderId', 'packages', 'storeId']);
    assert.equal(observation.observedAt, new Date(NOW).toISOString());
    assert.equal(observation.packages[0].shippedAt, '2026-09-01T12:00:00.000Z');
    assert.equal(Object.hasOwn(observation.packages[0], 'eventAt'), false);
    assert.equal(observation.packages[0].createdAt, null);
    assert.equal(JSON.stringify(observation).includes('grandTotal'), false);
  }
});

test('falhas de coleta e de um pedido não impedem consultas posteriores nem vazam mensagens', async t => {
  const f = await fixture(t);
  f.seed('a-fail'); f.seed('b-success');
  const goodGetOrder = f.client.getOrder;
  f.client.getOrder = async (id, params) => {
    if (id === 'a-fail') { f.calls.push({ orderId: id, params }); throw Object.assign(new Error('PRIVATE BODY'), { code: 'RATE_LIMITED' }); }
    return goodGetOrder(id, params);
  };
  f.collector = async options => {
    f.collections.push(options);
    if (options.sources[0] === 'orders') throw Object.assign(new Error('PRIVATE TOKEN'), { code: 'TIMEOUT' });
    return complete;
  };
  const result = await runMonitorCycle(f);
  assert.deepEqual(f.errors, ['TIMEOUT', 'RATE_LIMITED']);
  assert.equal(f.collections.length, 2);
  assert.equal(result.trackingChecked, 2);
  assert.equal(result.trackingFailed, 1);
  assert.equal(result.lastErrorCode, 'RATE_LIMITED');
  assert.equal(f.observations.length, 1);
  assert.equal(f.observations[0].orderId, 'b-success');
  assert.equal(JSON.stringify({ result, errors: f.errors }).includes('PRIVATE'), false);
});

test('todos os lotes são percorridos em série e cada consulta adicional respeita 2100 ms', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 53; index++) f.seed(`order-${String(index).padStart(3, '0')}`);
  let concurrent = 0;
  const getOrder = f.client.getOrder;
  f.client.getOrder = async (...args) => {
    concurrent++; assert.equal(concurrent, 1);
    try { return await getOrder(...args); } finally { concurrent--; }
  };
  const result = await runMonitorCycle(f);
  assert.equal(result.trackingChecked, 53);
  assert.equal(new Set(f.calls.map(call => call.orderId)).size, 53);
  assert.equal(f.observations.length, 53);
  assert.equal(f.waits.length, 52);
  assert.ok(f.waits.every(ms => ms === 2100));
});

test('coleta parcial e falha de importação permanecem explícitas sem interromper rastreio', async t => {
  const f = await fixture(t);
  f.seed('order');
  f.collector = async () => ({ status: 'partial', sources: [] });
  f.repository.loadWorkspace = async () => { throw new Error('PRIVATE FILE'); };
  const result = await runMonitorCycle(f);
  assert.deepEqual(f.errors, ['COLLECTION_PARTIAL', 'COLLECTION_PARTIAL', 'IMPORT_FAILED']);
  assert.equal(result.lastErrorCode, 'IMPORT_FAILED');
  assert.equal(result.trackingChecked, 1);
});

test('resposta de outro pedido é rejeitada e observação usa somente horário após a consulta', async t => {
  const f = await fixture(t);
  f.seed('a-wrong'); f.seed('b-observed');
  let current = NOW;
  f.now = () => new Date(current);
  f.client.getOrder = async id => {
    current += 1000;
    return { order: { orderId: id === 'a-wrong' ? 'different' : id, packages: [{ packageStatus: { detailedStatus: 'RETURNED_TO_SELLER' } }] } };
  };
  const result = await runMonitorCycle(f);
  assert.equal(result.lastErrorCode, 'INVALID_RESPONSE');
  assert.equal(result.trackingFailed, 1);
  assert.equal(f.observations.length, 1);
  assert.equal(f.observations[0].observedAt, new Date(NOW + 2000).toISOString());
  assert.equal(f.observations[0].packages[0].shippedAt, null);
});

function idleSleep(expectedMs = 900000) {
  let reached;
  const idle = new Promise(resolve => { reached = resolve; });
  return { idle, sleep(ms, _value, { signal } = {}) {
    assert.equal(ms, expectedMs);
    reached();
    return new Promise((_resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    });
  } };
}

test('monitor começa imediatamente, permanece running em falha e agenda após terminar', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  let current = NOW;
  f.now = () => new Date(current);
  f.collector = async () => { current += 15000; return { status: 'partial', sources: [] }; };
  const idle = idleSleep();
  const monitor = await startMonitor({ ...f, sleep: idle.sleep });
  t.after(() => monitor.stop());
  await idle.idle;
  const status = JSON.parse(await readFile(monitor.statusPath, 'utf8'));
  assert.equal(status.state, 'running');
  assert.equal(status.pid, process.pid);
  assert.equal(status.lastStartedAt, new Date(NOW).toISOString());
  assert.equal(status.lastCompletedAt, new Date(NOW + 30000).toISOString());
  assert.equal(status.nextRunAt, new Date(NOW + 30000 + 900000).toISOString());
  assert.equal(status.lastErrorCode, 'COLLECTION_PARTIAL');
  assert.equal(status.intervalMinutes, 15);
  await assert.rejects(startMonitor(f), { code: 'MONITOR_ALREADY_RUNNING' });
  await monitor.stop();
  const stopped = JSON.parse(await readFile(monitor.statusPath, 'utf8'));
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.nextRunAt, null);
  await assert.rejects(access(path.join(f.rootDir, config.storeId, 'monitor.lock')), { code: 'ENOENT' });
});

test('lock de processo encerrado é recuperado sem afetar uma instância viva', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const directory = path.join(f.rootDir, config.storeId);
  await mkdir(directory);
  await writeFile(path.join(directory, 'monitor.lock'), JSON.stringify({ pid: 999999, token: 'stale' }));
  const idle = idleSleep();
  const checked = [];
  const monitor = await startMonitor({ ...f, sleep: idle.sleep, isProcessAlive: pid => { checked.push(pid); return false; } });
  t.after(() => monitor.stop());
  await idle.idle;
  assert.deepEqual(checked, [999999]);
  const lock = JSON.parse(await readFile(path.join(directory, 'monitor.lock'), 'utf8'));
  assert.equal(lock.pid, process.pid);
  assert.notEqual(lock.token, 'stale');
  await monitor.stop();
});

test('próxima rodada só começa após a espera de 15 minutos e limpa erro de rodada anterior', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  let current = NOW;
  let collectionCount = 0;
  let intervalCount = 0;
  f.now = () => new Date(current);
  f.collector = async () => {
    collectionCount++;
    return collectionCount === 1 ? { status: 'partial', sources: [] } : complete;
  };
  const idle = idleSleep();
  const monitor = await startMonitor({ ...f, sleep: async (ms, value, options) => {
    intervalCount++;
    if (intervalCount === 1) {
      assert.equal(collectionCount, 2);
      assert.equal(ms, 900000);
      current += ms;
      return;
    }
    return idle.sleep(ms, value, options);
  } });
  t.after(() => monitor.stop());
  await idle.idle;
  const status = JSON.parse(await readFile(monitor.statusPath, 'utf8'));
  assert.equal(collectionCount, 4);
  assert.equal(intervalCount, 2);
  assert.equal(status.lastStartedAt, new Date(NOW + 900000).toISOString());
  assert.equal(status.lastErrorCode, null);
  assert.equal(status.state, 'running');
  await monitor.stop();
});

test('monitor usa intervalo configurado após a coleta e publica o mesmo agendamento', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  let current = NOW;
  f.now = () => new Date(current);
  f.collector = async () => { current += 60000; return complete; };
  const idle = idleSleep(1800000);
  const monitor = await startMonitor({ ...f, config: { ...f.config, plannedSyncMinutes: 30 }, sleep: idle.sleep });
  t.after(() => monitor.stop());
  await idle.idle;
  const status = JSON.parse(await readFile(monitor.statusPath, 'utf8'));
  assert.equal(monitor.intervalMinutes, 30);
  assert.equal(status.intervalMinutes, 30);
  assert.equal(status.lastCompletedAt, new Date(NOW + 120000).toISOString());
  assert.equal(status.nextRunAt, new Date(NOW + 120000 + 1800000).toISOString());
  await monitor.stop();
});

test('parada durante consulta não grava observação nem inicia outro pedido', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  f.seed('a-first'); f.seed('b-next');
  const controller = new AbortController();
  let queried;
  const reached = new Promise(resolve => { queried = resolve; });
  f.client.getOrder = async id => {
    f.calls.push({ orderId: id }); queried();
    return new Promise((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(new Error('PRIVATE ABORT')), { once: true }));
  };
  const monitor = await startMonitor({ ...f, abortController: controller });
  t.after(() => monitor.stop());
  await reached;
  await monitor.stop();
  assert.equal(f.calls.length, 1);
  assert.equal(f.observations.length, 0);
  const status = JSON.parse(await readFile(monitor.statusPath, 'utf8'));
  assert.equal(status.state, 'stopped');
  assert.equal(status.lastCompletedAt, null);
  assert.equal(status.lastErrorCode, null);
});

test('códigos desconhecidos e mensagens privadas não saem como erro do monitor', () => {
  assert.equal(monitorErrorCode({ code: 'PRIVATE-CREDENTIAL', message: 'secret' }), 'MONITOR_FAILED');
  assert.equal(monitorErrorCode({ code: 'RATE_LIMITED' }), 'RATE_LIMITED');
});

test('reembolso de pedido antigo aciona recuperação automática única e preserva o financeiro', async t => {
  const f = await fixture(t);
  f.seed('refund', { transactionId:'refund', type:'Refund', status:'RELEASED', orderIds:['old-order'],
    postedAt:new Date(NOW).toISOString(), totalCents:'-1000', currency:'BRL' }, config.storeId, 'transactions');
  const calls = [];
  f.client.getOrder = async (orderId, parameters) => {
    calls.push({orderId,parameters});
    const order = { orderId, createdTime:'2026-01-01T12:00:00Z', lastUpdatedTime:'2026-02-01T12:00:00Z',
      salesChannel:{marketplaceId:config.marketplaceId}, fulfillment:{fulfilledBy:'MERCHANT',fulfillmentStatus:'SHIPPED'},
      orderItems:[{orderItemId:'item',product:{sellerSku:'sku',title:'Produto recuperado'},quantityOrdered:1}], packages:[] };
    return {order,rawBody:JSON.stringify({order})};
  };
  const financialBefore = f.repository.db.prepare("SELECT payload_json FROM entities WHERE source='transactions'").get();
  const first = await runMonitorCycle(f);
  assert.equal(first.lastErrorCode,null);
  assert.equal(calls.length,1); assert.equal(calls[0].orderId,'old-order');
  assert.deepEqual(calls[0].parameters.includedData,['PACKAGES','FULFILLMENT']);
  assert.equal(f.repository.orders({storeId:config.storeId,query:'old-order'}).total,1);
  await runMonitorCycle(f);
  assert.equal(calls.length,1);
  assert.deepEqual(f.repository.db.prepare("SELECT payload_json FROM entities WHERE source='transactions'").get(),financialBefore);
});

test('monitor atualiza saldo e posição FBA separadamente das janelas de pedidos e finanças', async t => {
  const f = await fixture(t);
  f.client.listTransactions = async function* () { yield {rawBody:JSON.stringify({payload:{transactions:[]}})}; };
  f.client.listFinancialEventGroups = async function* () { yield {rawBody:JSON.stringify({payload:{FinancialEventGroupList:[{FinancialEventGroupId:'g',ProcessingStatus:'Open',OriginalTotal:{CurrencyCode:'BRL',CurrencyAmount:'12.34'}}]}})}; };
  f.client.getInventorySummaries = async function* () {};
  const result = await runMonitorCycle(f);
  assert.equal(result.lastErrorCode,null);
  assert.deepEqual(f.collections.map(call=>call.sources),[['orders'],['transactions'],['fba-inventory']]);
  assert.equal(f.collections[2].window,undefined);
  assert.equal(f.repository.dashboard({storeId:config.storeId}).accountBalance.byCurrency[0].totalCents,'1234');
});
