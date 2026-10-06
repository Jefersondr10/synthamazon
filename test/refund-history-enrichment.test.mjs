import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { Repository } from '../src/domain/repository.mjs';
import { SnapshotStore } from '../src/storage.mjs';
import { collectMissingRefundHistory, validateRefundHistoryRun, refundHistoryRecords, REFUND_HISTORY_IMPORT } from '../src/refund-history-enrichment.mjs';

// Synthetic identifiers and amounts: never embed records from a real store.
const orderId = '700-0000001-0000002', storeId = 'store-a';
const config = { storeId, marketplaceId: 'A2Q3Y263D00KWC' };
const observedAt = '2026-09-27T12:00:00Z';
const identifier = (relatedIdentifierName, relatedIdentifierValue) => ({ relatedIdentifierName, relatedIdentifierValue });
const tx = (id, status, date, related) => ({ transactionId: id, transactionType: 'Refund', transactionStatus: status,
  postedDate: date, totalAmount: { currencyAmount: '-100.00', currencyCode: 'BRL' },
  relatedIdentifiers: [identifier('ORDER_ID', orderId), ...related] });
const release = tx('release','RELEASED','2026-08-20T12:00:00Z',[identifier('DEFERRED_TRANSACTION_ID','original')]);
const original = tx('original','DEFERRED_RELEASED','2026-08-10T12:00:00Z',[identifier('RELEASE_TRANSACTION_ID','release')]);
const credit = { transactionId: 'safe-t-credit', transactionType: 'Adjustment', transactionStatus: 'RELEASED',
  postedDate: '2026-08-12T12:00:00Z', totalAmount: { currencyAmount: '80.00', currencyCode: 'BRL' },
  relatedIdentifiers: [identifier('ORDER_ID', orderId)],
  breakdowns: [{ breakdownType: 'Sales', breakdownAmount: { currencyAmount: '80.00', currencyCode: 'BRL' },
    breakdowns: [{ breakdownType: 'SAFETReimbursement', breakdownAmount: { currencyAmount: '80.00', currencyCode: 'BRL' } }] }] };
const page = (transactions, nextToken) => ({ transactions, rawBody: JSON.stringify({ payload: { transactions, nextToken } }), nextToken });
async function fixture(t) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(),'synth-refund-history-'));
  const repository = new Repository({ rootDir, dbPath: path.join(rootDir,'test.sqlite'), stores:[config] });
  t.after(async () => { repository.close(); assert.equal(path.dirname(rootDir), path.resolve(os.tmpdir())); await rm(rootDir,{recursive:true,force:true}); });
  const store = new SnapshotStore({ rootDir, storeId });
  const saved = await store.savePage({ source: 'transactions', body: page([release]).rawBody });
  await repository.importRun({ id:randomUUID(),storeId,startedAt:observedAt,finishedAt:observedAt,sources:[{
    source:'transactions',status:'api-pages-complete',dateBasis:'posted',requestedWindow:{from:'2026-08-01T00:00:00Z',to:'2026-09-01T00:00:00Z'},
    pages:[{...saved,hasNextPage:false,observedAt}]}] });
  repository.syncRefundManagement();
  return { repository, store, config, now:()=>new Date(observedAt), sleep:async()=>{} };
}

test('recovers original refund date by order without double counting, importing sales or declaring full history coverage', async t => {
  const f = await fixture(t);
  const read = () => f.repository.refundManagement({storeId,workflow:'all'}).items[0];
  const before = read(), coverage = f.repository.db.prepare('SELECT * FROM source_state').all();
  assert.equal(before.refund.firstEventAt, null);
  const result = await collectMissingRefundHistory({...f,client:{async *listTransactions(params){
    assert.equal(params.relatedIdentifierName,'ORDER_ID'); assert.equal(params.relatedIdentifierValue,orderId); assert.equal(params.postedAfter,undefined);
    yield page([], 'cursor');
    yield page([original,release,{...original,transactionId:'sale',transactionType:'Shipment'}]);
  }}});
  assert.equal(result.recoveredDates, 1);
  const after = read();
  assert.equal(after.refund.firstEventAt,'2026-08-10T12:00:00.000Z');
  assert.equal(after.refund.lastEventAt,after.refund.firstEventAt);
  assert.equal(after.refund.dateKnown,true);
  assert.equal(after.refund.count,1);
  assert.deepEqual(after.refund.byCurrency,before.refund.byCurrency);
  assert.equal(after.managementId,before.managementId);
  assert.equal(f.repository.db.prepare("SELECT count(*) AS n FROM entities WHERE source_id='sale'").get().n,0);
  assert.deepEqual(f.repository.db.prepare('SELECT * FROM source_state').all(),coverage);
  assert.equal((await f.repository.loadWorkspace()).errors.length,0);
  assert.equal(read().refund.count,1);
  assert.equal((await collectMissingRefundHistory({...f,client:{listTransactions(){throw new Error('already complete');}}})).selected,0);
});

test('missing original remains unknown; complete empty lookup is cached and never borrows release date', async t => {
  const f = await fixture(t);
  const client = {async *listTransactions(){yield page([release]);}};
  assert.equal((await collectMissingRefundHistory({...f,client})).recoveredDates,0);
  assert.equal(f.repository.refundManagement({storeId,workflow:'all'}).items[0].refund.firstEventAt,null);
  assert.equal((await collectMissingRefundHistory({...f,client})).selected,0);
});

