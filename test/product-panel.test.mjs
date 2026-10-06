import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { productPanel, panelRange } from '../src/domain/product-panel.mjs';
import { Repository } from '../src/domain/repository.mjs';
import { createRepositoryWorkers } from '../src/web/repository-worker.mjs';
import { startWebServer } from '../src/web/server.mjs';
import { panelDates, createProductPanelState, renderProductPanel } from '../public/product-panel.js';
const now='2026-10-06T12:00:00Z',FBA='GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA',MFN='GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE';
const item=(extra={})=>({sku:'SKU-A',asin:'B000000001',title:'Produto A',quantityOrdered:1,unitPriceCurrency:'BRL',unitPriceCents:'1000',...extra});
const order=(id,extra={})=>({storeId:'a',orderId:id,status:'SHIPPED',fulfillmentMode:'DBA',createdAt:'2026-09-20T12:00:00Z',items:[item()],...extra});
const ret=(id,extra={})=>({storeId:'a',returnId:'r-'+id,orderId:id,sku:'SKU-A',asin:'B000000001',reportType:MFN,returnRequestedAt:'2026-09-25',reasonCode:'CR-DEFECTIVE',quantity:1,...extra});
const coverage=['a','b'].map(storeId=>({storeId,source:'orders',status:'api-pages-complete',dateBasis:'created',from:'2026-01-01T03:00:00Z',to:now}));
const returnJobs=['a','b'].flatMap(storeId=>[FBA,MFN].map(reportType=>({storeId,reportType,status:'IMPORTED',from:'2026-01-01T03:00:00Z',to:now,warningCount:0})));
const run=extra=>productPanel({orders:[],coverage,returns:[],returnJobs,storeIds:['a'],from:'2026-09-01',to:'2026-09-30',now,...extra});

