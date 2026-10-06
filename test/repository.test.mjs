import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Repository } from '../src/domain/repository.mjs';
import { SnapshotStore } from '../src/storage.mjs';
import { recordTrackingObservation } from '../src/domain/returns.mjs';
import { saveCustomerReturnJob, importCustomerReturnReport } from '../src/domain/customer-returns.mjs';
import { inventoryForecast } from '../src/domain/inventory-forecast.mjs';

const at = day => `2026-09-${String(day).padStart(2, '0')}T12:00:00.000Z`;
const order = (id = 'order-a', amount = '100.00', extra = {}) => ({
  orderId: id, createdTime: at(1), lastUpdatedTime: at(2),
  programs: ['DELIVERY_BY_AMAZON'], proceeds: { grandTotal: { amount, currencyCode: 'BRL' } },
  orderItems: [{ orderItemId: 'item-a', quantityOrdered: 1, product: { sellerSku: 'SKU-A', title: 'Produto teste', asin: 'ASIN-A', price: { unitPrice: { amount, currencyCode: 'BRL' } } }, proceeds: { proceedsTotal: { amount, currencyCode: 'BRL' } } }], ...extra,
});
const tx = (id = 'tx-a', amount = '80.00', extra = {}) => ({
  transactionId: id, transactionType: 'Shipment', transactionStatus: 'RELEASED', postedDate: at(3),
  totalAmount: { currencyAmount: amount, currencyCode: 'BRL' }, relatedIdentifiers: [{ relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: 'order-a' }], ...extra,
});
const fba = (sku, amount) => ({
  sellerSku: sku, asin: `asin-${sku}`, fnSku: `fn-${sku}`, condition: 'NewItem', productName: `Produto ${sku}`, totalQuantity: amount,
  inventoryDetails: { fulfillableQuantity: amount, inboundWorkingQuantity: 0, inboundShippedQuantity: 0, inboundReceivingQuantity: 0,
    reservedQuantity: { totalReservedQuantity: 0, pendingCustomerOrderQuantity: 0, pendingTransshipmentQuantity: 0, fcProcessingQuantity: 0 },
    researchingQuantity: { totalResearchingQuantity: 0 }, unfulfillableQuantity: { totalUnfulfillableQuantity: 0 },
  },
});
const body = (source, rows) => JSON.stringify(source === 'orders' ? { orders: rows } : { payload: { [source === 'transactions' ? 'transactions' : 'inventorySummaries']: rows } });

async function fixture(t) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'synth-repository-'));
  const repo = new Repository({ rootDir, dbPath: path.join(rootDir, 'test.sqlite'), stores: [{ storeId: 'store-a', name: 'Loja A' }, { storeId: 'store-b', name: 'Loja B' }] });
  t.after(async () => { repo.close(); await rm(rootDir, { recursive: true, force: true }); });
  async function run(storeId, sources, observedAt = at(10), status = 'api-pages-complete') {
    const store = new SnapshotStore({ rootDir, storeId });
    const manifest = { id: randomUUID(), storeId, startedAt: observedAt, finishedAt: observedAt, status: 'collected-awaiting-validation', sources: [] };
    for (const [source, rows] of Object.entries(sources)) {
      const rawBody = typeof rows === 'string' ? rows : body(source, rows);
      const saved = await store.savePage({ source, body: rawBody });
      manifest.sources.push({ source, startedAt: observedAt, finishedAt: observedAt, status,
        dateBasis: source === 'orders' ? 'created' : source === 'transactions' ? 'posted' : 'current-snapshot',
        requestedWindow: source === 'fba-inventory' ? null : { from: at(1), to: at(10) },
        pages: [{ ...saved, observedAt, page: 1, hasNextPage: status !== 'api-pages-complete' }],
      });
    }
    await store.saveRun(manifest);
    return manifest;
  }
  return { repo, rootDir, run };
}

test('product sales reads normalized merchant orders without financial projection or cross-store mixing', async t => {
  const {repo,run}=await fixture(t);
  await repo.importRun(await run('store-a',{orders:[order('dba','100.00',{fulfillment:{fulfillmentStatus:'SHIPPED',fulfilledBy:'MERCHANT'}}),
    order('own','100.00',{programs:[],fulfillment:{fulfillmentStatus:'SHIPPED',fulfilledBy:'MERCHANT'}}),
    order('amazon','100.00',{programs:[],fulfillment:{fulfillmentStatus:'SHIPPED',fulfilledBy:'AMAZON'}})]}));
  await repo.importRun(await run('store-b',{orders:[order('dba','200.00',{fulfillment:{fulfillmentStatus:'SHIPPED',fulfilledBy:'MERCHANT'}})]}));
  const before=JSON.stringify(repo.db.prepare('SELECT * FROM entities ORDER BY store_id,source_id').all());
  const data=repo.productSales({storeId:'store-a'}).views.find(v=>v.key==='30');
  assert.equal(data.summary.units,2);assert.deepEqual(data.summary.channels,{FBA:0,DBA:1,MFN:1});assert.equal(data.items.length,1);
  assert.equal(data.summary.grossCents,'20000');assert.equal(data.items[0].grossCents,'20000');
  const custom=repo.productSales({storeId:'store-a',channels:'FBA',from:'2026-09-01',to:'2026-09-01'}).views.find(v=>v.key==='custom');
  assert.equal(custom.summary.units,1);assert.equal(custom.summary.grossCents,'10000');assert.equal(custom.days,1);
  assert.equal(repo.productSales({storeId:'store-a',channels:'FBA'}).views.find(v=>v.key==='30').summary.units,1);
  assert.equal(repo.productSales({storeId:'store-a',channels:'FBA,DBA,MFN'}).views.find(v=>v.key==='30').summary.units,3);
  assert.equal(repo.productSales({storeId:'store-b'}).views.find(v=>v.key==='30').summary.units,1);
  assert.equal(JSON.stringify(repo.db.prepare('SELECT * FROM entities ORDER BY store_id,source_id').all()),before);
});

test('cached sales orders refresh after both local imports and external collector commits',async t=>{
  const {repo,rootDir,run}=await fixture(t);
  const summary=()=>repo.productSales({storeId:'store-a'}).views.find(view=>view.key==='30').summary;
  await repo.importRun(await run('store-a',{orders:[order('first','100.00',{fulfillment:{fulfillmentStatus:'SHIPPED',fulfilledBy:'MERCHANT'}})]}));
  assert.equal(summary().units,1);assert.equal(summary().units,1);
  const external=new DatabaseSync(path.join(rootDir,'test.sqlite'));
  try {external.prepare("UPDATE entities SET payload_json=json_set(payload_json,'$.items[0].quantityOrdered',4) WHERE store_id='store-a' AND source='orders'").run();}
  finally {external.close();}
  assert.equal(summary().units,4);assert.equal(summary().grossCents,'40000');
  await repo.importRun(await run('store-a',{orders:[order('second','50.00',{fulfillment:{fulfillmentStatus:'SHIPPED',fulfilledBy:'MERCHANT'}})]},at(11)));
  assert.equal(summary().units,5);assert.equal(summary().grossCents,'45000');
  assert.equal(repo.productSales({storeId:'store-b'}).views.find(view=>view.key==='30').summary.units,0);
  assert.equal(summary().units,5);
});

test('inventory sales forecast is opt-in, read-only and scoped by store before pagination', async t => {
  const { repo, run } = await fixture(t);
  const fbaOrder = quantity => order('same-id','100.00',{ programs: [], fulfillment: { fulfilledBy: 'AMAZON', fulfillmentStatus: 'SHIPPED' },
    orderItems: [{ orderItemId: 'item-a', quantityOrdered: quantity, product: { sellerSku: 'SKU-A', asin: 'ASIN-A' } }] });
  await repo.importRun(await run('store-a', { orders: [fbaOrder(3)], 'fba-inventory': [fba('SKU-A',14)] }));
  await repo.importRun(await run('store-b', { orders: [fbaOrder(9)], 'fba-inventory': [fba('SKU-A',7)] }));
  const before = JSON.stringify(repo.db.prepare('SELECT * FROM entities ORDER BY store_id,source,source_id').all());
  assert.equal(repo.inventory().forecast, undefined);
  assert.equal(repo.inventory().items[0].salesForecast, undefined);
  const data = repo.inventory({ storeId: 'store-a', forecast: 'true', limit: 1 });
  assert.equal(data.total,1); assert.deepEqual(data.forecast.periods,[30,60,90]);
  assert.equal(data.items[0].salesForecast[30].units,3);
  assert.equal(data.items[0].salesForecast[30].reason,'incomplete-history');
  assert.equal(repo.inventory({storeId:'store-b',forecast:'true'}).items[0].salesForecast[30].units,9);
  assert.equal(JSON.stringify(repo.db.prepare('SELECT * FROM entities ORDER BY store_id,source,source_id').all()),before);
});

