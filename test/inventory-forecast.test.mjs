import test from 'node:test';
import assert from 'node:assert/strict';
import { inventoryForecast } from '../src/domain/inventory-forecast.mjs';
import { stockPlan, inventoryPlanningPreferences, planningCells, planningControls, matchesInventoryAlert, sortInventoryItems } from '../public/inventory-planning.js';

const now = '2026-10-01T12:00:00.000Z';
const prefs = { period: 30, leadDays: 7, bufferDays: 8, alert: 'all' };
const stock = (storeId = 'a', available = 14, extra = {}) => ({ storeId, sellerSku: 'SKU-A', asin: 'SAME-ASIN', observedAt: now,
  inventoryDetails: { fulfillableQuantity: available, inboundShippedQuantity: 300, reservedQuantity: { totalReservedQuantity: 200 } }, ...extra });
const sale = (quantityOrdered = 30, extra = {}) => ({ storeId: 'a', fulfillmentMode: 'FBA', status: 'SHIPPED', createdAt: '2026-09-20T12:00:00Z', items: [{ sku: 'SKU-A', quantityOrdered }], ...extra });
const history = (storeId = 'a', extra = {}) => ({ storeId, source: 'orders', dateBasis: 'created', status: 'api-pages-complete', from: '2026-06-01T03:00:00Z', to: '2026-10-01T03:00:00Z', ...extra });
const forecast = (extra = {}) => inventoryForecast({ items: [stock()], orders: [sale()], coverage: [history()], now, ...extra });

test('FBA coverage uses units and sellable stock, isolates stores and excludes unconfirmed or other-channel orders', () => {
  const result = forecast({ items: [stock(), stock('b')], coverage: [history(), history('b')], orders: [sale(), sale(60, { storeId: 'b' }),
    sale(500, { fulfillmentMode: 'DBA' }), sale(500, { fulfillmentMode: 'MFN' }), ...['CANCELED','CANCELLED','PENDING','PENDING_AVAILABILITY'].map(status => sale(500, { status }))] });
  assert.equal(result.items[0].salesForecast[30].units, 30);
  assert.equal(result.items[0].salesForecast[30].daysRemaining, 14);
  assert.equal(result.items[0].salesForecast[30].stockoutDay, '2026-10-15');
  assert.equal(stockPlan(result.items[0], prefs).status, 'replenish');
  assert.equal(result.items[1].salesForecast[30].daysRemaining, 7);
  assert.equal(stockPlan(result.items[1], prefs).status, 'urgent');
});

test('30/60/90-day windows use complete São Paulo days and never round daily demand before division', () => {
  const result = forecast({ items: [stock('a', 2)], orders: [sale(1, { createdAt: '2026-09-01T03:00:00Z' }),
    sale(4, { createdAt: '2026-09-01T02:59:59Z' }), sale(8, { createdAt: '2026-07-10T12:00:00Z' }),
    sale(1, { createdAt: '2026-10-01T02:59:59Z' }), sale(999, { createdAt: '2026-10-01T03:00:00Z' })] }).items[0].salesForecast;
  assert.equal(result[30].from, '2026-09-01'); assert.equal(result[30].to, '2026-09-30');
  assert.equal(result[30].units, 2); assert.equal(result[60].units, 6); assert.equal(result[90].units, 14);
  assert.equal(result[30].daysRemaining, 30);
});

test('updated-only, partial and gapped history never become false zero-sales forecasts', () => {
  for (const coverage of [[], [history('a', { dateBasis: 'updated' })], [history('a', { status: 'partial' })],
    [history('a', { to: '2026-09-15T03:00:00Z' }), history('a', { from: '2026-09-16T03:00:00Z' })]]) {
    const item = forecast({ orders: [], coverage }).items[0];
    assert.equal(item.salesForecast[30].reason, 'incomplete-history');
    assert.equal(stockPlan(item, prefs).status, 'unknown');
  }
});

