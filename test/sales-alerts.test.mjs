import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { salesAlertSignals } from '../src/domain/sales-alert-signals.mjs';
import { ensureSalesAlertSchema,syncSalesAlerts,salesAlertsView,saveSalesAlert,validateSalesAlertAction } from '../src/domain/sales-alerts.mjs';
import { renderSalesAlerts } from '../public/sales-alerts.js';
import { copyAsinButton,renderProductSales,createProductSalesState } from '../public/product-sales.js';
import { productSales } from '../src/domain/product-sales.mjs';

const DAY=86400000,now='2026-10-02T12:00:00Z',today=Date.parse('2026-10-02T03:00:00Z');
const coverage=(storeId='a',to='2026-10-02T03:00:00Z')=>({storeId,source:'orders',status:'api-pages-complete',dateBasis:'created',from:'2026-01-01T03:00:00Z',to});
const series=(sku,units,{storeId='a',channel='DBA',anchor=today}={})=>Array.from({length:60},(_,i)=>({storeId,orderId:`${sku}-${channel}-${i}`,status:'SHIPPED',fulfillmentMode:channel,createdAt:new Date(anchor-(i+1)*DAY+5*3600000).toISOString(),items:[{sku,title:`Produto ${sku}`,asin:'B07GPRWFC5',quantityOrdered:units(i+1)}]}));
const input=(orders,extra={})=>({orders,coverage:[coverage()],storeIds:['a'],now,...extra});
const analyze=(orders,extra)=>salesAlertSignals(input(orders,extra));
const stock=(sellerSku,quantity,extra={})=>({storeId:'a',sellerSku,observedAt:now,inventoryDetails:{fulfillableQuantity:quantity},...extra});
const dbFor=t=>{const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE stores(store_id TEXT PRIMARY KEY);INSERT INTO stores VALUES('a'),('b');CREATE TABLE entities(source TEXT,active INTEGER,payload_json TEXT);");ensureSalesAlertSchema(db);t.after(()=>db.close());return db;};

test('daily signals distinguish stopped, persistent drop and surge, isolate channel and store',()=>{
  const orders=[...series('stopped',d=>d<=8?0:4),...series('drop',d=>d<=10?2:10),...series('surge',d=>d<=10?12:3),...series('drop',()=>10,{channel:'FBA'}),...series('drop',()=>10,{storeId:'b'})];
  const result=analyze(orders),bySku=new Map(result.products.filter(p=>p.channel==='DBA').map(p=>[p.sku,p]));
  assert.equal(bySku.get('stopped').type,'stopped');assert.equal(bySku.get('drop').type,'drop');assert.equal(bySku.get('surge').type,'surge');
  assert.equal(result.products.find(p=>p.channel==='FBA').type,null);assert.ok(result.products.every(p=>p.storeId==='a'));
  assert.equal(bySku.get('drop').periodDays,7);assert.equal(bySku.get('drop').units,14);assert.equal(bySku.get('drop').daily.length,35);
});
test('old catalogue, tiny volume, day-in-progress and one-day spikes do not flood alerts',()=>{
  const orders=[...series('tiny',d=>[2,8].includes(d)?1:0),...series('steady',()=>3),...series('spike',d=>d===1?100:3),...series('spike2',d=>d===3?100:3),...series('old',d=>d===60?100:0)];
  orders.push({...series('future',()=>999)[0],createdAt:now});
  assert.deepEqual(analyze(orders).products.filter(p=>p.type).map(p=>p.sku),[]);
  const older=series('historic',()=>100).map(o=>({...o,createdAt:'2025-10-01T12:00:00Z'}));
  assert.equal(analyze(older).products.length,0);
});
test('low-frequency products use 14 days and normalized daily rates',()=>{
  const result=analyze(series('slow',d=>d<=15?(d%7===0?1:0):(d%4===0?3:0))).products[0];
  assert.equal(result.periodDays,14);assert.equal(result.type,'drop');
  assert.equal(result.averageDaily,result.units/14);assert.equal(result.baselineDaily,result.baselineUnits/28);
});
test('incomplete or stale history and invalid quantities never mean zero sales; cancelled excluded',()=>{
  const stopped=series('stopped',d=>d<10?0:5);
  assert.equal(analyze(stopped,{coverage:[coverage('a','2026-10-01T03:00:00Z')]}).products.length,0);
  const incomplete=[coverage('a','2026-09-20T03:00:00Z'),{...coverage(),from:'2026-09-22T03:00:00Z'}];
  assert.equal(analyze(stopped,{coverage:incomplete}).stores[0].ready,false);
  assert.equal(analyze([...stopped,{...series('invalid',()=>1)[0],items:[{sku:'invalid',quantityOrdered:-1}]}]).stores[0].ready,false);
  const excluded=series('cancelled',d=>d<=10?100:2).map(o=>({...o,status:'CANCELED'}));
  assert.equal(analyze(excluded).products.length,0);
});
test('known FBA stockout suppresses demand-fall alerts while unknown stock stays explicit',()=>{
  const orders=series('fba',d=>d<=8?0:4,{channel:'FBA'});
  const empty=analyze(orders,{inventory:[stock('fba',0)]}).products[0];
  assert.equal(empty.type,null);assert.equal(empty.resolution,'stockout');assert.equal(empty.resolved,true);
  const unknown=analyze(orders,{inventory:[stock('fba',0,{observedAt:'2026-09-01T00:00:00Z'})]}).products[0];
  assert.equal(unknown.type,'stopped');assert.equal(unknown.stock,null);
  assert.equal(analyze(orders,{inventory:[stock('fba',5),stock('fba',0)]}).products[0].stock,null);
});
test('acknowledgement stays seen on identical reruns and rolling dates, with no duplicates',t=>{
  const db=dbFor(t),orders=series('drop',d=>d<=10?2:10);
  syncSalesAlerts(db,input(orders));const first=salesAlertsView(db).items[0];
  saveSalesAlert(db,{id:first.id,storeId:'a',expectedVersion:1,action:'seen'},now);
  syncSalesAlerts(db,input(orders));syncSalesAlerts(db,input(orders));
  assert.equal(salesAlertsView(db).counts.new,0);assert.equal(salesAlertsView(db,{status:'seen'}).items[0].version,2);
  const nextDay=new Date(Date.parse(now)+DAY).toISOString(),nextOrders=series('drop',d=>d<=10?2:10,{anchor:today+DAY});
  syncSalesAlerts(db,input(nextOrders,{now:nextDay,coverage:[coverage('a','2026-10-03T03:00:00Z')]}));
  assert.equal(salesAlertsView(db).counts.seen,1);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sales_alerts').get().n,1);
});
test('worsening to stopped reopens once and a continued stop never repeatedly alerts',t=>{
  const db=dbFor(t);syncSalesAlerts(db,input(series('x',d=>d<=10?2:10)));const first=salesAlertsView(db).items[0];
  saveSalesAlert(db,{id:first.id,storeId:'a',expectedVersion:first.version,action:'seen'},now);
  const stopped=input(series('x',d=>d<=10?0:10));syncSalesAlerts(db,stopped);
  const reopened=salesAlertsView(db).items[0];assert.equal(reopened.type,'stopped');assert.equal(reopened.changeReason,'changed');
  saveSalesAlert(db,{id:reopened.id,storeId:'a',expectedVersion:reopened.version,action:'seen'},now);
  syncSalesAlerts(db,stopped);assert.equal(salesAlertsView(db).counts.new,0);
});
test('snoozes survive reruns and expire only at their requested time; recovery resolves',t=>{
  const db=dbFor(t),orders=series('x',d=>d<=10?2:10);syncSalesAlerts(db,input(orders));const first=salesAlertsView(db).items[0];
  saveSalesAlert(db,{id:first.id,storeId:'a',expectedVersion:1,action:'snooze',days:7},now);
  syncSalesAlerts(db,input(orders));assert.equal(salesAlertsView(db).counts.snoozed,1);
  const future=new Date(Date.parse(now)+7*DAY).toISOString();
  syncSalesAlerts(db,input(series('x',d=>d<=10?2:10,{anchor:today+7*DAY}),{now:future,coverage:[coverage('a','2026-10-09T03:00:00Z')]}));
  assert.equal(salesAlertsView(db).items[0].changeReason,'reminder');
  syncSalesAlerts(db,input(series('x',()=>10)));assert.equal(salesAlertsView(db).counts.resolved,1);
  syncSalesAlerts(db,input(orders));assert.equal(salesAlertsView(db).items[0].episode,2);assert.equal(salesAlertsView(db).items[0].changeReason,'recurrence');
});
test('same-type changes need significant volume and a seven-day quiet period',t=>{
  const db=dbFor(t);syncSalesAlerts(db,input(series('drop',d=>d<=10?5:12)));
  const first=salesAlertsView(db).items[0];assert.equal(first.type,'drop');
  saveSalesAlert(db,{id:first.id,storeId:'a',expectedVersion:first.version,action:'seen'},now);
  syncSalesAlerts(db,input(series('drop',d=>d<=10?1:12)));assert.equal(salesAlertsView(db).counts.seen,1,'no repeated alert during quiet period');
  const future=new Date(Date.parse(now)+8*DAY).toISOString(),advanced={now:future,coverage:[coverage('a','2026-10-10T03:00:00Z')]};
  syncSalesAlerts(db,input(series('drop',d=>d<=10?4:12,{anchor:today+8*DAY}),advanced));assert.equal(salesAlertsView(db).counts.seen,1,'small movement is not a new alert');
  syncSalesAlerts(db,input(series('drop',d=>d<=10?1:12,{anchor:today+8*DAY}),advanced));assert.equal(salesAlertsView(db).items[0].changeReason,'changed');
});
test('pending data preserves alerts and acknowledgement; writes enforce identity and versions',t=>{
  const db=dbFor(t),orders=series('x',d=>d<=10?2:10);syncSalesAlerts(db,input(orders));const row=salesAlertsView(db).items[0];
  assert.throws(()=>saveSalesAlert(db,{id:row.id,storeId:'b',expectedVersion:1,action:'seen'},now),{code:'CASE_NOT_FOUND'});
  assert.throws(()=>saveSalesAlert(db,{id:row.id,storeId:'a',expectedVersion:5,action:'seen'},now),{code:'REVIEW_CONFLICT'});
  for(const patch of [{action:'delete'},{days:1,action:'snooze'},{storeId:'all'},{extra:1},{expectedVersion:-1}])assert.throws(()=>validateSalesAlertAction({id:row.id,storeId:'a',expectedVersion:1,action:'seen',...patch}),TypeError);
  syncSalesAlerts(db,input([],{coverage:[]}));assert.equal(salesAlertsView(db).counts.new,1);
});
test('saved states persist across database connections and scoped lists do not mix stores',t=>{
  const dir=mkdtempSync(path.join(tmpdir(),'sales-alerts-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'state.sqlite');let db=new DatabaseSync(file);
  db.exec("CREATE TABLE stores(store_id TEXT PRIMARY KEY);INSERT INTO stores VALUES('a'),('b');CREATE TABLE entities(source TEXT,active INTEGER,payload_json TEXT);");ensureSalesAlertSchema(db);
  syncSalesAlerts(db,input([...series('x',d=>d<=10?2:10),...series('x',d=>d<=10?2:10,{storeId:'b'})],{storeIds:['a','b'],coverage:[coverage(),coverage('b')]}));
  const row=salesAlertsView(db,{storeId:'a'}).items[0];saveSalesAlert(db,{id:row.id,storeId:'a',expectedVersion:row.version,action:'seen'},now);db.close();
  db=new DatabaseSync(file);try{assert.equal(salesAlertsView(db,{storeId:'a',status:'seen'}).items.length,1);assert.equal(salesAlertsView(db,{storeId:'b'}).items.length,1);}finally{db.close();}
});
test('cards explain periods and action states, escape product data, and ASIN copy stays beside the product link',t=>{
  const db=dbFor(t);syncSalesAlerts(db,input(series('<script>',d=>d<=10?2:10)));
  const html=renderSalesAlerts(salesAlertsView(db),{status:'new',mode:'all',type:'all',query:''},{storeName:()=>'<Loja>',inventoryAsinLink:asin=>`<a href="https://www.amazon.com.br/dp/${asin}">${asin}</a>`});
  assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);assert.match(html,/Marcar como visto/);assert.match(html,/data-days="30"/);assert.match(html,/data-copy-asin="B07GPRWFC5"/);
  assert.equal(copyAsinButton('bad" id'), '');assert.match(copyAsinButton('b07gprwfc5'),/aria-label="Copiar ASIN B07GPRWFC5"/);
  const sales=productSales(input(series('rank',()=>2)));
  const ranking=renderProductSales(sales,createProductSalesState(),{storeName:id=>id,inventoryAsinLink:id=>`<a>${id}</a>`});
  assert.match(ranking,/<a>B07GPRWFC5<\/a> <button[^>]*data-copy-asin="B07GPRWFC5"/);
});
