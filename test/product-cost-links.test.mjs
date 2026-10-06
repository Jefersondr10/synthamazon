import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Repository } from '../src/domain/repository.mjs';
import { readOrderCosts, syncOrderCosts } from '../src/domain/order-cost-ledger.mjs';
import { costCatalogue, ProductCostReader } from '../src/domain/product-costs.mjs';
import { createRepositoryWorkers } from '../src/web/repository-worker.mjs';
import { scopeRepository } from '../src/web/store-scope.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cost-links-'));
  const stores = ['a','b','c'].map(storeId => ({storeId,name:storeId}));
  const options = {rootDir:root,dbPath:path.join(root,'synthamazon.sqlite'),stores};
  const repo = new Repository(options), now = Date.now();
  t.after(() => {repo.close();assert.equal(path.dirname(root),path.resolve(os.tmpdir()));rmSync(root,{recursive:true,force:true});});
  const snapshot = { version:1, companyId:'company',companyName:'Estoque teste',exportedAt:new Date(now).toISOString(),storeIds:['a','b'],
    products:[{id:'one',name:'Produto um',sku:'ERP-ONE',averageCost:'10'},{id:'two',name:'Produto dois',sku:'ERP-TWO',averageCost:'20'},{id:'missing',name:'Sem custo',sku:'ERP-MISSING',averageCost:null}],
    links:[{storeId:'a',sellerSku:'FBA',productId:'two'}],costHistory:[] };
  const exportCosts = extra => {Object.assign(snapshot,extra);writeFileSync(path.join(root,'cost-next.json'),JSON.stringify(snapshot));renameSync(path.join(root,'cost-next.json'),path.join(root,'erp-costs.json'));};
  exportCosts({});
  const insert = (id, sku='DBA',storeId='a',mode='DBA',createdAt=new Date(now-86_400_000).toISOString()) => repo.db.prepare('INSERT INTO entities VALUES(?,?,?,?,?,?,?,?,?)').run(storeId,'orders',id,createdAt,createdAt,id,'SHIPPED',1,JSON.stringify({storeId,orderId:id,createdAt,status:'SHIPPED',fulfillmentMode:mode,packages:[],items:[{orderItemId:id+'-item',sku,title:'Produto Amazon',quantityOrdered:2}]}));
  insert('order');insert('same-sku','DBA','a','MFN');insert('other-store','DBA','b');insert('fba','FBA','a','FBA');insert('unconfirmed','DBA','c');
  const identity={storeId:'a',orderId:'order',sku:'DBA'};
  return {repo,root,options,now,snapshot,insert,exportCosts,identity,save:(extra={})=>repo.saveProductCostLink({...identity,companyId:'company',productId:'one',expectedVersion:0,...extra})};
}

test('DBA and self-shipped SKUs link once per store, preserve FBA links and leave the source untouched', t => {
  const {repo,root,identity,save}=fixture(t);
  const source=JSON.stringify(repo.db.prepare('SELECT * FROM entities').all());
  const options=repo.productCostLink(identity);
  assert.equal(options.editable,true);assert.equal(options.source,'none');assert.equal(options.products.length,3);
  assert.equal(repo.orderDetail('a','order').cost.items[0].linkAvailable,true);
  assert.equal(repo.orderDetail('c','unconfirmed').cost.items[0].linkAvailable,false);
  const result=save();assert.equal(result.captured,2);assert.equal(result.syncPending,false);
  assert.equal(repo.orderDetail('a','order').cost.totalCents,'2000');assert.equal(repo.orderDetail('a','same-sku').cost.totalCents,'2000');
  assert.equal(repo.orderDetail('b','other-store').cost.totalCents,null);
  // Scheduled sync opens its own reader, and must retain mappings after restart.
  const reader=new ProductCostReader(root,repo.db);assert.equal(reader.read().resolve('a','DBA').id,'one');
  syncOrderCosts(repo.db,reader.read());
  assert.equal(repo.orderDetail('a','fba').cost.totalCents,'4000');
  assert.equal(repo.productCostLink({...identity,orderId:'fba',sku:'FBA'}).source,'erp');
  assert.throws(()=>save({orderId:'fba',sku:'FBA'}),{code:'COST_LINK_EXTERNAL'});
  assert.equal(repo.productCostLink(identity).version,1);
  assert.equal(JSON.stringify(repo.db.prepare('SELECT * FROM entities').all()),source);
  assert.equal(save({expectedVersion:1}).unchanged,true);
});

