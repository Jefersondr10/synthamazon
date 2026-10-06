import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { costCatalogue, ProductCostReader, inventoryCost, inventoryCostSummary, orderCost } from '../src/domain/product-costs.mjs';
import { syncOrderCosts, readOrderCosts } from '../src/domain/order-cost-ledger.mjs';
import { Repository } from '../src/domain/repository.mjs';

const now=Date.parse('2026-10-05T12:00:00Z');
const snapshot=extra=>({version:1,companyId:'company-a',companyName:'Empresa A',exportedAt:new Date(now).toISOString(),storeIds:['store-a','store-b'],
  products:[{id:'p',sku:'SKU',name:'Produto',averageCost:'3.3333333333'}],links:[{storeId:'store-a',sellerSku:'AMZ',productId:'p'}],costHistory:[],...extra});
const stock=(storeId='store-a',sku='AMZ')=>({storeId,sellerSku:sku,totalQuantity:99,inventoryDetails:{fulfillableQuantity:3,inboundWorkingQuantity:2,inboundShippedQuantity:1,inboundReceivingQuantity:0,
  reservedQuantity:{pendingTransshipmentQuantity:1,fcProcessingQuantity:2,pendingCustomerOrderQuantity:80}}});
const order=(extra={})=>({storeId:'store-a',orderId:'order',status:'SHIPPED',items:[{sku:'AMZ',quantityOrdered:3}],
  financial:{saleRevenue:{netByCurrency:[{currency:'BRL',netCents:'1500'}],netOrderCount:1,missingNetOrderCount:0,unclassifiedFeeCount:0}},...extra});

test('stock costs use eligible Amazon units, unrounded averages, explicit links and strict store scope',()=>{
  const catalogue=costCatalogue(snapshot(),now), known=inventoryCost(stock(),catalogue);
  assert.equal(known.quantity,9);assert.equal(known.unitCostCents,'333');assert.equal(known.totalCents,'3000');
  assert.equal(inventoryCost(stock('store-b',' sku '),catalogue).totalCents,'3000');
  assert.equal(inventoryCost(stock('store-c','SKU'),catalogue).totalCents,null);
  assert.equal(inventoryCost(stock('store-b','AMZ'),catalogue).totalCents,null);
  const rows=[{cost:known},{cost:inventoryCost(stock('store-c','SKU'),catalogue)}];
  assert.equal(inventoryCostSummary(rows,catalogue).totalCents,null);assert.equal(inventoryCostSummary(rows,catalogue).knownTotalCents,'3000');
  assert.equal(inventoryCostSummary([{cost:known}],catalogue,false).totalCents,null);
});

test('order displays use only frozen unit costs; pending inputs and currencies never invent a result',()=>{
  const catalogue=costCatalogue(snapshot(),now);
  const saved=[{item_key:'sku:AMZ',sku:'AMZ',unit_cost:'3.3333333333',basis:'initial',product_name:'Produto'}];
  const cost=orderCost(order(),catalogue,saved);
  assert.equal(cost.totalCents,'1000');assert.equal(cost.fixed,true);assert.equal(cost.resultCents,'500');
  assert.equal(orderCost(order(),catalogue).totalCents,null);
  assert.equal(orderCost(order(),null,saved).totalCents,'1000');
  assert.equal(orderCost(order({items:[{sku:'AMZ',quantityOrdered:1},{sku:'missing',quantityOrdered:1}]}),catalogue,saved).totalCents,null);
  assert.equal(orderCost(order({status:'PENDING'}),catalogue,saved).resultCents,null);
  assert.equal(orderCost(order({status:'CANCELLED'}),catalogue,saved).resultCents,null);
  assert.equal(orderCost(order({financial:{saleRevenue:{...order().financial.saleRevenue,netByCurrency:[{currency:'USD',netCents:'1500'}]}}}),catalogue,saved).resultCents,null);
  assert.equal(orderCost(order({items:[{sku:'AMZ',quantityOrdered:null}]}),catalogue,saved).totalCents,null);
  const tiny=orderCost(order({items:Array.from({length:3},()=>({sku:'AMZ',quantityOrdered:1}))}),catalogue,[{...saved[0],unit_cost:'0.0033333333'}]);
  assert.equal(tiny.totalCents,'1');assert.equal(tiny.items.reduce((n,i)=>n+BigInt(i.totalCents),0n),1n);
});

