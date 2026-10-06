import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Repository } from '../src/domain/repository.mjs';
import { recordTrackingObservation } from '../src/domain/returns.mjs';
import { saveCustomerReturnJob,importCustomerReturnReport } from '../src/domain/customer-returns.mjs';
import { parseStoreSelection,canonicalStoreSelection,restoreStoreSelection } from '../public/store-selection.js';
import { selectInventoryItems } from '../public/inventory-planning.js';
import { createInventoryReport } from '../public/inventory-report.js';
import { scopeRepository } from '../src/web/store-scope.mjs';
import { createRepositoryWorkers } from '../src/web/repository-worker.mjs';
import { startWebServer } from '../src/web/server.mjs';

function fixture(t) {
  const root=mkdtempSync(path.join(os.tmpdir(),'multi-store-'));
  const stores=['a','b','c'].map(storeId=>({storeId,name:`Loja ${storeId.toUpperCase()}`}));
  const repo=new Repository({rootDir:root,dbPath:path.join(root,'synthamazon.sqlite'),stores});
  t.after(()=>{repo.close();rmSync(root,{recursive:true,force:true});});
  const now='2026-10-05T12:00:00Z',reportType='GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE';
  const insert=(store,source,id,row)=>repo.db.prepare('INSERT INTO entities VALUES(?,?,?,?,?,?,?,?,?)').run(store,source,id,now,now,'fixture',row.status||null,1,JSON.stringify(row));
  for (const [index,{storeId}] of stores.entries()) {
    const quantity=[1,2,100][index];
    repo.db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?)').run(storeId,'fixture','hash',now,now,'collected');
    for(const source of ['orders','fba-inventory'])repo.db.prepare('INSERT INTO coverage VALUES(?,?,?,?,?,?,?,?,?,?)').run(storeId,'fixture',source,'api-pages-complete','created','2026-01-01T03:00:00Z',now,now,1,1);
    insert(storeId,'orders','same-order',{storeId,orderId:'same-order',createdAt:now,status:'SHIPPED',fulfillmentMode:'DBA',grandTotalCents:String(quantity*10000),currency:'BRL',items:[{sku:'SAME',title:'Produto',quantityOrdered:quantity,unitPriceCents:'10000',unitPriceCurrency:'BRL'}],packages:[],observedAt:now});
    for(const [type,amount] of [['Shipment',quantity*9000],['Refund',-quantity*8000],['ServiceFee',-100]])insert(storeId,'transactions',type,{storeId,transactionId:type,orderIds:['same-order'],type,status:'RELEASED',totalCents:String(amount),currency:'BRL',postedAt:now,countsAsSales:type==='Shipment'});
    insert(storeId,'fba-inventory','SAME',{storeId,sellerSku:'SAME',title:'Produto',totalQuantity:quantity,observedAt:now,inventoryDetails:{fulfillableQuantity:quantity,inboundWorkingQuantity:0,inboundShippedQuantity:0,inboundReceivingQuantity:0,reservedQuantity:{totalReservedQuantity:0,pendingTransshipmentQuantity:0,fcProcessingQuantity:0,pendingCustomerOrderQuantity:0},unfulfillableQuantity:{totalUnfulfillableQuantity:0},researchingQuantity:{totalResearchingQuantity:0}}});
    recordTrackingObservation(repo.db,{storeId,orderId:'same-order',observedAt:'2026-10-05T13:00:00Z',packages:[{packageReferenceId:'p',trackingNumber:'T',status:'DELIVERED',detailedStatus:'RETURNED_TO_SELLER'}]});
    saveCustomerReturnJob(repo.db,{storeId,reportId:'report',reportType,from:'2026-09-01T00:00:00Z',to:now,status:'DONE',createdAt:now,checkedAt:now});
    importCustomerReturnReport(repo.db,{storeId,reportId:'report',reportType,observedAt:now,records:[{orderId:'same-order',sku:'SAME',quantity,returnRequestedAt:'2026-10-05',rmaId:'RMA',productName:'Produto'}]});
    repo.db.prepare('INSERT INTO sales_alert_analysis VALUES(?,?,?,?)').run(storeId,now,'2026-10-04',1);
    repo.db.prepare('INSERT INTO sales_alerts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(storeId.repeat(64),storeId,'SAME','DBA','drop','new',1,1,now,now,now,null,null,null,JSON.stringify({storeId,sku:'SAME',title:'Produto',type:'drop',impactWeekly:quantity}),'detected');
  }
  repo.syncRefundManagement({now:new Date('2026-10-06T12:00:00Z')});
  return {repo,root};
}