test('new links freeze old orders at initial cost; later and delayed sales use cost history without repricing', t=>{
  const {repo,root,identity,save,insert,snapshot,now}=fixture(t);
  save();const before=readOrderCosts(repo.db,'a','order');
  const later = now + 86_400_000, changed = later + 3_600_000;
  const local = new ProductCostReader(root,repo.db).read().snapshot.localLinks;
  const next = costCatalogue({...snapshot,exportedAt:new Date(changed+3_600_000).toISOString(),products:snapshot.products.map(p=>p.id==='one'?{...p,averageCost:'15'}:p),
    costHistory:[{productId:'one',version:1,unitCost:'15',effectiveAt:new Date(changed).toISOString()}]},changed+3_600_000,local);
  insert('delayed','DBA','a','MFN',new Date(later).toISOString());insert('new','DBA','a','DBA',new Date(changed+60_000).toISOString());
  syncOrderCosts(repo.db,next);
  assert.equal(readOrderCosts(repo.db,'a','delayed')[0].unit_cost,'10');assert.equal(readOrderCosts(repo.db,'a','new')[0].unit_cost,'15');
  assert.deepEqual(readOrderCosts(repo.db,'a','order'),before);
  save({productId:'two',expectedVersion:1});
  assert.deepEqual(readOrderCosts(repo.db,'a','order'),before);
  assert.equal(repo.productCostLink(identity).productId,'two');
});

test('conflicts, invalid products, unknown SKUs, source changes and unconfirmed stores cannot create mappings',t=>{
  const {repo,identity,save,exportCosts}=fixture(t);
  for(const extra of [{productId:'not-found'},{expectedVersion:-1},{sku:'missing'},{storeId:'all'},{orderId:'missing'},{unexpected:true}]) assert.throws(()=>save(extra));
  assert.throws(()=>save({storeId:'c',orderId:'unconfirmed'}),{code:'COST_STORE_UNLINKED'});
  assert.throws(()=>save({companyId:'another'}),{code:'COST_LINK_CONFLICT'});
  save();assert.throws(()=>save({productId:'two'}),{code:'COST_LINK_CONFLICT'});
  const scoped=scopeRepository(repo,'b');
  assert.throws(()=>scoped.productCostLink(identity),{code:'FORBIDDEN'});
  assert.throws(()=>scoped.saveProductCostLink({...identity,expectedVersion:1,companyId:'company',productId:'two'}),{code:'FORBIDDEN'});
  assert.throws(()=>scoped.productCostLink({...identity,storeId:'a,b'}),{code:'FORBIDDEN'});
  exportCosts({exportedAt:new Date(Date.now()-20*60_000).toISOString()});
  assert.equal(repo.productCostLink(identity).editable,false);
  assert.throws(()=>save({productId:'two',expectedVersion:1}),{code:'COST_SOURCE_UNAVAILABLE'});
  assert.equal(repo.db.prepare('SELECT count(*) n FROM product_cost_links').get().n,1);
});

test('missing source costs stay pending; later ERP links supersede local links without changing saved costs',t=>{
  const {repo,identity,save,insert,exportCosts}=fixture(t);
  save({productId:'missing'});assert.equal(repo.orderDetail('a','order').cost.totalCents,null);
  save({productId:'one',expectedVersion:1});const before=readOrderCosts(repo.db,'a','order');
  insert('next');
  exportCosts({links:[{storeId:'a',sellerSku:'DBA',productId:'two'}]});
  syncOrderCosts(repo.db,repo.productCosts.read());
  assert.equal(repo.productCostLink(identity).editable,false);
  assert.equal(readOrderCosts(repo.db,'a','next')[0].product_id,'two');
  assert.deepEqual(readOrderCosts(repo.db,'a','order'),before);
});