test('wrong-order data and failed pagination never import partial history', async t => {
  const f = await fixture(t), before = f.repository.db.prepare('SELECT count(*) AS n FROM runs').get().n;
  for (const client of [
    {async *listTransactions(){yield page([{...original,relatedIdentifiers:[identifier('ORDER_ID','701-9999999-9999999')]}]);}},
    {async *listTransactions(){yield page([original],'cursor');throw new Error('network failed');}},
  ]) {
    assert.equal((await collectMissingRefundHistory({...f,client})).failed,1);
    assert.equal(f.repository.db.prepare('SELECT count(*) AS n FROM runs').get().n,before);
    assert.equal(f.repository.refundManagement({storeId,workflow:'all'}).items[0].refund.firstEventAt,null);
  }
  assert.throws(()=>validateRefundHistoryRun({importMode:'refund-history-by-order-v1',status:'api-pages-complete',sources:[]}),{code:'INVALID_ENRICHMENT_MANIFEST'});
});

test('refreshes legacy date-only imports and recovers an older SAFE-T payment once without changing notes or duplicating refunds', async t => {
  const f = await fixture(t);
  await collectMissingRefundHistory({ ...f, client: { async *listTransactions() { yield page([original, release]); } } });
  const db = f.repository.db;
  db.prepare('DELETE FROM refund_history_query_versions WHERE store_id=?').run(storeId);
  db.prepare("UPDATE refund_management SET short_note='Preservar anotação',safe_t_id='manual-claim' WHERE store_id=?").run(storeId);
  const history = db.prepare('SELECT count(*) AS n FROM runs').get().n;
  const coverage = db.prepare('SELECT * FROM source_state').all();
  const client = { async *listTransactions() { yield page([original, release, credit]); } };
  assert.equal((await collectMissingRefundHistory({ ...f, client })).checked, 1);
  const row = f.repository.refundManagement({ storeId, workflow: 'all' }).items[0];
  assert.equal(row.refund.count, 1);
  assert.equal(row.refund.firstEventAt, '2026-08-10T12:00:00.000Z');
  assert.deepEqual(row.payment.byCurrency, [{ currency: 'BRL', totalCents: '8000', knownTotalCents: '8000' }]);
  assert.equal(row.payment.credits[0].postedAt, '2026-08-12T12:00:00.000Z');
  assert.equal(row.payment.credits[0].type, 'safe_t');
  assert.equal(db.prepare('SELECT short_note FROM refund_management WHERE store_id=?').get(storeId).short_note, 'Preservar anotação');
  assert.equal(row.management.safeTId, 'manual-claim');
  assert.equal((await collectMissingRefundHistory({ ...f, client })).selected, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM runs').get().n, history + 1);
  assert.deepEqual(db.prepare('SELECT * FROM source_state').all(), coverage);
  assert.equal((await f.repository.loadWorkspace()).errors.length, 0);
  assert.equal(f.repository.refundManagement({ storeId, workflow: 'all' }).items[0].payment.credits.length, 1);
});

test('financial history rejects wrong-order or wrong-marketplace adjustments and excludes deferred credits', async t => {
  const f = await fixture(t);
  for (const invalid of [
    { ...credit, relatedIdentifiers: [identifier('ORDER_ID', '701-9999999-9999999')] },
    { ...credit, marketplaceDetails: { marketplaceId: 'OTHER' } },
  ]) {
    assert.equal((await collectMissingRefundHistory({ ...f, client: { async *listTransactions() { yield page([original, invalid]); } } })).failed, 1);
    assert.equal(f.repository.db.prepare("SELECT count(*) AS n FROM entities WHERE source_id='safe-t-credit'").get().n, 0);
  }
  const deferred = { ...credit, transactionStatus: 'DEFERRED' };
  await collectMissingRefundHistory({ ...f, client: { async *listTransactions() { yield page([original, deferred]); } } });
  assert.equal(f.repository.refundManagement({ storeId, workflow: 'all' }).items[0].payment.credits.length, 0);
});

test('legacy manifests keep their original refund-only contract; active orders refresh daily with bounded batches', async t => {
  assert.deepEqual(refundHistoryRecords([{ type: 'Refund' }, { type: 'Adjustment' }, { type: 'Shipment' }], 'refund-history-by-order-v1'), [{ type: 'Refund' }]);
  assert.deepEqual(refundHistoryRecords([{ type: 'Refund' }, { type: 'Adjustment' }, { type: 'Shipment' }], REFUND_HISTORY_IMPORT), [{ type: 'Refund' }, { type: 'Adjustment' }]);
  const f = await fixture(t), client = { async *listTransactions() { yield page([original, release]); } };
  await collectMissingRefundHistory({ ...f, client });
  assert.equal((await collectMissingRefundHistory({ ...f, client })).selected, 0);
  assert.equal((await collectMissingRefundHistory({ ...f, client, now: () => new Date('2026-09-28T12:00:01Z'), maxOrders: 1 })).checked, 1);
  f.repository.db.prepare("UPDATE refund_management SET workflow_state='finalized' WHERE store_id=?").run(storeId);
  assert.equal((await collectMissingRefundHistory({ ...f, client, now: () => new Date('2026-09-29T12:00:01Z') })).selected, 0);
});

test('targeted recovery keeps the requested order and store scope', async t => {
  const f = await fixture(t);
  const client = { async *listTransactions(params) { assert.equal(params.relatedIdentifierValue, orderId); yield page([original, credit]); } };
  assert.equal((await collectMissingRefundHistory({ ...f, client, orderIds: ['701-9999999-9999999'] })).selected, 0);
  assert.equal((await collectMissingRefundHistory({ ...f, client, orderIds: [orderId], maxOrders: 1 })).checked, 1);
  await assert.rejects(collectMissingRefundHistory({ ...f, client, orderIds: ['invalid'] }), { code: 'INVALID_ENRICHMENT_MANIFEST' });
});