test('consolidated inventory forecasts match the full history and cached pages observe imports from either connection', async t => {
  const { repo, run, rootDir } = await fixture(t);
  const fbaOrder = (id, quantity, extra={}) => order(id,'100.00',{programs:[],fulfillment:{fulfilledBy:'AMAZON',fulfillmentStatus:'SHIPPED'},
    orderItems:[{orderItemId:'item',quantityOrdered:quantity,product:{sellerSku:'SKU-A'}}],...extra});
  for (const [storeId,units] of [['store-a',3],['store-b',9]]) {
    await repo.importRun(await run(storeId,{orders:[fbaOrder('sale',units),fbaOrder('old',100,{createdTime:'2026-01-01T00:00:00Z'}),
      fbaOrder('unknown',2,{createdTime:null}),order('merchant')],'fba-inventory':[fba('SKU-A',14),fba('SKU-B',10)]}));
  }
  const basic=repo.inventory({storeId:'all'}), coverage=repo.getBootstrap({synchronize:false}).coverage;
  const orders=repo.db.prepare("SELECT payload_json FROM entities WHERE source='orders' AND active=1").all().map(row=>JSON.parse(row.payload_json));
  const expected=inventoryForecast({items:basic.items,orders,coverage});
  const actual=repo.inventory({storeId:'all',forecast:'true'});
  assert.deepEqual(actual.items,expected.items);
  assert.equal(actual.total,4); assert.equal(actual.summary.fulfillableQuantity,48);
  const page=repo.inventory({forecast:'true',offset:2,limit:2});
  assert.deepEqual(page.items,actual.items.slice(2));
  page.items[0].inventoryDetails.fulfillableQuantity=999;
  assert.equal(repo.inventory({forecast:'true',offset:2,limit:2}).items[0].inventoryDetails.fulfillableQuantity,10);
  await repo.importRun(await run('store-a',{'fba-inventory':[fba('SKU-A',25)]},at(11)));
  assert.equal(repo.inventory({forecast:'true'}).total,3);
  assert.equal(repo.inventory({storeId:'store-a',forecast:'true'}).items[0].inventoryDetails.fulfillableQuantity,25);
  const external=new DatabaseSync(path.join(rootDir,'test.sqlite'));
  try {
    external.prepare("UPDATE entities SET payload_json=json_set(payload_json,'$.inventoryDetails.fulfillableQuantity',30) WHERE store_id='store-b' AND source='fba-inventory' AND json_extract(payload_json,'$.sellerSku')='SKU-A'").run();
    external.prepare("UPDATE entities SET payload_json=json_set(payload_json,'$.items[0].quantityOrdered',12) WHERE store_id='store-b' AND source='orders' AND source_id='sale'").run();
    external.prepare("UPDATE entities SET active=0 WHERE store_id='store-b' AND source='orders' AND source_id='unknown'").run();
    const refreshed=repo.inventory({forecast:'true'});
    assert.equal(refreshed.items.find(row=>row.storeId==='store-b' && row.sellerSku==='SKU-A').inventoryDetails.fulfillableQuantity,30);
    assert.equal(refreshed.items.find(row=>row.storeId==='store-b' && row.sellerSku==='SKU-A').salesForecast[30].units,12);
    const updatedOrders=repo.db.prepare("SELECT payload_json FROM entities WHERE source='orders' AND active=1").all().map(row=>JSON.parse(row.payload_json));
    assert.deepEqual(refreshed.items,inventoryForecast({items:repo.inventory().items,orders:updatedOrders,coverage:repo.getBootstrap({synchronize:false}).coverage}).items);
  } finally { external.close(); }
});

test('workspace import isolates identical order/transaction IDs by store and reimport is idempotent', async t => {
  const { repo, run } = await fixture(t);
  await run('store-a', { orders: [order()], transactions: [tx()] });
  await run('store-b', { orders: [order('order-a', '200.00')], transactions: [tx('tx-a', '150.00')] });
  assert.deepEqual(await repo.loadWorkspace(), { imported: 2, skipped: 0, errors: [] });
  assert.deepEqual(await repo.loadWorkspace(), { imported: 0, skipped: 2, errors: [] });
  assert.equal(repo.orders({ storeId: 'store-a' }).total, 1);
  assert.equal(repo.orderDetail('store-a', 'order-a').financial.byCurrency[0].netCents, '8000');
  assert.equal(repo.orderDetail('store-b', 'order-a').financial.byCurrency[0].netCents, '15000');
  assert.equal(repo.dashboard().financeByCurrency[0].netCents, '23000');
  assert.equal(repo.getEntityHistory('store-a', 'transactions', 'tx-a').length, 1);
  assert.equal(repo.getBootstrap().stores[0].name, 'Loja A');
  assert.equal(repo.getBootstrap().coverage.length, 4);
});

test('pending payments stay operational but are excluded from every dashboard financial series and linked case summary', async t => {
  const { repo, run } = await fixture(t);
  const ref = (name,value) => ({relatedIdentifierName:name,relatedIdentifierValue:value});
  const linked = id => [ref('ORDER_ID',id)];
  const records = [order('pending','100.00',{fulfillment:{fulfillmentStatus:'Pending'}}),
    order('preorder','100.00',{fulfillment:{fulfillmentStatus:'PENDING_AVAILABILITY'}}),
    order('ready','100.00',{fulfillment:{fulfillmentStatus:'UNSHIPPED'}}),order('unknown'),
    order('package-pending','100.00',{packages:[{packageReferenceId:'p',packageStatus:{status:'PENDING'}}]})];
  const transactions = [tx('p-sale','80.00',{relatedIdentifiers:linked('pending')}),
    tx('p-refund','-10.00',{transactionType:'Refund',relatedIdentifiers:linked('pending')}),
    tx('p-fee','-3.00',{transactionType:'ServiceFee',relatedIdentifiers:linked('pending')}),
    tx('pre-sale','80.00',{relatedIdentifiers:linked('preorder')}),
    tx('ready-sale','80.00',{transactionStatus:'DEFERRED',relatedIdentifiers:linked('ready')}),
    tx('unknown-sale','80.00',{relatedIdentifiers:linked('unknown')}),
    tx('package-sale','80.00',{relatedIdentifiers:linked('package-pending')}),
    tx('absent-order-sale','80.00',{relatedIdentifiers:linked('not-imported')}),
    tx('general-ads','-5.00',{transactionType:'ProductAdsPayment',relatedIdentifiers:[]}),
    tx('pending-ads','-20.00',{transactionType:'ProductAdsPayment',relatedIdentifiers:linked('pending')}),
    tx('mixed-original','-15.00',{transactionType:'Refund',transactionStatus:'DEFERRED_RELEASED',
      relatedIdentifiers:[...linked('pending'),...linked('ready'),ref('RELEASE_TRANSACTION_ID','mixed-release')]}),
    tx('mixed-release','-15.00',{transactionType:'Refund',relatedIdentifiers:[ref('DEFERRED_TRANSACTION_ID','mixed-original')]})];
  await repo.importRun(await run('store-a',{orders:records,transactions}));
  await repo.importRun(await run('store-b',{orders:[order('pending','200.00',{fulfillment:{fulfillmentStatus:'SHIPPED'}})],
    transactions:[tx('p-sale','150.00',{relatedIdentifiers:linked('pending')})]}));
  const original = JSON.stringify(repo.db.prepare("SELECT * FROM entities WHERE source='transactions' ORDER BY store_id,source_id").all());
  const data=repo.dashboard({storeId:'store-a'});
  assert.equal(data.counts.orders,5);assert.equal(data.counts.excludedPendingOrders,2);
  assert.equal(data.counts.ordersWithoutCosts,3);assert.equal(data.counts.ordersWithoutAmount,0);
  assert.equal(data.counts.excludedPendingTransactions,6);assert.equal(data.counts.mixedPendingTransactions,1);
  assert.equal(data.salesByCurrency[0].grossCents,'30000');assert.equal(data.salesByCurrency[0].knownOrderCount,3);
  assert.equal(data.financeByCurrency[0].netCents,'31500');assert.equal(data.financeByCurrency[0].deferredCents,'8000');
  assert.equal(data.financeByCurrency[0].refundCents,'0');assert.equal(data.financeByCurrency[0].serviceFeeCents,'0');
  assert.equal(data.daily[0].netCents,'31500');assert.equal(data.byType.find(row=>row.type==='Shipment').totalCents,'32000');
  assert.equal(data.platformExpenses.byCurrency[0].adsCents,'-500');
  assert.equal(repo.dashboard().financeByCurrency[0].netCents,'46500');
  assert.equal(repo.dashboard({storeId:'store-a',from:'2026-09-03',to:'2026-09-03'}).financeByCurrency[0].netCents,'31500');
  assert.deepEqual(repo.dashboard({storeId:'store-a',status:'PENDING'}).financeByCurrency,[]);
  const pending=repo.orderDetail('store-a','pending');
  assert.equal(pending.financialEligibility.included,false);assert.deepEqual(pending.financial.byCurrency,[]);
  assert.equal(pending.grandTotalCents,'10000');assert.equal(pending.items[0].proceedsCents,'10000');
  assert.ok(pending.transactions.every(row=>row.financialEligibility.included===false));
  assert.equal(repo.orderDetail('store-a','ready').financial.byCurrency[0].netCents,'8000');
  assert.equal(repo.orderDetail('store-a','package-pending').displayStatus.label,'Envio pendente');
  assert.equal(repo.orderDetail('store-b','pending').financialEligibility.included,true);
  const refunds=repo.financialCases('refunds',{storeId:'store-a'}), charges=repo.financialCases('charges',{storeId:'store-a'});
  assert.equal(refunds.total,2);assert.equal(refunds.summary.excludedPendingCaseCount,2);assert.deepEqual(refunds.summary.byCurrency,[]);
  assert.ok(refunds.items.every(row=>row.financialEligibility.included===false&&row.totalCents!==null));
  assert.equal(charges.total,1);assert.deepEqual(charges.summary.byCurrency,[]);assert.equal(charges.summary.excludedPendingCaseCount,1);
  assert.ok(repo.safeTCases({storeId:'store-a'}).items.every(row=>row.financialEligibility.included===false));
  assert.equal(JSON.stringify(repo.db.prepare("SELECT * FROM entities WHERE source='transactions' ORDER BY store_id,source_id").all()),original);
});