test('worker read and write lanes see the same persisted product link and resulting costs', async t=>{
  const {repo,options,identity}=fixture(t);
  const workers=await createRepositoryWorkers(options);
  try {
    assert.equal((await workers.productCostLink(identity)).source,'none');
    assert.equal((await workers.productSkuList({storeId:'a'})).counts.unlinked,1);
    assert.equal((await workers.saveProductCostLink({...identity,companyId:'company',productId:'one',expectedVersion:0})).captured,2);
    assert.equal((await workers.productCostLink(identity)).productId,'one');
    assert.equal((await workers.productSkuList({storeId:'a'})).counts.unlinked,0);
    assert.equal((await workers.orderDetail('a','order')).cost.totalCents,'2000');
    assert.equal(repo.productCosts.read().resolve('a','DBA').id,'one');
  } finally {await workers.close();}
});


test('SKU catalogue groups repeated orders and channels by store, includes inventory without sales, and separates linking from missing costs',t=>{
  const {repo,insert,save}=fixture(t);
  insert('another-dba');insert('no-cost','ERP-MISSING');
  const inventory={storeId:'a',sellerSku:'ONLY-STOCK',title:'Produto sem vendas',asin:'B012345678'};
  repo.db.prepare('INSERT INTO entities VALUES(?,?,?,?,?,?,?,?,?)').run('a','fba-inventory','stock-only','2026-10-05','2026-10-05','stock',null,1,JSON.stringify(inventory));
  const list=repo.productSkuList({storeId:'a',limit:100});
  assert.equal(list.total,4);assert.deepEqual(list.counts,{all:4,unlinked:2,linked:2,'missing-cost':1,unavailable:0});
  const dba=list.items.find(row=>row.sku==='DBA');assert.equal(dba.orderCount,3);assert.deepEqual(new Set(dba.channels),new Set(['DBA','MFN']));
  const stock=list.items.find(row=>row.sku==='ONLY-STOCK');assert.equal(stock.orderCount,0);assert.equal(stock.inInventory,true);
  assert.equal(repo.productSkuList({storeId:'a',mode:'MFN'}).total,1);
  assert.equal(repo.productSkuList({storeId:'a',linkStatus:'missing-cost'}).items[0].sku,'ERP-MISSING');
  assert.equal(repo.productSkuList({storeId:'a',query:'b012345678'}).items[0].sku,'ONLY-STOCK');
  assert.equal(repo.productSkuList({storeId:'a',query:'PRODUTO DOIS'}).items[0].sku,'FBA');
  save();
  const linked=repo.productSkuList({storeId:'a',linkStatus:'unlinked'});assert.equal(linked.total,1);assert.equal(linked.counts.linked,3);assert.equal(linked.items[0].sku,'ONLY-STOCK');
  assert.equal(repo.productSkuList({storeId:'all',query:'DBA'}).total,3,'Identical SKUs in different stores remain separate');
  assert.equal(repo.productSkuList({storeId:'a,b'}).counts.unavailable,0);
  assert.equal(repo.productSkuList({storeId:'c'}).counts.unavailable,1);
  assert.equal(repo.productSkuList({storeId:'a',limit:1,offset:999}).offset,3);
});

test('SKU list links without an order ID and inventory-only products still validate against imported evidence',t=>{
  const {repo,save,identity}=fixture(t);
  const {orderId,...skuIdentity}=identity;
  assert.equal(repo.productCostLink(skuIdentity).editable,true);
  assert.equal(repo.saveProductCostLink({...skuIdentity,companyId:'company',productId:'one',expectedVersion:0}).captured,2);
  const stock={storeId:'a',sellerSku:'STOCK',title:'Estoque sem pedido'};
  repo.db.prepare('INSERT INTO entities VALUES(?,?,?,?,?,?,?,?,?)').run('a','fba-inventory','stock','2026-10-05','2026-10-05','stock',null,1,JSON.stringify(stock));
  assert.equal(repo.productCostLink({storeId:'a',sku:'STOCK'}).title,'Estoque sem pedido');
  assert.equal(repo.saveProductCostLink({storeId:'a',sku:'STOCK',companyId:'company',productId:'two',expectedVersion:0}).saved,true);
  assert.equal(repo.productSkuList({storeId:'a',query:'STOCK'}).items[0].productId,'two');
  assert.throws(()=>repo.saveProductCostLink({storeId:'a',sku:'not-imported',companyId:'company',productId:'one',expectedVersion:0}),{code:'CASE_NOT_FOUND'});
  assert.throws(()=>save({orderId:''}));
});