test('ambiguous SKUs, deleted explicit links and invalid snapshot costs fail closed',()=>{
  const products=[{id:'p',sku:'SKU',name:'A',averageCost:'1'},{id:'q',sku:'sku',name:'B',averageCost:'2'}];
  assert.equal(inventoryCost(stock('store-b','SKU'),costCatalogue(snapshot({products}),now)).totalCents,null);
  assert.equal(inventoryCost(stock(),costCatalogue(snapshot({links:[{storeId:'store-a',sellerSku:'AMZ',productId:'gone'}]}),now)).totalCents,null);
  for(const averageCost of ['-1','NaN',0,'1e5']) assert.throws(()=>costCatalogue(snapshot({products:[{...products[0],averageCost}]}),now));
  assert.throws(()=>costCatalogue(snapshot({links:[{storeId:'other',sellerSku:'SKU',productId:'p'}]}),now));
});

test('snapshot replacement refreshes costs independently of the order and inventory database caches',t=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'costs-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const reader=new ProductCostReader(root);assert.equal(reader.read(now),null);
  writeFileSync(path.join(root,'erp-costs.json'),JSON.stringify(snapshot()));
  assert.equal(reader.read(now).metadata.stale,false);assert.equal(reader.read(now+16*60_000).metadata.stale,true);
  writeFileSync(path.join(root,'next.json'),JSON.stringify(snapshot({products:[{id:'p',sku:'SKU',name:'Produto',averageCost:'8'}]})));
  renameSync(path.join(root,'next.json'),path.join(root,'erp-costs.json'));
  assert.equal(inventoryCost(stock(),reader.read(now)).totalCents,'7200');
  writeFileSync(path.join(root,'erp-costs.json'),'{broken');assert.equal(reader.read(now),null);
});

test('repository returns costs in inventory, orders and details without updating source records',t=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'cost-repo-'));const repo=new Repository({rootDir:root,dbPath:':memory:',stores:[{storeId:'store-a',name:'A'}]});
  t.after(()=>{repo.close();rmSync(root,{recursive:true,force:true});});
  writeFileSync(path.join(root,'erp-costs.json'),JSON.stringify(snapshot({exportedAt:new Date().toISOString()})));
  const insert=(type,id,data)=>repo.db.prepare('INSERT INTO entities VALUES(?,?,?,?,?,?,?,?,?)').run('store-a',type,id,'2026-10-05','2026-10-05','hash',data.status||null,1,JSON.stringify(data));
  insert('orders','order',{...order(),createdAt:'2026-10-01T12:00:00Z',packages:[]});insert('fba-inventory','AMZ',stock());
  insert('transactions','tx',{storeId:'store-a',transactionId:'tx',orderIds:['order'],type:'Shipment',status:'RELEASED',totalCents:'1500',currency:'BRL',countsAsSales:true});
  const before=JSON.stringify(repo.db.prepare('SELECT * FROM entities').all());
  syncOrderCosts(repo.db,repo.productCosts.read());
  assert.equal(repo.inventory({storeId:'store-a'}).items[0].cost.totalCents,'3000');
  assert.equal(repo.orders({storeId:'store-a'}).items[0].cost.resultCents,'500');
  assert.equal(repo.orderDetail('store-a','order').cost.totalCents,'1000');
  writeFileSync(path.join(root,'next.json'),JSON.stringify(snapshot({exportedAt:new Date().toISOString(),products:[{id:'p',sku:'SKU',name:'Produto',averageCost:'4'}]})));
  renameSync(path.join(root,'next.json'),path.join(root,'erp-costs.json'));
  syncOrderCosts(repo.db,repo.productCosts.read());
  assert.equal(repo.orders({storeId:'store-a'}).items[0].cost.resultCents,'500');
  assert.equal(repo.inventory({storeId:'store-a'}).items[0].cost.totalCents,'3600');
  assert.equal(JSON.stringify(repo.db.prepare('SELECT * FROM entities').all()),before);
});