test('omitted order status cannot release pending amounts, and an explicit authorized transition restores them once without reopening management', async t => {
  const { repo, run }=await fixture(t);
  const sources={orders:[order('order-a','100.00',{fulfillment:{fulfillmentStatus:'PENDING'}})],
    transactions:[tx(),tx('refund','-10.00',{transactionType:'Refund'})]};
  await repo.importRun(await run('store-a',sources,at(10)));repo.syncRefundManagement({now:at(10)});
  const first=repo.refundManagement({workflow:'all'}).items[0];
  repo.saveRefundManagement({action:'finalize',items:[{storeId:first.storeId,managementId:first.managementId,expectedVersion:0}],
    status:'rm_concluded',unpaidReason:'other',acknowledgePaymentVariance:false,note:'Histórico preservado.'});
  const before=repo.refundManagementDetail(first.storeId,first.managementId);
  const financialRows=JSON.stringify(repo.db.prepare("SELECT * FROM entities WHERE source='transactions' ORDER BY source_id").all());
  await repo.importRun(await run('store-a',{orders:[order()]},at(11)));
  assert.equal(repo.orderDetail('store-a','order-a').status,'PENDING');
  assert.deepEqual(repo.dashboard().salesByCurrency,[]);assert.deepEqual(repo.dashboard().financeByCurrency,[]);
  assert.equal(repo.getEntityHistory('store-a','orders','order-a').at(-1).payload.status,null,'Raw normalized observation retains the missing field');
  await repo.importRun(await run('store-a',{orders:[order('order-a','100.00',{fulfillment:{fulfillmentStatus:'UNSHIPPED'}})]},at(12)));
  repo.syncRefundManagement({now:at(12)});
  const after=repo.refundManagementDetail(first.storeId,first.managementId);
  assert.equal(repo.dashboard().salesByCurrency[0].grossCents,'10000');assert.equal(repo.dashboard().financeByCurrency[0].netCents,'7000');
  assert.equal(repo.orderDetail('store-a','order-a').financialEligibility.included,true);
  assert.equal(after.financialEligibility.included,true);assert.deepEqual(after.management,before.management);
  assert.deepEqual(after.history,before.history);assert.deepEqual(after.notes,before.notes);
  assert.equal(JSON.stringify(repo.db.prepare("SELECT * FROM entities WHERE source='transactions' ORDER BY source_id").all()),financialRows);
  repo.syncRefundManagement({now:at(13)});assert.equal(repo.dashboard().financeByCurrency[0].netCents,'7000');
});

test('query provenance classifies a pending FBA order without inventing payment data or changing raw snapshots', async t => {
  const { repo, rootDir, run } = await fixture(t);
  const pending = order('pending-fba', '123.45', { programs: [], proceeds: undefined });
  await repo.importRun(await run('store-a', { orders: [pending] }, at(10)));
  assert.equal(repo.orderDetail('store-a', 'pending-fba').fulfillmentMode, 'unknown');
  const store = new SnapshotStore({ rootDir, storeId: 'store-a' });
  const rawBody = body('orders', [pending]);
  const amazon = await store.savePage({ source: 'orders', body: rawBody });
  const merchant = await store.savePage({ source: 'orders', body: body('orders', []) });
  const manifest = { id: randomUUID(), storeId: 'store-a', startedAt: at(11), finishedAt: at(11), status: 'collected-awaiting-validation', sources: [{
    source: 'orders', dateBasis: 'created', requestedWindow: { from: at(1), to: at(10) },
    requestedFulfilledBy: ['AMAZON', 'MERCHANT'], status: 'api-pages-complete',
    pages: [{ ...amazon, observedAt: at(11), hasNextPage: false, requestFilters: { fulfilledBy: ['AMAZON'] } },
      { ...merchant, observedAt: at(11), hasNextPage: false, requestFilters: { fulfilledBy: ['MERCHANT'] } }],
  }] };
  await repo.importRun(manifest);
  const updated = repo.orderDetail('store-a', 'pending-fba');
  assert.equal(updated.fulfillmentMode, 'FBA');
  assert.equal(updated.fulfilledBy, 'AMAZON');
  assert.deepEqual(updated.fulfillmentEvidence, { source: 'api-filter', fulfilledBy: 'AMAZON' });
  assert.equal(updated.grandTotalCents, null);
  assert.equal(updated.status, null);
  assert.equal(updated.transactions.length, 0);
  assert.equal(repo.orders({ storeId: 'store-a', mode: 'FBA' }).total, 1);
  assert.equal(repo.getEntityHistory('store-a', 'orders', 'pending-fba').length, 2);
  assert.equal(await store.readPage({ source: 'orders', hash: amazon.hash }), rawBody);
  assert.equal((await repo.importRun(manifest)).imported, false);

  const onlyAmazon = structuredClone(manifest);
  onlyAmazon.id = randomUUID(); onlyAmazon.startedAt = at(12); onlyAmazon.finishedAt = at(12);
  onlyAmazon.sources[0].pages.pop();
  await repo.importRun(onlyAmazon);
  assert.equal(repo.getBootstrap().coverage.find(c => c.runId === onlyAmazon.id).status, 'partial');
  const missingProof = structuredClone(manifest);
  missingProof.id = randomUUID(); delete missingProof.sources[0].pages[0].requestFilters;
  await assert.rejects(repo.importRun(missingProof), /provenance/);
});

test('all revisions remain observable and an old snapshot cannot regress released finances', async t => {
  const { repo, run } = await fixture(t);
  const newer = await run('store-a', { transactions: [tx('tx-a', '81.23')] }, at(12));
  const old = await run('store-a', { transactions: [tx('tx-a', '80.00', { transactionStatus: 'DEFERRED' })] }, at(10));
  await repo.importRun(newer);
  await repo.importRun(old);
  assert.equal(repo.dashboard().financeByCurrency[0].netCents, '8123');
  assert.equal(repo.dashboard().financeByCurrency[0].releasedCents, '8123');
  assert.equal(repo.dashboard().financeByCurrency[0].deferredCents, '0');
  const updated = await run('store-a', { transactions: [tx('tx-a', '85.10')] }, at(13));
  await repo.importRun(updated);
  assert.equal(repo.dashboard().financeByCurrency[0].netCents, '8510');
  assert.equal(repo.getEntityHistory('store-a', 'transactions', 'tx-a').length, 3);
  assert.equal(repo.getEntityHistory('store-a', 'transactions', 'tx-a').at(-1).observedAt, at(13));
});