test('complete incremental updates extend a known creation baseline without bridging gaps', () => {
  const baseline = history('a', { to: '2026-09-20T03:00:00Z' });
  const update = history('a', { dateBasis: 'updated', from: '2026-09-19T03:00:00Z' });
  assert.equal(forecast({ coverage: [baseline, update] }).items[0].salesForecast[30].reason, null);
  const gap = forecast({ coverage: [baseline, { ...update, from: '2026-09-21T03:00:00Z' }] }).items[0].salesForecast[30];
  assert.equal(gap.reason, 'stale-history'); assert.equal(gap.to, '2026-09-19');
  const partial = forecast({ coverage: [baseline, { ...update, status: 'partial' }] }).items[0].salesForecast[30];
  assert.equal(partial.reason, 'stale-history');
});

test('zero demand, zero stock, unavailable quantities and stale observations remain distinct', () => {
  const noSales = forecast({ orders: [] }).items[0];
  assert.equal(stockPlan(noSales, prefs).status, 'no_sales'); assert.equal(noSales.salesForecast[30].daysRemaining, null);
  const empty = forecast({ items: [stock('a', 0)], orders: [], coverage: [] }).items[0];
  assert.equal(stockPlan(empty, prefs).status, 'out');
  for (const n of [null, undefined, -1, 1.2]) assert.equal(forecast({ items: [stock('a', n, { inventoryDetails: { fulfillableQuantity: n } })] }).items[0].salesForecast[30].reason, 'unknown-stock');
  for (const observedAt of ['2026-09-27T12:00:00Z','2026-10-02T12:00:00Z',null]) {
    const item = forecast({ items: [stock('a', 0, { observedAt })] }).items[0];
    assert.equal(item.salesForecast[30].reason, 'stale-stock'); assert.equal(stockPlan(item, prefs).status, 'unknown');
  }
});

test('missing data and ambiguous stock rows cannot produce reassuring predictions', () => {
  for (const order of [sale(null), sale(2, { createdAt: null }), sale(2, { status: null })]) {
    const f = forecast({ orders: [order] }).items[0].salesForecast[30];
    assert.equal(f.reason, 'incomplete-sales'); assert.equal(f.daysRemaining, null); assert.equal(f.units, null);
  }
  assert.equal(forecast({ items: [stock(),stock()] }).items[0].salesForecast[30].reason, 'ambiguous-sku');
  assert.equal(forecast({ items: [stock('a', 14, { sellerSku: null })] }).items[0].salesForecast[30].reason, 'missing-sku');
  const separate = forecast({ items: [stock(),stock('a', 10, { sellerSku: 'SKU-B' })] }).items;
  assert.equal(separate[1].salesForecast[30].units, 0, 'Same ASIN does not merge SKUs');
});

test('planning thresholds and schedule retain the scheduling-to-sale lead plus safety margin', () => {
  const item = forecast({ items: [stock('a', 20)] }).items[0];
  assert.deepEqual(inventoryPlanningPreferences(), prefs);
  assert.equal(stockPlan(item, prefs).status, 'covered');
  assert.equal(stockPlan(item, { ...prefs, bufferDays: 13 }).status, 'replenish');
  assert.equal(stockPlan(item, { ...prefs, leadDays: 20 }).status, 'urgent');
  const helpers = { number: String, date: String, localDay: () => '2026-10-01', addDays: (value, n) => new Date(Date.parse(value + 'T12:00:00Z') + n * 86400000).toISOString().slice(0,10) };
  assert.match(planningCells(item, prefs, helpers), /Agendar até 2026-10-06/);
  assert.match(planningCells(item, { ...prefs, bufferDays: 13 }, helpers), /Agendar agora/);
  const original = [stock()]; const copy = structuredClone(original);
  forecast({ items: original }); assert.deepEqual(original, copy);
});