test('ASINs unite selected stores and SKUs while order identities remain scoped; unknown prices stay unknown',()=>{
  const orders=[order('same',{items:[item({quantityOrdered:2}),item({sku:'SKU-A2',quantityOrdered:3})]}),order('same',{storeId:'b',items:[item({quantityOrdered:4,unitPriceCents:null})]}),
    order('fba',{fulfillmentMode:'FBA',items:[item({asin:'B000000002',quantityOrdered:5})]}),order('pending',{status:'PENDING'}),order('cancelled',{status:'CANCELED'})];
  const data=run({orders,storeIds:['a','b']});
  assert.equal(data.summary.units,14);assert.equal(data.summary.orders,3);assert.equal(data.summary.products,2);
  assert.equal(data.summary.grossCents,'10000');assert.equal(data.summary.unpricedUnits,4);
  assert.equal(data.rankings.sales[0].units,9);assert.equal(data.rankings.sales[0].orders,2);assert.deepEqual(data.rankings.sales[0].skus,['SKU-A','SKU-A2']);
  assert.equal(run({orders}).summary.units,10);assert.equal(run({orders,channels:['FBA']}).summary.units,5);
  assert.equal(data.daily.reduce((n,d)=>n+d.units,0),14);
});
test('return ranking deduplicates orders and reimports, respects dates, channels, cancellation and unknown records',()=>{
  const orders=[order('one'),order('two',{fulfillmentMode:'FBA'}),order('old',{createdAt:'2026-06-01T12:00:00Z'})];
  const rows=[ret('one'),ret('one'),ret('one',{returnId:'other'}),ret('two',{reportType:FBA,returnReceivedAt:'2026-09-30T23:00:00-03:00'}),
    ret('old'),ret('cancel',{returnStatus:'Cancelled'}),ret('future',{returnRequestedAt:'2026-10-20'}),ret('no-date',{returnRequestedAt:null})];
  const data=run({orders,returns:rows});
  assert.equal(data.summary.returnOrders,3);assert.equal(data.summary.sellerReturnOrders,2);assert.equal(data.summary.fbaReturnOrders,1);
  assert.equal(data.rankings.returns[0].returnOrders,3);assert.equal(data.reasons[0].orders,3);assert.equal(data.quality.undatedReturns,1);
  assert.equal(run({orders,returns:rows,channels:['FBA']}).summary.returnOrders,1);
  assert.equal(run({orders,returns:rows,channels:['DBA']}).summary.returnOrders,2);
});
test('observed rate uses the sales cohort, includes later returns, excludes unrelated items, old sales and other stores',()=>{
  const orders=Array.from({length:10},(_,i)=>order(String(i)));
  orders.push(order('old',{createdAt:'2026-06-01T12:00:00Z'}),order('0',{storeId:'b'}));
  const returns=[ret('0'),ret('1',{returnRequestedAt:'2026-10-02'}),ret('old'),ret('2',{sku:'WRONG',asin:'B000000002'}),ret('3',{storeId:'b'})];
  const data=run({orders,returns});
  assert.equal(data.summary.returnOrders,3);assert.equal(data.summary.cohortReturnOrders,2);assert.equal(data.summary.observedReturnRate,20);
  assert.equal(data.rankings.rate[0].orders,10);assert.equal(data.rankings.rate[0].cohortReturnOrders,2);
  assert.equal(data.rankings.rate.length,1);assert.equal(run({orders:orders.slice(0,9),returns}).rankings.rate.length,0);
});
test('calendar bounds, same-day visibility, unknown coverage and partial imports never fake comparisons or averages',()=>{
  assert.equal(panelRange({now:'2026-10-01T02:00:00Z'}).to,'2026-09-29');
  assert.deepEqual(panelDates('previousMonth',new Date('2028-03-01T12:00:00Z')),{from:'2028-02-01',to:'2028-02-29'});
  assert.deepEqual(panelDates('month',new Date('2026-10-01T02:00:00Z')),{from:'2026-09-01',to:'2026-09-30'});
  const data=run({orders:[order('same-day',{createdAt:now})],from:'2026-10-06',to:'2026-10-06'});
  assert.equal(data.summary.units,1);assert.equal(data.summary.averageDaily,null);assert.equal(data.range.ongoing,true);
  const partial=run({orders:[order('a')],coverage:[],returnJobs:[]});
  assert.equal(partial.quality.salesComplete,false);assert.equal(partial.quality.returnsComplete,false);assert.equal(partial.summary.averageDaily,null);assert.equal(partial.rankings.sales[0].changePercent,null);
  for(const dates of [{from:'2026-02-30',to:'2026-03-03'},{from:'2024-01-01',to:'2026-01-01'},{from:'2026-09-02',to:'2026-09-01'},{from:'2026-01-01'},{from:'2026-10-07',to:'2026-10-07'}])assert.throws(()=>panelRange({...dates,now}),TypeError);
});
test('payload is bounded; hostile product text is escaped, date controls preserve channels',()=>{
  const data=run({orders:Array.from({length:150},(_,i)=>order('o'+i,{items:[item({asin:'B'+String(i).padStart(9,'0'),title:'<img src=x onerror=alert(1)>',quantityOrdered:i+1})]}))});
  assert.equal(data.rankings.sales.length,20);assert.equal(data.rankings.revenue.length,20);assert.equal(data.summary.products,150);
  const html=renderProductPanel(data,createProductPanelState(),{storeName:id=>id,inventoryAsinLink:asin=>asin,reasonLabel:id=>id});
  assert.doesNotMatch(html,/<img src=x/);assert.match(html,/&lt;img/);assert.match(html,/name="from"/);assert.match(html,/Taxa observada/);
});
function insert(db,value) {db.prepare('INSERT INTO entities(store_id,source,source_id,observed_at,last_seen_at,version_hash,status,active,payload_json) VALUES(?,?,?,?,?,?,?,?,?)').run(value.storeId,'orders',value.orderId,now,now,'fixture',value.status,1,JSON.stringify(value));}
test('repository cache invalidates after external imports and workers expose the panel',async t=>{
  const dir=mkdtempSync(path.join(tmpdir(),'panel-')),dbPath=path.join(dir,'data.sqlite'),repo=new Repository({rootDir:dir,dbPath,stores:[{storeId:'a',name:'Loja A'},{storeId:'b',name:'Loja B'}]});
  t.after(()=>{repo.close();rmSync(dir,{recursive:true,force:true});});
  insert(repo.db,order('first'));insert(repo.db,order('private',{storeId:'b',items:[item({quantityOrdered:99})]}));
  const filters={storeId:'a',from:'2026-09-01',to:'2026-09-30'};
  assert.equal(repo.productPanel(filters).summary.units,1);
  const other=new DatabaseSync(dbPath);insert(other,order('second',{items:[item({quantityOrdered:2})]}));other.close();
  assert.equal(repo.productPanel(filters).summary.units,3);
  const workers=await createRepositoryWorkers({rootDir:dir,dbPath});
  try {assert.equal((await workers.productPanel(filters)).summary.units,3);}finally{await workers.close();}
});
test('HTTP and assets enforce login, store scope and filter validation',async t=>{
  const calls=[],repo={productPanel:filters=>{calls.push(filters);return {summary:{units:1}};}};
  const app=await startWebServer({repository:repo,rootDir:path.resolve('.'),storeScope:'a'});t.after(()=>new Promise(resolve=>app.server.close(resolve)));
  const origin=new URL(app.url).origin;
  assert.equal((await fetch(origin+'/api/product-panel')).status,403);
  const login=await fetch(app.url,{redirect:'manual'}),cookie=login.headers.get('set-cookie').split(';')[0],headers={cookie};
  assert.equal((await fetch(origin+'/api/product-panel?storeId=all&channels=FBA,DBA&from=2026-09-01&to=2026-09-30',{headers})).status,200);
  assert.equal(calls.at(-1).storeId,'a');
  assert.equal((await fetch(origin+'/api/product-panel?storeId=b',{headers})).status,403);
  for(const query of ['channels=BAD','channels=FBA,FBA','from=2026-09-01','from=2026-09-02&to=2026-09-01','query=secret'])assert.equal((await fetch(origin+'/api/product-panel?'+query,{headers})).status,400);
  for(const asset of ['product-panel.js','product-panel.css']){assert.equal((await fetch(origin+'/'+asset)).status,403);assert.equal((await fetch(origin+'/'+asset,{headers})).status,200);}
});