test('cancelled query proof persists across unfiltered observations and all four partitions determine coverage', async t => {
  const { repo, rootDir, run } = await fixture(t);
  const store = new SnapshotStore({ rootDir, storeId: 'store-a' });
  const cancelled = order('order-a');
  const rows = [[[], 'AMAZON', false], [[cancelled], 'MERCHANT', false], [[], 'AMAZON', true], [[cancelled], 'MERCHANT', true]];
  const pages = [];
  for (const [records, channel, overlay] of rows) {
    const saved = await store.savePage({ source: 'orders', body: body('orders', records) });
    pages.push({ ...saved, observedAt: at(11), hasNextPage: false, requestFilters: { fulfilledBy: [channel], ...(overlay ? { fulfillmentStatuses: ['CANCELLED'] } : {}) } });
  }
  const manifest = { id: randomUUID(), storeId: 'store-a', startedAt: at(11), finishedAt: at(11), status: 'collected-awaiting-validation', sources: [{
    source: 'orders', dateBasis: 'created', requestedWindow: { from: at(1), to: at(10) },
    requestedFulfilledBy: ['AMAZON', 'MERCHANT'], requestedFulfillmentStatuses: ['CANCELLED'], cancellationStatusStatus: 'complete', status: 'api-pages-complete', pages,
  }] };
  await repo.importRun(manifest);
  assert.equal(repo.orderDetail('store-a', 'order-a').status, 'CANCELLED');
  assert.equal(repo.getBootstrap().coverage[0].status, 'api-pages-complete');
  await repo.importRun(await run('store-a', { orders: [cancelled], transactions: [tx()] }, at(12)));
  const result = repo.orderDetail('store-a', 'order-a');
  assert.equal(result.status, 'CANCELLED');
  assert.equal(result.statusEvidence.observedAt, at(11));
  assert.equal(repo.getEntityHistory('store-a', 'orders', 'order-a').at(-1).payload.status, null);
  assert.equal(repo.dashboard().counts.cancelledOrders, 1);
  assert.deepEqual(repo.dashboard().salesByCurrency, []);
  assert.equal(repo.dashboard().financeByCurrency[0].netCents, '8000');
  const incomplete = structuredClone(manifest);
  incomplete.id = randomUUID(); incomplete.sources[0].pages.pop();
  await repo.importRun(incomplete);
  assert.equal(repo.getBootstrap().coverage.find(c => c.runId === incomplete.id).status, 'partial');
  const invalid = structuredClone(manifest);
  invalid.id = randomUUID(); invalid.sources[0].pages[3].requestFilters.fulfillmentStatuses = ['SHIPPED'];
  await assert.rejects(repo.importRun(invalid), /provenance/);
});

test('partial FBA snapshots never clear absent inventory and old snapshots cannot resurrect removed stock', async t => {
  const { repo, run } = await fixture(t);
  await repo.importRun(await run('store-a', { 'fba-inventory': [fba('A', 5), fba('B', 7)] }, at(10)));
  await repo.importRun(await run('store-a', { 'fba-inventory': [fba('A', 4)] }, at(11), 'partial'));
  assert.equal(repo.inventory().total, 2);
  assert.equal(repo.inventory({ storeId: 'store-a' }).summary.totalQuantity, 11);
  assert.equal(repo.inventory({ storeId: 'store-a', limit: 1 }).summary.totalQuantity, 11);
  await repo.importRun(await run('store-a', { 'fba-inventory': [fba('A', 3)] }, at(12)));
  assert.equal(repo.inventory().total, 1);
  await repo.importRun(await run('store-a', { 'fba-inventory': [fba('B', 99)] }, at(9), 'partial'));
  assert.equal(repo.inventory().total, 1);
  assert.equal(repo.inventory().items[0].totalQuantity, 3);
  await repo.importRun(await run('store-a', { 'fba-inventory': [] }, at(13)));
  assert.equal(repo.inventory().total, 0);
});

test('money stays exact, transfers stay separate, and costs/profit/bank receipts remain unknown', async t => {
  const { repo, run } = await fixture(t);
  await repo.importRun(await run('store-a', { orders: [order()], transactions: [
    tx('large', '9007199254740993.13'), tx('refund', '-0.13', { transactionType: 'Refund' }),
    tx('fee', '-2.00', { transactionType: 'ServiceFee' }), tx('transfer', '-500.00', { transactionType: 'Transfer' }),
    tx('usd', '3.00', { totalAmount: { currencyAmount: '3.00', currencyCode: 'USD' } }),
  ] }));
  const dashboard = repo.dashboard();
  const brl = dashboard.financeByCurrency.find(row => row.currency === 'BRL');
  assert.equal(brl.netCents, '900719925474099100');
  assert.equal(brl.transferCents, '-50000');
  assert.equal(brl.serviceFeeCents, '-200');
  assert.equal(dashboard.financeByCurrency.find(row => row.currency === 'USD').netCents, '300');
  assert.equal(dashboard.costCents, null);
  assert.equal(dashboard.profitCents, null);
  assert.equal(dashboard.cashReceivedCents, null);
  assert.equal(dashboard.salesByCurrency[0].grossCents, '10000');
  assert.equal(dashboard.salesByCurrency[0].knownOrderCount, 1);
  assert.equal(dashboard.counts.ordersWithoutCosts, 1);
  assert.doesNotThrow(() => JSON.stringify(dashboard));
  assert.equal(dashboard.daily.find(row => row.currency === 'BRL').netCents, brl.netCents);
});

test('only explicit release/deferred references suppress duplicates, never merely shared order IDs', async t => {
  const { repo, run } = await fixture(t);
  await repo.importRun(await run('store-a', { orders: [order()], transactions: [
    tx('deferred', '80.00', { transactionStatus: 'DEFERRED' }),
    tx('released', '80.00', { transactionStatus: 'DEFERRED_RELEASED', relatedIdentifiers: [
      { relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: 'order-a' },
      { relatedIdentifierName: 'DEFERRED_TRANSACTION_ID', relatedIdentifierValue: 'deferred' },
    ] }),
    tx('independent', '20.00', { transactionStatus: 'DEFERRED' }),
  ] }));
  const financial = repo.dashboard().financeByCurrency[0];
  assert.equal(financial.netCents, '10000');
  assert.equal(financial.releasedCents, '8000');
  assert.equal(financial.deferredCents, '2000');
  assert.equal(repo.dashboard().salesRevenue.netByCurrency[0].netCents, '10000');
  assert.equal(repo.dashboard().salesRevenue.netOrderCount, 1);
});

test('order net filters use exact per-currency evidence before facets and pagination', async t => {
  const { repo, run } = await fixture(t);
  const ref = (name, value) => ({ relatedIdentifierName: name, relatedIdentifierValue: value });
  const linked = id => [ref('ORDER_ID', id)];
  const sale = (id, value, extra = {}) => tx(`tx-${id}`, value, { relatedIdentifiers: linked(id), ...extra });
  const records = ['deferred', 'released', 'zero', 'negative', 'no-money', 'no-event', 'transfer', 'pending', 'mixed', 'currency'];
  await repo.importRun(await run('store-a', { orders: records.map(id => order(id, '100.00', {
    fulfillment: { fulfillmentStatus: id === 'pending' ? 'PENDING' : 'SHIPPED' },
  })), transactions: [
    sale('deferred', '80.00', { transactionStatus: 'DEFERRED' }),
    sale('released', '80.00', { transactionStatus: 'DEFERRED' }),
    tx('release', '80.00', { relatedIdentifiers: [...linked('released'), ref('DEFERRED_TRANSACTION_ID', 'tx-released')] }),
    sale('zero', '80.00'), tx('refund-zero', '-80.00', { transactionType: 'Refund', relatedIdentifiers: linked('zero') }),
    sale('negative', '-1.00'), sale('no-money', '80.00', { totalAmount: {} }),
    sale('transfer', '80.00', { transactionType: 'Transfer', transactionStatus: 'DEFERRED' }),
    sale('pending', '80.00', { transactionStatus: 'DEFERRED' }),
    sale('mixed', '80.00', { relatedIdentifiers: [...linked('mixed'), ...linked('zero')] }),
    sale('currency', '-999.00'), tx('usd', '1.00', { totalAmount: { currencyAmount: '1.00', currencyCode: 'USD' }, relatedIdentifiers: linked('currency') }),
  ] }));
  await repo.importRun(await run('store-b', { orders: [order('deferred')], transactions: [sale('deferred', '-99.00')] }));
  const scope = { storeId: 'store-a', net: 'positive', from: '2026-09-01', to: '2026-09-01', mode: 'DBA' };
  const first = repo.orders({ ...scope, limit: 1 });
  assert.equal(first.total, 3);
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.items.map(row => row.orderId), ['currency']);
  assert.equal(first.statusOptions.reduce((n, row) => n + row.count, 0), 3);
  assert.equal(repo.orders({ ...scope, limit: 1, offset: 1 }).items[0].orderId, 'deferred');
  assert.deepEqual(repo.orders({ ...scope, net: 'receivable' }).items.map(row => row.orderId), ['deferred']);
  assert.equal(repo.orders({ ...scope, query: 'released', net: 'receivable' }).total, 0);
  assert.equal(repo.orders({ ...scope, query: 'released' }).total, 1);
  assert.equal(repo.orders({ ...scope, status: 'CANCELLED' }).total, 0);
  assert.equal(repo.orders({ ...scope, from: '2026-09-02', to: '2026-09-02' }).total, 0);
  assert.equal(repo.orders({ ...scope, storeId: 'store-b' }).total, 0);
  assert.equal(repo.orders({ ...scope, storeId: 'all' }).total, 3);
  assert.equal(repo.orders({ storeId: 'store-a', net: 'all' }).total, records.length);
  assert.throws(() => repo.orders({ net: 'invalid' }), TypeError);
});