test('no-sales alert includes only sellable stock with complete and recent zero-sales evidence', () => {
  for (const available of [0,14]) {
    const item = forecast({ items:[stock('a',available)],orders:[] }).items[0];
    assert.equal(stockPlan(item,prefs).noSales,available>0);
    assert.equal(matchesInventoryAlert(item,prefs,'no_sales'),available>0);
    assert.equal(matchesInventoryAlert(item,prefs,'out'),available===0);
  }
  for (const options of [{coverage:[]},{coverage:[history('a',{to:'2026-09-10T03:00:00Z'})]}, {items:[stock(),stock()]},
    {items:[stock('a',14,{observedAt:'2026-09-20T12:00:00Z'})]}, {items:[stock('a',null)]}]) {
    const item=forecast({orders:[],...options}).items[0];
    assert.equal(matchesInventoryAlert(item,prefs,'no_sales'),false);
  }
  assert.equal(matchesInventoryAlert(forecast().items[0],prefs,'restock'),true);
  assert.equal(matchesInventoryAlert(forecast({items:[stock('a',7)]}).items[0],prefs,'restock'),true);
  assert.equal(matchesInventoryAlert(forecast({items:[stock('a',70)]}).items[0],prefs,'restock'),false);
});

test('duration sort uses numeric forecasts in the chosen period, leaves missing values last in both directions, and does not mutate data', () => {
  const item=(sku,days30,days60)=>({sellerSku:sku,storeId:'a',salesForecast:{30:{daysRemaining:days30},60:{daysRemaining:days60}}});
  const items=[item('unknown',null,null),item('twelve',12,4),item('two',2,7),item('zero',0,0),item('missing',undefined,undefined)];
  const original=structuredClone(items);
  assert.deepEqual(sortInventoryItems(items,prefs,'asc').map(i=>i.sellerSku),['zero','two','twelve','missing','unknown']);
  assert.deepEqual(sortInventoryItems(items,prefs,'desc').map(i=>i.sellerSku),['twelve','two','zero','missing','unknown']);
  assert.deepEqual(sortInventoryItems(items,{...prefs,period:60},'desc').map(i=>i.sellerSku),['two','twelve','zero','missing','unknown']);
  assert.deepEqual(items,original);
});

test('coverage bands preserve restocking needs, include day 35 as ideal and day 60 as good, and alert only above 60',()=>{
  for(const [available,units,expected] of [[0,30,'out'],[7,30,'urgent'],[15,30,'replenish'],[16,30,'covered'],[35,30,'covered'],[351,300,'good'],[60,30,'good'],[601,300,'excess'],[61,30,'excess'],[35,0,'no_sales']]) {
    const item=forecast({items:[stock('a',available)],orders:[sale(units)]}).items[0];
    assert.equal(stockPlan(item,prefs).status,expected,`${available} available / ${units} units in 30 days`);
    assert.equal(matchesInventoryAlert(item,prefs,'excess'),expected==='excess');
    assert.equal(matchesInventoryAlert(item,prefs,'good'),expected==='good');
    assert.equal(matchesInventoryAlert(item,prefs,'covered'),expected==='covered');
  }
  for(const options of [{coverage:[]},{items:[stock('a',120,{observedAt:'2026-09-20T12:00:00Z'})]}]) {
    const item=forecast({items:[stock('a',120)],...options}).items[0];
    assert.equal(stockPlan(item,prefs).status,'unknown');assert.equal(matchesInventoryAlert(item,prefs,'excess'),false);
  }
});

test('excess badge and filter follow the selected sales window and do not invite replenishment',()=>{
  const item=forecast({items:[stock('a',35)]}).items[0];
  assert.equal(stockPlan(item,prefs).label,'Estoque ideal');
  const sixty={...prefs,period:60};
  assert.equal(stockPlan(item,sixty).status,'excess');
  const helpers={number:String,date:String,localDay:()=> '2026-10-01',addDays:()=>assert.fail('excess must not suggest a restock date')};
  const html=planningCells(item,sixty,helpers);
  assert.match(html,/inventory-alert-badge excess/);assert.match(html,/70 dias/);assert.match(html,/Acima de 60 dias de estoque/);
  assert.match(html,/Revisar giro antes de repor/);assert.doesNotMatch(html,/Agendar/);
  const controls=planningControls([item],sixty);
  assert.match(controls,/Ideal: <strong>35 dias/);assert.match(controls,/Bom: <strong>até 60 dias/);
  assert.match(controls,/data-inventory-alert="excess"[^>]*><span>Excesso de estoque<\/span><b>1<\/b>/);
});