test('initial orders freeze current cost; future and delayed imports use the price at sale time, without rewriting old orders',t=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'cost-timeline-'));const repo=new Repository({rootDir:root,dbPath:':memory:',stores:[{storeId:'store-a',name:'A'}]});
  t.after(()=>{repo.close();rmSync(root,{recursive:true,force:true});});
  const insert=(id,createdAt,sku='AMZ')=>repo.db.prepare('INSERT INTO entities VALUES(?,?,?,?,?,?,?,?,?)').run('store-a','orders',id,createdAt,createdAt,id,'SHIPPED',1,JSON.stringify({storeId:'store-a',orderId:id,createdAt,status:'SHIPPED',items:[{orderItemId:'item',sku,quantityOrdered:1}]}));
  insert('old','2026-01-01T12:00:00Z');
  const initial=costCatalogue(snapshot({products:[{id:'p',sku:'SKU',name:'Produto',averageCost:'100'}]}),now);
  assert.equal(syncOrderCosts(repo.db,initial).captured,1);
  const before=readOrderCosts(repo.db,'store-a','old');assert.equal(before[0].unit_cost,'100');assert.equal(before[0].basis,'initial');
  insert('late-before-change','2026-10-06T09:30:00Z');insert('after-change','2026-10-06T11:30:00Z');insert('after-second-change','2026-10-06T12:30:00Z');
  const exportedAt='2026-10-06T13:00:00Z';
  const next=costCatalogue(snapshot({exportedAt,products:[{id:'p',sku:'SKU',name:'Produto',averageCost:'130'}],costHistory:[
    {productId:'p',version:1,unitCost:'100',effectiveAt:'2026-10-05T11:59:00Z'},
    {productId:'p',version:2,unitCost:'120',effectiveAt:'2026-10-06T10:00:00Z'},
    {productId:'p',version:3,unitCost:'130',effectiveAt:'2026-10-06T12:00:00Z'}]}),Date.parse(exportedAt));
  assert.equal(syncOrderCosts(repo.db,next).captured,3);
  assert.equal(readOrderCosts(repo.db,'store-a','late-before-change')[0].unit_cost,'100');
  assert.equal(readOrderCosts(repo.db,'store-a','after-change')[0].unit_cost,'120');
  assert.equal(readOrderCosts(repo.db,'store-a','after-second-change')[0].unit_cost,'130');
  assert.deepEqual(readOrderCosts(repo.db,'store-a','old'),before);
  assert.equal(syncOrderCosts(repo.db,next).captured,0);
  insert('too-new','2026-10-06T14:00:00Z');assert.equal(syncOrderCosts(repo.db,next).captured,0);
  assert.equal(readOrderCosts(repo.db,'store-a','too-new').length,0);
});

test('new product links capture a fresh baseline only for pending costs, and large backfills are resumable',t=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'cost-batch-'));const repo=new Repository({rootDir:root,dbPath:':memory:',stores:[{storeId:'store-a',name:'A'}]});
  t.after(()=>{repo.close();rmSync(root,{recursive:true,force:true});});
  const insert=repo.db.prepare('INSERT INTO entities VALUES(?,?,?,?,?,?,?,?,?)');
  for(let i=0;i<650;i++)insert.run('store-a','orders',String(i).padStart(4,'0'),'2026-01-01','2026-01-01','v1','SHIPPED',1,JSON.stringify({createdAt:'2026-01-01T12:00:00Z',status:'SHIPPED',items:[{orderItemId:'one',sku:'later',quantityOrdered:1}]}));
  const before=costCatalogue(snapshot(),now);assert.equal(syncOrderCosts(repo.db,before).captured,0);
  const after=costCatalogue(snapshot({links:[{storeId:'store-a',sellerSku:'later',productId:'p'}]}),now);
  assert.equal(syncOrderCosts(repo.db,after).captured,650);assert.equal(syncOrderCosts(repo.db,after).captured,0);
  assert.equal(repo.db.prepare('SELECT count(*) n FROM order_product_costs').get().n,650);
  assert.equal(syncOrderCosts(repo.db,{...after,metadata:{...after.metadata,stale:true}}).skipped,'cost-source-unavailable');
});