test('cached order pages isolate returned objects and invalidate on imports, tracking and reviews across connections', async t => {
  const { repo, rootDir, run } = await fixture(t);
  await repo.importRun(await run('store-a', { orders: [order()], transactions: [tx()] }));
  const filters = { storeId: 'store-a', net: 'positive', limit: 1 };
  const first = repo.orders(filters);
  first.items[0].items[0].title = 'Must not leak into another response';
  first.items[0].financial.byCurrency[0].netCents = '999999';
  first.statusOptions[0].count = 99;
  const again = repo.orders(filters);
  assert.equal(again.items[0].items[0].title, 'Produto teste');
  assert.equal(again.items[0].financial.byCurrency[0].netCents, '8000');
  assert.equal(again.statusOptions[0].count, 1);
  repo.saveLocalReview({ menu: 'orders', storeId: 'store-a', entityId: 'order-a', status: 'in_review', notes: 'Conferir', expectedVersion: 0 });
  assert.equal(repo.orders(filters).items[0].review.notes, 'Conferir');
  recordTrackingObservation(repo.db, { storeId: 'store-a', orderId: 'order-a', observedAt: at(11), packages: [{ trackingNumber: 'track-a', status: 'DELIVERED' }] });
  assert.equal(repo.orders(filters).items[0].displayStatus.code, 'DELIVERED');
  const collector = new Repository({ rootDir, dbPath: path.join(rootDir, 'test.sqlite') });
  try {
    await collector.importRun(await run('store-a', { transactions: [tx('refund', '-80.00', { transactionType: 'Refund' })] }, at(12)));
    assert.equal(repo.orders(filters).total, 0, 'An external collector commit must invalidate an already cached page');
    await collector.importRun(await run('store-a', { orders: [order('order-b')], transactions: [tx('tx-b', '40.00', { relatedIdentifiers: [{ relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: 'order-b' }] })] }, at(13)));
    assert.deepEqual(repo.orders(filters).items.map(row => row.orderId), ['order-b']);
  } finally { collector.close(); }
});

test('different order filters reuse the store catalogue but retain their own counts, statuses and pages', async t => {
  const { repo, rootDir, run } = await fixture(t);
  await repo.importRun(await run('store-a', { orders: [order(), order('order-b', '100.00', {
    createdTime: at(5), programs: [], fulfillment: { fulfilledBy: 'AMAZON', fulfillmentStatus: 'CANCELLED' },
  })], transactions: [tx()] }));
  const scope = { storeId: 'store-a', limit: 1 };
  repo.orders({ ...scope, query: 'order-a' });
  const originalPrepare = repo.db.prepare.bind(repo.db);
  const heavyReads = [];
  repo.db.prepare = sql => {
    if (/FROM (entities|tracking_observations|local_reviews)\b/i.test(sql)) heavyReads.push(sql);
    return originalPrepare(sql);
  };
  const queries = [{}, { query: 'order-b' }, { mode: 'FBA' }, { status: 'CANCELLED' }, { net: 'positive' }, { net: 'receivable' },
    { from: '2026-09-05', to: '2026-09-05' }, { offset: 1 }];
  const warm = queries.map(filter => repo.orders({ ...scope, ...filter }));
  assert.deepEqual(heavyReads, [], 'Changing filters must not reread every order, transaction and review');
  repo.db.prepare = originalPrepare;
  for (const [index, filter] of queries.entries()) {
    const cold = new Repository({ rootDir, dbPath: path.join(rootDir, 'test.sqlite') });
    try { assert.deepEqual(warm[index], cold.orders({ ...scope, ...filter })); } finally { cold.close(); }
  }
  assert.throws(() => repo.orders({ ...scope, reviewStatus: 'invalid' }), { code: 'INVALID_PARAMETERS' });
});

test('sales use creation date while finances use posting date; order detail keeps all known postings', async t => {
  const { repo, run } = await fixture(t);
  await repo.importRun(await run('store-a', { orders: [order()], transactions: [tx()] }));
  const salesDay = repo.dashboard({ from: '2026-09-01', to: '2026-09-01' });
  assert.equal(salesDay.counts.orders, 1);
  assert.equal(salesDay.counts.transactions, 0);
  assert.equal(salesDay.salesRevenue.grossByCurrency[0].grossCents, '10000');
  assert.equal(salesDay.salesRevenue.netByCurrency[0].netCents, '8000');
  const postingDay = repo.dashboard({ from: '2026-09-03', to: '2026-09-03' });
  assert.equal(postingDay.counts.orders, 0);
  assert.deepEqual(postingDay.salesRevenue.netByCurrency, []);
  assert.equal(postingDay.financeByCurrency[0].netCents, '8000');
  assert.equal(repo.orders({ from: '2026-09-01', to: '2026-09-01', query: 'sku-a', mode: 'DBA' }).items[0].financial.byCurrency[0].netCents, '8000');
  assert.equal(repo.orders({ query: 'missing' }).total, 0);
});

test('a DEFERRED_RELEASED refund and its referenced RELEASED movement count only once', async t => {
  const { repo, run } = await fixture(t);
  const original = tx('refund-original', '-745.24', { transactionType: 'Refund', transactionStatus: 'DEFERRED_RELEASED', postedDate: at(6), relatedIdentifiers: [
    { relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: 'order-a' },
    { relatedIdentifierName: 'RELEASE_TRANSACTION_ID', relatedIdentifierValue: 'refund-release' },
  ] });
  const release = tx('refund-release', '-745.24', { transactionType: 'Refund', postedDate: at(16), relatedIdentifiers: [
    { relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: 'order-a' },
    { relatedIdentifierName: 'DEFERRED_TRANSACTION_ID', relatedIdentifierValue: 'refund-original' },
  ] });
  await repo.importRun(await run('store-a', { orders: [order()], transactions: [original, release] }, at(20)));
  assert.equal(repo.dashboard().financeByCurrency[0].refundCents, '-74524');
  assert.equal(repo.dashboard().counts.refunds, 1);
  assert.equal(repo.dashboard().counts.refundedOrders, 1);
  const detail = repo.orderDetail('store-a', 'order-a');
  assert.equal(detail.financial.supersededDeferredCount, 1);
  assert.equal(detail.transactions.find(tx => tx.transactionId === 'refund-original').supersededByRelease, true);
});

test('multi-order financial amounts are not allocated in full to every order', async t => {
  const { repo, run } = await fixture(t);
  await repo.importRun(await run('store-a', { orders: [order('order-a'), order('order-b', '100.00', { programs: [], fulfillment: { fulfilledBy: 'AMAZON' } })], transactions: [tx('multi', '150.00', { relatedIdentifiers: [
    { relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: 'order-a' }, { relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: 'order-b' },
  ] })] }));
  const detail = repo.orderDetail('store-a', 'order-a');
  assert.deepEqual(detail.financial.byCurrency, []);
  assert.equal(detail.financial.unallocatedTransactionCount, 1);
  assert.equal(detail.transactions[0].allocation, 'multiple-orders-unallocated');
  assert.equal(repo.dashboard().financeByCurrency[0].netCents, '15000');
  assert.deepEqual(repo.dashboard({ mode: 'DBA' }).financeByCurrency, []);
  assert.equal(repo.dashboard({ mode: 'DBA' }).counts.unallocatedFilteredTransactionCount, 1);
});

test('invalid snapshots fail the whole import without committing false coverage', async t => {
  const { repo, run, rootDir } = await fixture(t);
  const manifest = await run('store-a', { orders: [order()], transactions: [tx()] });
  const page = manifest.sources[1].pages[0];
  await writeFile(path.join(rootDir, 'store-a', page.relativePath), '{}');
  await assert.rejects(repo.importRun(manifest), /integrity/i);
  assert.equal(repo.orders().total, 0);
  assert.equal(repo.getBootstrap().coverage.length, 0);
  assert.equal((await repo.loadWorkspace()).errors.length, 1);
});

test('missing inventory quantities remain unknown instead of being added as zero', async t => {
  const { repo, run } = await fixture(t);
  await repo.importRun(await run('store-a', { 'fba-inventory': [fba('A', 3), { sellerSku: 'B', totalQuantity: 2 }] }));
  const summary = repo.inventory({ storeId: 'store-a' }).summary;
  assert.equal(summary.totalQuantity, 5);
  assert.equal(summary.fulfillableQuantity, null);
  assert.ok(summary.unknownQuantities > 0);
});