test('SKU filters and pagination remain scoped, with fresh costs and links after cached reads',t=>{
  const {repo,exportCosts,snapshot,insert}=fixture(t);
  const scoped=scopeRepository(repo,'a');
  assert.ok(scoped.productSkuList({storeId:'all'}).items.every(row=>row.storeId==='a'));
  for(const storeId of ['b','a,b'])assert.throws(()=>scoped.productSkuList({storeId}),{code:'FORBIDDEN'});
  for(const filter of [{mode:'UNKNOWN'},{linkStatus:'bad'},{query:'a'.repeat(201)},{limit:101},{limit:0},{offset:-1},{unexpected:true}])assert.throws(()=>repo.productSkuList(filter));
  assert.equal(repo.productSkuList({storeId:'a',query:'FBA'}).items[0].unitCostCents,'2000');
  exportCosts({products:snapshot.products.map(p=>p.id==='two'?{...p,averageCost:'30'}:p)});
  assert.equal(repo.productSkuList({storeId:'a',query:'FBA'}).items[0].unitCostCents,'3000');
  insert('fresh','NEW-SKU');assert.ok(repo.productSkuList({storeId:'a'}).items.some(row=>row.sku==='NEW-SKU'));
  exportCosts({links:[{storeId:'a',sellerSku:'FBA',productId:'deleted'}]});
  const missing=repo.productSkuList({storeId:'a',query:'FBA'}).items[0];assert.equal(missing.status,'unlinked');assert.equal(missing.brokenLink,true);assert.equal(missing.editable,false);
});


test('SKU streaming handles large order payloads and repeated SKU lines without duplicating orders',t=>{
  const {repo}=fixture(t);
  const padding='x'.repeat(64*1024),insert=repo.db.prepare('INSERT INTO entities VALUES(?,?,?,?,?,?,?,?,?)');
  repo.db.exec('BEGIN');
  for(let i=0;i<600;i++) {
    const day=i===599?'2026-10-05':'2026-09-01',id='large-'+String(i).padStart(4,'0');
    const item={sku:'LARGE',title:i===599?'Descrição atual':'Descrição anterior',quantityOrdered:1};
    insert.run('a','orders',id,day,day,id,'SHIPPED',1,JSON.stringify({createdAt:day,fulfillmentMode:i%2?'DBA':'MFN',items:[item,item],details:padding}));
  }
  repo.db.exec('COMMIT');
  const result=repo.productSkuList({storeId:'a',query:'LARGE'});
  assert.equal(result.total,1);assert.equal(result.items[0].orderCount,600);assert.equal(result.items[0].title,'Descrição atual');
  assert.deepEqual(new Set(result.items[0].channels),new Set(['DBA','MFN']));
  assert.ok(!Object.hasOwn(result.items[0],'lastSeenOrder'));
});


const asinIdentity={storeId:'all',asin:'B012345678'};
function setAsin(repo,asin='B012345678',id=null) {
  repo.db.prepare("UPDATE entities SET payload_json=json_set(payload_json,'$.items[0].asin',?) WHERE source='orders' AND (? IS NULL OR source_id=?)").run(asin,id,id);
}
function saveGroup(repo,extra={}) {
  const editor=repo.productCostGroup(asinIdentity);
  return repo.saveProductCostGroup({...asinIdentity,companyId:editor.companyId,expectedRevision:editor.expectedRevision,productId:'one',...extra});
}