test('store combinations are canonical, restored safely and never expand stale saved selections',()=>{
  assert.deepEqual(parseStoreSelection('b,a'),['a','b']);assert.equal(canonicalStoreSelection('b,a'),'a,b');
  assert.equal(restoreStoreSelection('b,a',['a','b','c']),'a,b');
  assert.equal(restoreStoreSelection('a,b,c',['a','b','c']),'all');
  assert.equal(restoreStoreSelection('a,b',['a']),null);
  for(const value of ['', 'a,',',a','a,a','all,a','a,../b',42])assert.throws(()=>parseStoreSelection(value));
});

test('every report combines only the selected stores before totals, sorting, pagination and export',async t=>{
  const {repo}=fixture(t),filters={storeId:'b,a',limit:500};
  const stores=items=>[...new Set(items.map(item=>item.storeId))].sort();
  const dash=repo.dashboard(filters);assert.equal(dash.counts.orders,2);assert.equal(dash.salesByCurrency[0].grandTotalCents,'30000');
  assert.deepEqual(stores(dash.coverage),['a','b']);
  assert.equal(repo.orders({...filters,limit:1}).total,2);assert.equal(repo.orders({...filters,limit:1,offset:1}).items.length,1);
  assert.equal(repo.orders({storeId:'c'}).total,1);assert.equal(repo.orders(filters).total,2);
  for(const rows of [repo.orders(filters).items,repo.dashboardTransactions(filters).items,repo.inventory(filters).items,
    repo.financialCases('refunds',filters).items,repo.financialCases('charges',filters).items,repo.customerReturns(filters).items,
    repo.safeTCases(filters).items,repo.refundManagement({...filters,workflow:'all'}).items,(await repo.returns({...filters,workflow:'all'})).items,
    repo.salesAlerts(filters).items])assert.deepEqual(stores(rows),['a','b']);
  assert.equal(repo.refundManagement({...filters,workflow:'all'}).summary.workflowCounts.all,2);
  assert.deepEqual(stores(repo.salesAlerts(filters).analysis),['a','b']);assert.equal(repo.salesAlerts(filters).counts.new,2);
  const stock=repo.inventory({...filters,forecast:'true'});assert.equal(stock.summary.usableQuantity,3);assert.equal(stock.items.length,2);
  const preferences={period:30,leadDays:7,bufferDays:8,alert:'all'};
  const displayed=selectInventoryItems(stock.items,{storeId:'a,b'},preferences);assert.equal(displayed.length,2);
  const csv=createInventoryReport(displayed,{preferences,storeId:'a,b',stores:repo.listStores(),collectionState:stock.state});
  assert.equal(csv.count,2);assert.match(csv.filename,/lojas-selecionadas/);assert.doesNotMatch(csv.csv,/Loja C/);
  const sales=repo.productSales({...filters,channels:'DBA,MFN',from:'2026-10-05',to:'2026-10-05'});
  const custom=sales.views.find(view=>view.key==='custom');assert.equal(custom.summary.units,3);
  assert.deepEqual(stores(custom.items),['a','b']);
  const c=repo.db.prepare("SELECT * FROM sales_alert_analysis WHERE store_id='c'").get();
  repo.syncSalesAlerts(filters,new Date('2026-10-06T12:00:00Z'));
  assert.deepEqual(repo.db.prepare("SELECT * FROM sales_alert_analysis WHERE store_id='c'").get(),c);
});

test('HTTP accepts combinations for collections but never for a detail or store-scoped session',async t=>{
  const {repo}=fixture(t),app=await startWebServer({repository:repo,rootDir:path.resolve('.')});
  t.after(()=>new Promise(resolve=>app.server.close(resolve)));
  const landing=await fetch(app.url,{redirect:'manual'}),cookie=landing.headers.get('set-cookie').split(';')[0],origin=new URL(app.url).origin;
  const get=route=>fetch(origin+route,{headers:{cookie}});
  for(const route of ['dashboard','dashboard/transactions','orders','inventory','product-sales','returns','refunds','charges','customer-returns','safe-t','refund-management','sales-alerts'])
    assert.equal((await get(`/api/${route}?storeId=a,b`)).status,200,route);
  for(const value of ['a,','a,a','all,a','a,%27'])assert.equal((await get(`/api/inventory?storeId=${value}`)).status,400);
  assert.equal((await get('/api/orders/same-order?storeId=a,b')).status,400);
  const scope=scopeRepository(repo,'a');assert.throws(()=>scope.inventory({storeId:'a,b'}),{code:'FORBIDDEN'});
  assert.equal(scope.inventory({storeId:'all'}).items.length,1);
});

test('worker bootstrap preserves the store restriction and multi-store stock reads stay scoped',async t=>{
  const {repo,root}=fixture(t),workers=await createRepositoryWorkers({rootDir:root,dbPath:path.join(root,'synthamazon.sqlite')});
  try {
    const scoped=scopeRepository(workers,'a');assert.deepEqual((await scoped.getBootstrap()).stores.map(s=>s.storeId),['a']);
    assert.equal((await workers.inventory({storeId:'b,a'})).summary.usableQuantity,3);
  } finally { await workers.close(); }
});