test('uncollected and failed FBA sources are unknown, while a known empty snapshot is zero', async t => {
  const { repo, run } = await fixture(t);
  assert.equal(repo.inventory({ storeId: 'store-a' }).state, 'missing');
  assert.equal(repo.inventory({ storeId: 'store-a' }).summary.totalQuantity, null);
  const failed = { id: randomUUID(), storeId: 'store-a', startedAt: at(10), finishedAt: at(10), status: 'failed', sources: [
    { source: 'fba-inventory', status: 'failed', dateBasis: 'current-snapshot', startedAt: at(10), finishedAt: at(10), pages: [] },
  ] };
  await repo.importRun(failed);
  assert.equal(repo.inventory({ storeId: 'store-a' }).state, 'missing');
  assert.equal(repo.inventory({ storeId: 'store-a' }).summary.fulfillableQuantity, null);
  assert.equal(repo.getBootstrap().latestSync, null);
  assert.equal(repo.getBootstrap().latestAttemptAt, at(10));
  await repo.importRun(await run('store-a', { 'fba-inventory': [] }, at(11)));
  assert.equal(repo.inventory({ storeId: 'store-a' }).state, 'complete');
  assert.equal(repo.inventory({ storeId: 'store-a' }).summary.totalQuantity, 0);
  assert.equal(repo.inventory({ storeId: 'store-a' }).summary.fulfillableQuantity, 0);
  assert.equal(repo.inventory({ storeId: 'all' }).state, 'incomplete');
  assert.equal(repo.inventory({ storeId: 'all' }).summary.totalQuantity, null);
  assert.deepEqual(repo.inventory({ storeId: 'all' }).missingStoreIds, ['store-b']);
  const newerFailure = { ...failed, id: randomUUID(), startedAt: at(12), finishedAt: at(12), sources: [{ ...failed.sources[0], startedAt: at(12), finishedAt: at(12) }] };
  await repo.importRun(newerFailure);
  assert.equal(repo.inventory({ storeId: 'store-a' }).state, 'stale');
  assert.equal(repo.inventory({ storeId: 'store-a' }).summary.totalQuantity, 0);
  assert.equal(repo.getBootstrap().latestSync, at(11));
  assert.equal(repo.getBootstrap().latestAttemptAt, at(12));
});

test('status options count the whole store/date/mode/query scope before pagination and selected status', async t => {
  const { repo, run } = await fixture(t);
  const scopedOrder = (id, status, extra = {}) => order(id, '100.00', {
    createdTime: at(6), ...(status ? { fulfillment: { fulfilledBy: 'MERCHANT', fulfillmentStatus: status } } : {}), ...extra,
  });
  await repo.importRun(await run('store-a', { orders: [
    scopedOrder('wanted-returned', 'SHIPPED', { packages: [{ packageReferenceId: 'package-returned', packageStatus: { status: 'IN_TRANSIT', detailedStatus: 'PICKED_UP' } }] }),
    scopedOrder('wanted-pending-a', 'UNSHIPPED'), scopedOrder('wanted-pending-b', 'UNSHIPPED'),
    scopedOrder('wanted-cancelled', 'CANCELLED'), scopedOrder('wanted-unknown'),
    scopedOrder('wanted-before-period', 'PENDING', { createdTime: at(4) }),
    scopedOrder('wanted-after-period', 'PENDING', { createdTime: at(8) }),
    scopedOrder('wanted-other-mode', 'PENDING', { programs: [], fulfillment: { fulfilledBy: 'AMAZON', fulfillmentStatus: 'PENDING' } }),
    scopedOrder('outside-text-query', 'PENDING'),
  ] }, at(10)));
  await repo.importRun(await run('store-b', { orders: [scopedOrder('wanted-other-store', 'PENDING')] }, at(10)));
  recordTrackingObservation(repo.db, { storeId: 'store-a', orderId: 'wanted-returned', observedAt: at(11),
    packages: [{ packageReferenceId: 'package-returned', status: 'UNDELIVERABLE', detailedStatus: 'RETURNED_TO_SELLER' }] });

  const scope = { storeId: 'store-a', from: '2026-09-05', to: '2026-09-07', mode: 'DBA', query: 'wanted' };
  assert.equal(repo.orders().total, 10);
  const firstPage = repo.orders({ ...scope, limit: 1 });
  assert.equal(firstPage.total, 5);
  assert.equal(firstPage.items.length, 1);
  assert.equal(firstPage.hasMore, true);
  assert.deepEqual(Object.fromEntries(firstPage.statusOptions.map(option => [option.code, option.count])), {
    CANCELLED: 1, RETURNED_TO_SELLER: 1, UNSHIPPED: 2, UNKNOWN: 1,
  });
  assert.equal(firstPage.statusOptions.reduce((sum, option) => sum + option.count, 0), 5);
  assert.ok(firstPage.statusOptions.every(option => typeof option.label === 'string' && option.label.length > 0));

  const selected = repo.orders({ ...scope, status: 'UNSHIPPED', limit: 1, offset: 1 });
  assert.equal(selected.total, 2);
  assert.equal(selected.items.length, 1);
  assert.equal(selected.items[0].displayStatus.code, 'UNSHIPPED');
  assert.equal(selected.hasMore, false);
  assert.deepEqual(selected.statusOptions, firstPage.statusOptions);
  const emptySelection = repo.orders({ ...scope, status: 'LOST', limit: 1 });
  assert.equal(emptySelection.total, 0);
  assert.deepEqual(emptySelection.items, []);
  assert.deepEqual(emptySelection.statusOptions, firstPage.statusOptions);
  const union = repo.orders({ ...scope, status: 'cancelled,UNSHIPPED,PENDING', limit: 1, offset: 1 });
  assert.equal(union.total, 3);
  assert.equal(union.items.length, 1);
  assert.equal(union.hasMore, true);
  assert.deepEqual(union.statusOptions, firstPage.statusOptions);
  assert.deepEqual(new Set(repo.orders({ ...scope, status: 'cancelled,UNSHIPPED,PENDING' }).items.map(item => item.orderId)),
    new Set(['wanted-cancelled', 'wanted-pending-a', 'wanted-pending-b']));
  assert.equal(repo.dashboard({ ...scope, status: 'cancelled,UNSHIPPED,PENDING' }).counts.orders, 3);
});

test('multiple operational statuses retain exact currency totals and count a shared transaction once', async t => {
  const { repo, run } = await fixture(t);
  const linked = (id, amount, orderIds, extra = {}) => tx(id, amount, {
    relatedIdentifiers: orderIds.map(orderId => ({ relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: orderId })), ...extra,
  });
  await repo.importRun(await run('store-a', { orders: [
    order('delivered', '100.00', { packages: [{ packageReferenceId: 'package-a', packageStatus: { status: 'DELIVERED' } }] }),
    order('cancelled', '200.00', { fulfillment: { fulfilledBy: 'MERCHANT', fulfillmentStatus: 'CANCELLED' } }),
    order('pending', '300.00', { fulfillment: { fulfilledBy: 'MERCHANT', fulfillmentStatus: 'PENDING' } }),
  ], transactions: [
    linked('sale-delivered', '9007199254740993.13', ['delivered']),
    linked('cancelled-adjustment', '5.00', ['cancelled'], { transactionType: 'Adjustment', totalAmount: { currencyAmount: '5.00', currencyCode: 'USD' } }),
    linked('both-orders', '2.00', ['delivered', 'cancelled']),
    linked('excluded-pending', '999.00', ['pending']),
  ] }));
  const filters = { storeId: 'store-a', status: 'CANCELLED,DELIVERED' };
  const selected = repo.orders(filters);
  assert.equal(selected.total, 2);
  assert.equal(new Set(selected.items.map(item => item.orderId)).size, 2);
  const totals = repo.dashboard(filters).financeByCurrency;
  assert.equal(totals.find(item => item.currency === 'BRL').netCents, '900719925474099513');
  assert.equal(totals.find(item => item.currency === 'USD').netCents, '500');
  assert.equal(totals.reduce((sum, item) => sum + item.transactionCount, 0), 3);
  assert.equal(repo.dashboard({ ...filters, status: 'DELIVERED' }).financeByCurrency[0].netCents, '900719925474099313');
});

test('status CSV rejects malformed or unbounded selections even for an empty store', async t => {
  const { repo } = await fixture(t);
  const codes = Array.from({ length: 51 }, (_, index) => `CODE_${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + index % 26)}`);
  for (const status of [null, {}, [], ['CANCELLED'], 5, '', ' ', ',CANCELLED', 'CANCELLED,',
    'CANCELLED,,DELIVERED', 'CANCELLED, CANCELLED', 'CANCELLED,CANCELLED', 'cancelled,CANCELLED',
    'all,CANCELLED', 'ALL,all', 'NEW-STATUS', 'STATUS2', 'ENTREGUÉ', 'A'.repeat(51), codes.join(',')]) {
    assert.throws(() => repo.orders({ status }), { code: 'INVALID_PARAMETERS' });
    assert.throws(() => repo.dashboard({ status }), { code: 'INVALID_PARAMETERS' });
  }
  assert.equal(repo.orders({ status: codes.slice(0, 50).map(code => code.padEnd(50, '_')).join(',') }).total, 0);
  assert.equal(repo.orders({ status: 'all' }).total, 0);
  assert.equal(repo.orders({ status: 'ALL' }).total, 0);
  assert.equal(repo.orders().total, 0);
});

