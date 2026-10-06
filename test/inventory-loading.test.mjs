import test from 'node:test';
import assert from 'node:assert/strict';
import { loadInventoryRecords } from '../public/list-data.js';

const data = { items: [{ storeId: 'a', sellerSku: 'SKU', totalQuantity: 10 }], total: 1, hasMore: false };
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };

test('inventory quantities render before a delayed forecast; all store scopes and pages are preserved', async () => {
  const forecast = deferred(), visible = deferred(), calls = [];
  const rows = Array.from({ length: 501 }, (_,i) => ({ ...data.items[0], storeId: i % 2 ? 'b' : 'a', sellerSku: `SKU-${i}` }));
  const result = loadInventoryRecords(async url => {
    const params = new URL(url,'http://local').searchParams;
    calls.push(params);
    if (params.has('forecast')) await forecast.promise;
    const offset = Number(params.get('offset'));
    return { ...data, items: rows.slice(offset,offset+500), total:501, hasMore: offset === 0 };
  }, {storeId:'all'}, { onStock: value => visible.resolve(value) });
  const stock = await visible.promise;
  assert.equal(stock.items.length,501); assert.equal(stock.forecastState,'loading');
  forecast.resolve();
  assert.equal((await result).forecastState,'ready');
  assert.deepEqual(calls.map(p=>p.get('offset')),['0','500','0','500']);
  assert.ok(calls.every(p=>p.get('storeId')==='all'));
});

test('forecast failures retain every stock quantity and never disguise a base-stock or authorization error', async () => {
  const failed = await loadInventoryRecords(async url => { if (url.includes('forecast=true')) throw new Error('Gateway timeout'); return data; },{storeId:'all'});
  assert.equal(failed.forecastState,'failed'); assert.deepEqual(failed.items,data.items);
  await assert.rejects(loadInventoryRecords(async()=>{throw new Error('Stock unavailable');},{}),/Stock unavailable/);
  await assert.rejects(loadInventoryRecords(async url=>{if(url.includes('forecast=true')) throw Object.assign(new Error('Expired'),{status:401});return data;},{}),{status:401});
});

test('late stock or forecast responses cannot replace a newly selected store', async () => {
  for (const delayForecast of [false,true]) {
    let current = true, rendered = 0;
    const pending = deferred(), started = deferred();
    const request = loadInventoryRecords(async url => {
      if (url.includes('forecast=true') === delayForecast) { started.resolve(); await pending.promise; }
      return data;
    },{storeId:'a'},{isCurrent:()=>current,onStock:()=>rendered++});
    await started.promise; current=false; pending.resolve();
    assert.equal(await request,null); assert.equal(rendered,Number(delayForecast));
  }
});