test('ASIN grouping joins stores and channels before search and pagination, without merging absent or invalid ASINs',t=>{
  const {repo,insert}=fixture(t);setAsin(repo);setAsin(repo,'b012345678','other-store');
  insert('separate-1','NO-ASIN');insert('separate-2','NO-ASIN','b');
  insert('invalid-1','INVALID-A');insert('invalid-2','INVALID-B');setAsin(repo,'N/A','invalid-1');setAsin(repo,'N/A','invalid-2');
  const list=repo.productSkuList({groupBy:'asin',limit:100});
  assert.equal(list.total,5);const group=list.items.find(row=>row.asin===asinIdentity.asin);
  assert.equal(group.skuCount,4);assert.equal(group.stores.length,3);assert.equal(group.status,'partial');
  assert.equal(group.linkedCount,1);assert.equal(group.unavailableCount,1);
  assert.equal(list.counts.unavailable,1);assert.equal(repo.productSkuList({groupBy:'asin',linkStatus:'unavailable'}).total,1);
  assert.equal(list.items.filter(row=>!row.asin).length,4);
  const search=repo.productSkuList({groupBy:'asin',query:'FBA',mode:'MFN'});
  assert.equal(search.total,1);assert.equal(search.items[0].skuCount,4,'A matching alias/channel keeps the full selected-store group');
  const subset=repo.productSkuList({groupBy:'asin',storeId:'b,a',query:asinIdentity.asin});
  assert.equal(subset.items[0].skuCount,3);assert.equal(subset.items[0].unavailableCount,0);
  assert.equal(repo.productSkuList({groupBy:'asin',limit:1,offset:1}).items.length,1);
  assert.equal(repo.productSkuList({groupBy:'asin',linkStatus:'partial'}).total,1);
  assert.throws(()=>repo.productSkuList({groupBy:'title'}));
  assert.equal(repo.db.prepare('SELECT count(*) n FROM product_cost_links').get().n,0,'Grouping is read-only');
});

test('ASIN group links eligible SKUs atomically, preserves ERP links, unconfirmed stores and frozen sale costs',t=>{
  const {repo}=fixture(t);setAsin(repo);
  const source=JSON.stringify(repo.db.prepare('SELECT * FROM entities').all());
  let editor=repo.productCostGroup(asinIdentity);
  assert.equal(editor.editableCount,2);assert.equal(editor.productId,'two');
  let result=saveGroup(repo);assert.equal(result.updated,2);assert.equal(result.captured,3);
  assert.equal(repo.productCostLink({storeId:'a',sku:'FBA'}).productId,'two');
  assert.equal(repo.db.prepare("SELECT count(*) n FROM product_cost_links WHERE store_id='c'").get().n,0);
  assert.equal(repo.orderDetail('a','order').cost.totalCents,'2000');assert.equal(repo.orderDetail('b','other-store').cost.totalCents,'2000');
  editor=repo.productCostGroup(asinIdentity);assert.equal(editor.status,'conflict');assert.equal(editor.productId,null);
  const frozen=repo.db.prepare('SELECT * FROM order_product_costs').all();
  result=saveGroup(repo,{productId:'two'});assert.equal(result.updated,2);
  assert.deepEqual(repo.db.prepare('SELECT * FROM order_product_costs').all(),frozen);
  assert.equal(repo.productCostGroup({storeId:'a,b',asin:asinIdentity.asin}).status,'linked');
  assert.equal(repo.productSkuList({groupBy:'asin',linkStatus:'linked',storeId:'a,b'}).total,1);
  assert.equal(repo.productCostGroup(asinIdentity).status,'partial','Unconfigured store remains visible');
  assert.equal(saveGroup(repo,{productId:'two'}).unchanged,true);
  assert.equal(JSON.stringify(repo.db.prepare('SELECT * FROM entities').all()),source);
});