test('SKU search collapses whitespace only for matching while retaining date scope and distinct inventory identities', async t => {
  const { repo, run } = await fixture(t);
  const storedSku = 'KIT  Cabo\tUSB', compactSku = 'KIT Cabo USB';
  const skuOrder = (id, createdTime) => {
    const item = order(id, '100.00', { createdTime });
    item.orderItems[0].product.sellerSku = storedSku;
    return item;
  };
  await repo.importRun(await run('store-a', { orders: [skuOrder('order-a', at(6)), skuOrder('old-order', at(1))],
    'fba-inventory': [fba(storedSku, 2), fba(compactSku, 3)] }));
  await repo.importRun(await run('store-b', { orders: [skuOrder('other-store', at(6))], 'fba-inventory': [fba(storedSku, 7)] }));
  const historyBefore = repo.getEntityHistory('store-a', 'orders', 'order-a');
  const scope = { storeId: 'store-a', from: '2026-09-05', to: '2026-09-07', mode: 'DBA' };
  for (const query of ['kit cabo usb', '  KIT\t CABO   USB  ', 'Kit\nCabo\tUSB']) {
    const found = repo.orders({ ...scope, query });
    assert.deepEqual(found.items.map(item => item.orderId), ['order-a']);
    assert.equal(found.items[0].items[0].sku, storedSku);
    assert.equal(repo.dashboard({ ...scope, query }).counts.orders, 1);
    const inventory = repo.inventory({ storeId: 'store-a', query });
    assert.equal(inventory.total, 2);
    assert.equal(inventory.summary.totalQuantity, 5);
    assert.deepEqual(new Set(inventory.items.map(item => item.sellerSku)), new Set([storedSku, compactSku]));
  }
  assert.equal(repo.orders({ storeId: 'store-a', query: 'kit cabo usb' }).total, 2);
  assert.equal(repo.orders({ ...scope, query: 'kit cabo lightning' }).total, 0);
  assert.deepEqual(repo.getEntityHistory('store-a', 'orders', 'order-a'), historyBefore);
  assert.equal(historyBefore[0].payload.items[0].sku, storedSku);
});

test('unified status filters latest tracking while cancellation wins and financial evidence is unchanged', async t => {
  const { repo, run } = await fixture(t);
  const shippedPackage = { packageReferenceId: 'package-a', trackingNumber: 'tracking-a', packageStatus: { status: 'IN_TRANSIT', detailedStatus: 'PICKED_UP' } };
  const cancelledPackage = { packageReferenceId: 'package-cancelled', trackingNumber: 'tracking-cancelled', packageStatus: { status: 'DELIVERED', detailedStatus: 'DELIVERED' } };
  await repo.importRun(await run('store-a', {
    orders: [
      order('order-a', '100.00', { fulfillment: { fulfilledBy: 'MERCHANT', fulfillmentStatus: 'SHIPPED' }, packages: [shippedPackage] }),
      order('order-cancelled', '200.00', { fulfillment: { fulfilledBy: 'MERCHANT', fulfillmentStatus: 'CANCELLED' }, packages: [cancelledPackage] }),
    ],
    transactions: [tx('shipment-exact', '9007199254740993.13'), tx('refund-exact', '-0.13', { transactionType: 'Refund' }),
      tx('cancelled-charge', '-2.00', { transactionType: 'ServiceFee', relatedIdentifiers: [{ relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: 'order-cancelled' }] })],
  }, at(10)));
  const beforeEntities = repo.db.prepare('SELECT * FROM entities ORDER BY source,source_id').all();
  const beforeFinancial = repo.orderDetail('store-a', 'order-a').financial;
  const beforeDashboard = repo.dashboard({ storeId: 'store-a' }).financeByCurrency;
  assert.equal(repo.orders({ status: 'RETURNED_TO_SELLER' }).total, 0);
  assert.equal(repo.orderDetail('store-a', 'order-cancelled').displayStatus.code, 'CANCELLED');

  recordTrackingObservation(repo.db, { storeId: 'store-a', orderId: 'order-a', observedAt: at(11),
    packages: [{ packageReferenceId: 'package-a', status: 'IN_TRANSIT', detailedStatus: 'RETURNING_TO_SELLER' }] });
  recordTrackingObservation(repo.db, { storeId: 'store-a', orderId: 'order-a', observedAt: at(12),
    packages: [{ packageReferenceId: 'package-a', status: 'UNDELIVERABLE', detailedStatus: 'RETURNED_TO_SELLER' }] });
  recordTrackingObservation(repo.db, { storeId: 'store-a', orderId: 'order-a', observedAt: at(13),
    packages: [{ packageReferenceId: 'package-a' }] });
  recordTrackingObservation(repo.db, { storeId: 'store-a', orderId: 'order-cancelled', observedAt: at(12),
    packages: [{ packageReferenceId: 'package-cancelled', status: 'UNDELIVERABLE', detailedStatus: 'RETURNED_TO_SELLER' }] });

  const returned = repo.orders({ storeId: 'store-a', status: 'RETURNED_TO_SELLER' });
  assert.equal(returned.total, 1);
  assert.equal(returned.items[0].orderId, 'order-a');
  assert.equal(returned.items[0].status, 'SHIPPED');
  assert.equal(returned.items[0].displayStatus.code, 'RETURNED_TO_SELLER');
  assert.equal(returned.items[0].displayStatus.source, 'tracking');
  assert.equal(returned.items[0].trackingObservedAt, at(13));
  assert.equal(returned.items[0].packages[0].trackingNumber, 'tracking-a');
  assert.equal(repo.orders({ storeId: 'store-a', status: 'RETURNING_TO_SELLER' }).total, 0);
  const cancelled = repo.orders({ storeId: 'store-a', status: 'CANCELLED' });
  assert.equal(cancelled.total, 1);
  assert.equal(cancelled.items[0].orderId, 'order-cancelled');
  assert.equal(cancelled.items[0].displayStatus.source, 'order');
  assert.equal(cancelled.items[0].packages[0].detailedStatus, 'RETURNED_TO_SELLER');
  assert.deepEqual(Object.fromEntries(returned.statusOptions.map(option => [option.code, option.count])), { CANCELLED: 1, RETURNED_TO_SELLER: 1 });
  assert.deepEqual(returned.items[0].financial, beforeFinancial);
  assert.equal(returned.items[0].financial.byCurrency[0].netCents, '900719925474099300');
  assert.equal(returned.items[0].grandTotalCents, '10000');
  assert.deepEqual(repo.dashboard({ storeId: 'store-a' }).financeByCurrency, beforeDashboard);
  assert.deepEqual(repo.db.prepare('SELECT * FROM entities ORDER BY source,source_id').all(), beforeEntities);
});

test('SAFE-T combines full refund and return evidence with current tracking, original dates and store isolation', async t => {
  const { repo, run } = await fixture(t);
  const original = tx('refund-original', '-80.00', { transactionType: 'Refund', transactionStatus: 'DEFERRED_RELEASED',
    relatedIdentifiers: [{ relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: 'order-a' },
      { relatedIdentifierName: 'RELEASE_TRANSACTION_ID', relatedIdentifierValue: 'refund-release' }] });
  const release = tx('refund-release', '-80.00', { transactionType: 'Refund', postedDate: at(18),
    relatedIdentifiers: [{ relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: 'order-a' },
      { relatedIdentifierName: 'DEFERRED_TRANSACTION_ID', relatedIdentifierValue: 'refund-original' }] });
  const first = await run('store-a', { orders: [order('order-a', '100.00', {
    fulfillment: { fulfilledBy: 'MERCHANT', fulfillmentStatus: 'SHIPPED' },
    packages: [{ packageReferenceId: 'package-a', packageStatus: { status: 'IN_TRANSIT', detailedStatus: 'PICKED_UP' } }] })],
    transactions: [original, release, tx('safe-t-credit-only', '90.00', { transactionType: 'Adjustment',
      relatedIdentifiers: [{ relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: 'credit-without-refund' }],
      breakdowns: [{ breakdownType: 'SAFETReimbursement', breakdownAmount: { currencyAmount: '90.00', currencyCode: 'BRL' } }] })] });
  await repo.importRun(first);
  await repo.importRun(await run('store-b', { orders: [order()], transactions: [tx('refund-b', '-30.00', { transactionType: 'Refund' })] }));
  const reportType = 'GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE';
  saveCustomerReturnJob(repo.db, { storeId: 'store-a', reportId: 'returns-test', reportType, status: 'DONE',
    from: at(1), to: at(20), createdAt: at(20), checkedAt: at(20) });
  importCustomerReturnReport(repo.db, { storeId: 'store-a', reportId: 'returns-test', reportType, observedAt: at(20), records: [
    { orderId: 'order-a', sku: 'SKU-A', rmaId: 'rma-a', returnStatus: 'Approved', returnRequestedAt: at(2), reportedRefundCents: '8000', currency: 'BRL' },
    { orderId: 'report-only', sku: 'SKU-REPORT', rmaId: 'rma-b', returnStatus: 'Open', returnRequestedAt: at(4), reportedRefundCents: '7000', currency: 'BRL' },
  ] });
  recordTrackingObservation(repo.db, { storeId: 'store-a', orderId: 'order-a', observedAt: at(11),
    packages: [{ packageReferenceId: 'package-a', status: 'UNDELIVERABLE', detailedStatus: 'RETURNED_TO_SELLER' }] });
  recordTrackingObservation(repo.db, { storeId: 'store-a', orderId: 'order-a', observedAt: at(12),
    packages: [{ packageReferenceId: 'package-a', status: 'DELIVERED', detailedStatus: 'DELIVERED' }] });
  const existing = repo.financialCases('refunds', { storeId: 'store-a' }).items[0];
  repo.saveFinancialReview({ kind: 'refunds', storeId: 'store-a', caseId: existing.caseId, status: 'in_review',
    notes: 'Review must remain unchanged.', expectedVersion: 0 });
  const entities = JSON.stringify(repo.db.prepare('SELECT * FROM entities ORDER BY store_id,source,source_id').all());
  const reviews = JSON.stringify(repo.db.prepare('SELECT * FROM financial_case_reviews').all());
  const result = repo.safeTCases({ status: 'all' });
  assert.equal(result.total, 3);
  const a = result.items.find(row => row.storeId === 'store-a' && row.orderId === 'order-a');
  assert.deepEqual(a.refund.byCurrency, [{ currency: 'BRL', totalCents: '-8000' }]);
  assert.equal(a.refund.count, 1); assert.equal(a.refund.latestPostedAt, at(3));
  assert.equal(a.products.length, 1);
  assert.equal(a.displayStatus.code, 'DELIVERED');
  assert.equal(a.returnedToSeller.detectedAt, at(11));
  assert.equal(a.returnedToSeller.returnStatusChanged, true);
  assert.deepEqual(a.refundCaseIds, [existing.caseId]);
  assert.equal(result.items.find(row => row.storeId === 'store-b').customerReturns.length, 0);
  const dated = repo.safeTCases({ storeId: 'store-a', from: '2026-09-03', to: '2026-09-03', status: 'DELIVERED,CUSTOMER_RETURN', query: 'SKU-A', mode: 'DBA' });
  assert.equal(dated.total, 1);
  assert.equal(repo.safeTCases({ storeId: 'store-a', from: '2026-09-18', to: '2026-09-18' }).total, 0);
  assert.equal(repo.safeTCases({ storeId: 'store-a', from: '2026-09-18', to: '2026-09-18' }).summary.withoutDateCount, 1);
  assert.equal(repo.safeTCases({ storeId: 'store-a', status: 'OPEN_RETURN' }).items[0].orderId, 'report-only');
  assert.equal((await repo.importRun(first)).imported, false);
  assert.equal(repo.safeTCases().total, 3);
  assert.equal(JSON.stringify(repo.db.prepare('SELECT * FROM entities ORDER BY store_id,source,source_id').all()), entities);
  assert.equal(JSON.stringify(repo.db.prepare('SELECT * FROM financial_case_reviews').all()), reviews);
});

test('SAFE-T consumes financial pages beyond five hundred cases before query and pagination', async t => {
  const { repo, run } = await fixture(t);
  const ids = Array.from({ length: 501 }, (_, index) => `order-${String(index).padStart(4, '0')}`);
  await repo.importRun(await run('store-a', { transactions: ids.map(id => tx(`refund-${id}`, '-1.01', {
    transactionType: 'Refund', relatedIdentifiers: [{ relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: id }] })) }));
  const firstPageIds = new Set(repo.financialCases('refunds', { limit: 500 }).items.map(item => item.orderIds[0]));
  const lastPageOrder = ids.find(id => !firstPageIds.has(id));
  assert.ok(lastPageOrder);
  const result = repo.safeTCases({ query: lastPageOrder, limit: 1 });
  assert.equal(result.total, 1);
  assert.equal(result.items[0].orderId, lastPageOrder);
  assert.deepEqual(result.items[0].refund.byCurrency, [{ currency: 'BRL', totalCents: '-101' }]);
  const last = repo.safeTCases({ limit: 500, offset: 500 });
  assert.equal(last.total, 501); assert.equal(last.items.length, 1); assert.equal(last.hasMore, false);
  assert.equal(last.summary.availableOrderCount, 501);
});


test('composition drilldown reconciles every row and bucket without pending or superseded postings', async t => {
  const { repo, run } = await fixture(t);
  const ref = (name,value) => ({ relatedIdentifierName:name, relatedIdentifierValue:value });
  await repo.importRun(await run('store-a', { orders: [order(), order('pending','100.00',{fulfillment:{fulfillmentStatus:'PENDING'}})], transactions: [
    tx('original','80.00',{transactionStatus:'DEFERRED',postedDate:at(2)}),
    tx('release','80.00',{relatedIdentifiers:[ref('ORDER_ID','order-a'),ref('DEFERRED_TRANSACTION_ID','original')]}),
    tx('deferred','30.00',{transactionStatus:'DEFERRED'}),
    tx('fee','-5.00',{transactionType:'ServiceFee',relatedIdentifiers:[],breakdowns:[{breakdownType:'ShippingCharge',breakdownAmount:{currencyAmount:'-5.00',currencyCode:'BRL'}}]}),
    tx('refund','-10.00',{transactionType:'Refund'}),
    tx('adjustment','2.00',{transactionType:'Adjustment',transactionStatus:'UNKNOWN'}),
    tx('transfer','100.00',{transactionType:'Transfer'}),
    tx('usd','10.00',{totalAmount:{currencyAmount:'10.00',currencyCode:'USD'}}),
    tx('pending-sale','80.00',{relatedIdentifiers:[ref('ORDER_ID','pending')]}),
    tx('missing','0.00',{totalAmount:null}),
    tx('boundary-out','999.00',{postedDate:'2026-09-03T02:59:59Z'}),
    tx('boundary-in','1.00',{postedDate:'2026-09-04T02:59:59Z'}),
  ] }));
  await repo.importRun(await run('store-b', { orders:[order()],transactions:[tx('release','7.00')] }));
  const scopes = [{storeId:'store-a'}, {storeId:'all'}, {storeId:'store-b'}, {storeId:'store-a',mode:'DBA',query:'SKU-A'}];
  for (const scope of scopes) {
    const filters = {...scope,from:'2026-09-03',to:'2026-09-03'}, dashboard = repo.dashboard(filters);
    for (const row of dashboard.byType) {
      const detail=repo.dashboardTransactions({...filters,bucket:'type',type:row.type,currency:row.currency});
      assert.equal(detail.total,row.count);
      assert.equal(detail.totals[0].totalCents,row.totalCents);
      assert.equal(detail.items.reduce((sum,item)=>sum+BigInt(item.totalCents),0n).toString(),row.totalCents);
    }
    for (const row of dashboard.financeByCurrency) {
      for (const [bucket,key] of [['net','netCents'],['released','releasedCents'],['deferred','deferredCents']]) {
        const detail=repo.dashboardTransactions({...filters,bucket,currency:row.currency});
        assert.equal(detail.totals[0]?.totalCents ?? '0',row[key]);
        assert.equal(detail.items.some(item=>['pending-sale','original','transfer','missing','boundary-out'].includes(item.transactionId)),false);
      }
    }
  }
  const filters={storeId:'store-a',from:'2026-09-03',to:'2026-09-03',bucket:'net',currency:'BRL'};
  const all=repo.dashboardTransactions(filters);
  assert.equal(all.totals[0].totalCents,'9800');
  const first=repo.dashboardTransactions({...filters,limit:2}), second=repo.dashboardTransactions({...filters,limit:2,offset:2});
  assert.equal(first.total,all.total); assert.equal(first.hasMore,true);
  assert.deepEqual([...first.items,...second.items].map(item=>item.transactionId),all.items.slice(0,4).map(item=>item.transactionId));
  assert.deepEqual(first.totals,all.totals);
  const fee=all.items.find(item=>item.transactionId==='fee');
  assert.deepEqual(fee.linkedOrders,[]); assert.equal(fee.breakdowns[0].amountCents,'-500');
  assert.equal(all.items.find(item=>item.transactionId==='release').linkedOrders[0].available,true);
  assert.equal(repo.dashboardTransactions({storeId:'store-a',bucket:'type',type:'Shipment',from:'2026-09-02',to:'2026-09-02'}).items.some(item=>item.transactionId==='original'),false,'Release outside window still suppresses original');
  assert.equal(repo.dashboardTransactions({...filters,type:undefined,from:'2026-01-01',to:'2026-01-01'}).total,0);
});