test('ASIN writes reject stale group membership, concurrent edits and unexpected input before saving any member',t=>{
  const {repo,insert,save,exportCosts}=fixture(t);setAsin(repo);
  const editor=repo.productCostGroup(asinIdentity);
  const input={...asinIdentity,companyId:'company',productId:'one',expectedRevision:editor.expectedRevision};
  save();assert.throws(()=>repo.saveProductCostGroup(input),{code:'COST_LINK_CONFLICT'});
  input.expectedRevision=repo.productCostGroup(asinIdentity).expectedRevision;
  insert('late','NEW-SKU');setAsin(repo,asinIdentity.asin,'late');
  assert.throws(()=>repo.saveProductCostGroup(input),{code:'COST_LINK_CONFLICT'});
  input.expectedRevision=repo.productCostGroup(asinIdentity).expectedRevision;
  for(const extra of [{sku:'bypass'},{storeId:'a,a'},{asin:'unknown'},{expectedRevision:'no'},{productId:'missing-product'}])assert.throws(()=>repo.saveProductCostGroup({...input,...extra}));
  assert.throws(()=>repo.saveProductCostGroup({...input,companyId:'changed'}),{code:'COST_LINK_CONFLICT'});
  assert.throws(()=>repo.productCostGroup({storeId:'a',asin:'B099999999'}),{code:'CASE_NOT_FOUND'});
  exportCosts({exportedAt:new Date(Date.now()-20*60_000).toISOString()});
  assert.throws(()=>repo.saveProductCostGroup(input),{code:'COST_SOURCE_UNAVAILABLE'});
  assert.equal(repo.db.prepare('SELECT count(*) n FROM product_cost_links').get().n,1);
});

test('ASIN group rollback leaves no partial links if a database write fails midway',t=>{
  const {repo}=fixture(t);setAsin(repo);
  repo.db.exec("CREATE TRIGGER block_second_link BEFORE INSERT ON product_cost_links WHEN NEW.store_id='b' BEGIN SELECT RAISE(ABORT,'test failure'); END");
  assert.throws(()=>saveGroup(repo),/test failure/);
  assert.equal(repo.db.prepare('SELECT count(*) n FROM product_cost_links').get().n,0);
  assert.equal(repo.db.prepare('SELECT count(*) n FROM order_product_costs').get().n,0);
  repo.db.exec('DROP TRIGGER block_second_link');
  assert.equal(saveGroup(repo).updated,2);
});

test('ASIN groups honor scoped sessions and preserve missing cost information',t=>{
  const {repo}=fixture(t);setAsin(repo);
  const scoped=scopeRepository(repo,'b'),editor=scoped.productCostGroup(asinIdentity);
  assert.equal(editor.storeId,'b');assert.equal(editor.skuCount,1);
  for(const storeId of ['a','a,b'])assert.throws(()=>scoped.productCostGroup({...asinIdentity,storeId}),{code:'FORBIDDEN'});
  const input={...asinIdentity,storeId:'b',companyId:'company',productId:'missing',expectedRevision:editor.expectedRevision};
  for(const storeId of ['all','a','a,b'])assert.throws(()=>scoped.saveProductCostGroup({...input,storeId}),{code:'FORBIDDEN'});
  assert.equal(scoped.saveProductCostGroup(input).updated,1);
  const list=scoped.productSkuList({groupBy:'asin',linkStatus:'missing-cost'});
  assert.equal(list.total,1);assert.equal(list.items[0].missingCostCount,1);
  assert.equal(repo.orderDetail('b','other-store').cost.totalCents,null);
});

test('worker lanes support ASIN grouped reads and writes with membership conflict checks',async t=>{
  const {repo,options}=fixture(t);setAsin(repo);
  const workers=await createRepositoryWorkers(options);
  try {
    const editor=await workers.productCostGroup(asinIdentity);
    const result=await workers.saveProductCostGroup({...asinIdentity,companyId:editor.companyId,productId:'two',expectedRevision:editor.expectedRevision});
    assert.equal(result.updated,2);
    const list=await workers.productSkuList({storeId:'a,b',groupBy:'asin'});
    assert.equal(list.total,1);assert.equal(list.items[0].status,'linked');
  } finally {await workers.close();}
});
