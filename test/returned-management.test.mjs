import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Repository } from '../src/domain/repository.mjs';
import { returnsView } from '../src/domain/returns.mjs';
import { getLocalReview } from '../src/domain/local-reviews.mjs';

function fixture(t) {
  const repo = new Repository({ rootDir: path.resolve('test'), dbPath: ':memory:', stores: [{ storeId: 'store-a', name: 'A' }, { storeId: 'store-b', name: 'B' }] });
  t.after(() => repo.close());
  const at = '2026-09-28T12:00:00Z';
  const insert = (source, id, payload, storeId = 'store-a') => repo.db.prepare('INSERT INTO entities VALUES(?,?,?,?,?,?,?,?,?)').run(storeId,source,id,at,at,'hash','SHIPPED',1,JSON.stringify({ storeId, ...payload }));
  for (const storeId of ['store-a','store-b']) for (const orderId of ['order-a','order-b']) insert('orders',orderId,{ orderId,status:'SHIPPED',fulfillmentMode:'DBA',createdAt:at,observedAt:at,
    packages:[{ packageReferenceId:'package-a',trackingNumber:'TRACK-A',status:'UNDELIVERABLE',detailedStatus:'RETURNED_TO_SELLER' }] },storeId);
  const item = (orderId = 'order-a', expectedVersion = 0, storeId = 'store-a') => ({ storeId, orderId, expectedVersion });
  const view = filters => returnsView({ db: repo.db, filters: { storeId:'store-a',...filters } });
  return { repo, item, view, insert, at };
}

test('edit, finalize and reopen keep distinct queues, isolate stores and preserve notes and case IDs', t => {
  const { repo, item, view } = fixture(t);
  repo.saveReturnedManagement({ action:'edit',items:[item()],status:'in_review',notes:'Anotação inicial',caseId:'123456' });
  assert.equal(view({ workflow:'active' }).total,2);
  repo.saveReturnedManagement({ action:'finalize',items:[item('order-a',1),item('order-b')],status:'resolved',note:'Conferido' });
  assert.equal(view({ workflow:'active' }).total,0);
  const done = view({ workflow:'finalized',limit:1 });
  assert.equal(done.total,2); assert.deepEqual(done.summary.workflowCounts,{active:0,finalized:2,all:2});
  assert.equal(done.items[0].review.notes,'Anotação inicial\n\nConferido');
  assert.equal(done.items[0].review.caseId,'123456');
  assert.equal(view({storeId:'store-b',workflow:'active'}).total,2);
  repo.saveReturnedManagement({ action:'reopen',items:[item('order-a',2)] });
  const reopened=view({workflow:'active'}).items[0];
  assert.equal(reopened.orderId,'order-a'); assert.equal(reopened.review.finalizedAt,null);
  assert.equal(reopened.review.caseId,'123456'); assert.equal(reopened.review.notes,'Anotação inicial\n\nConferido');
  assert.equal(view({workflow:'all'}).total,2);
});

test('bulk conflicts, missing entities, invalid status and audit failures never partially save', t => {
  const { repo, item, view } = fixture(t);
  const input={action:'finalize',items:[item(),item('order-b')],status:'resolved'};
  repo.saveLocalReview({menu:'returns',storeId:'store-a',entityId:'order-b',status:'in_review',notes:'Outra sessão',expectedVersion:0});
  assert.throws(()=>repo.saveReturnedManagement(input),{code:'REVIEW_CONFLICT'});
  assert.equal(view().items.find(row=>row.orderId==='order-a').review.version,0);
  assert.throws(()=>repo.saveReturnedManagement({...input,items:[item(),item('missing')]}),{code:'CASE_NOT_FOUND'});
  assert.throws(()=>repo.saveReturnedManagement({...input,items:[item()],status:'not_registered'}),{code:'INVALID_STATUS'});
  repo.db.exec("CREATE TRIGGER fail_returned_history BEFORE INSERT ON returned_management_history BEGIN SELECT RAISE(ABORT,'test failure'); END;");
  assert.throws(()=>repo.saveReturnedManagement({...input,items:[item(),item('order-b',1)]}));
  assert.equal(view({workflow:'finalized'}).total,0);
  assert.equal(getLocalReview(repo.db,{menu:'returns',storeId:'store-a',entityId:'order-a'}).version,0);
});

test('credits use released SAFE-T or Easy Ship evidence, deduplicate releases and never cross stores or pending orders', t => {
  const { repo, insert, view, at } = fixture(t);
  const credit = { type:'Adjustment',status:'RELEASED',postedAt:at,totalCents:'10000',currency:'BRL',orderIds:['order-a'],breakdowns:[{kind:'SAFETReimbursement',amountCents:'10000',currency:'BRL'}] };
  insert('transactions','refund',{transactionId:'refund',type:'Refund',status:'RELEASED',postedAt:at,totalCents:'-10000',currency:'BRL',orderIds:['order-a']});
  insert('transactions','credit',{transactionId:'credit',...credit,deferredTransactionIds:['deferred']});
  insert('transactions','deferred',{transactionId:'deferred',...credit,status:'DEFERRED',releaseTransactionIds:['credit']});
  insert('transactions','foreign',{transactionId:'foreign',...credit,totalCents:'99999'},'store-b');
  const row=view().items.find(row=>row.orderId==='order-a');
  assert.equal(row.refund.status,'recorded'); assert.equal(row.reimbursement.identified,true);
  assert.equal(row.reimbursement.byCurrency[0].totalCents,'10000'); assert.equal(row.reimbursement.credits.length,1);
  assert.equal(row.reimbursement.types[0].code,'safe_t');
  assert.equal(view().items.find(row=>row.orderId==='order-b').reimbursement.identified,false);
  repo.db.exec("UPDATE entities SET payload_json=json_set(payload_json,'$.status','PENDING') WHERE store_id='store-a' AND source='orders' AND source_id='order-a'");
  const pending=view().items.find(row=>row.orderId==='order-a');
  assert.equal(pending.financialEligibility.included,false);
  assert.equal(pending.reimbursement.identified,false);
  assert.equal(view().summary.withReimbursement,0);
});

test('selection validation blocks duplicates, arbitrary data, cross-item case IDs and invalid finalization', t => {
  const {repo,item} = fixture(t);
  for(const input of [
    {action:'edit',items:[item(),item()],note:'Duplicated'},
    {action:'edit',items:[item(),item('order-b')],caseId:'123'},
    {action:'edit',items:[item()],caseId:'not-numeric'},
    {action:'edit',items:[item()],amount:100},
    {action:'edit',items:[item()],notes:'x'.repeat(2001)},
  ]) assert.throws(()=>repo.saveReturnedManagement(input),{code:'INVALID_REVIEW'});
  assert.throws(()=>repo.saveReturnedManagement({action:'finalize',items:[item()]}),{code:'FINALIZATION_STATUS_REQUIRED'});
  assert.throws(()=>repo.saveReturnedManagement({action:'reopen',items:[item()]}),{code:'WORKFLOW_CONFLICT'});
});

test('automatic SAFE-T assignment uses released evidence and preserves finalization, notes, case ID and subsequent decisions', t => {
  const {repo,insert,view,item,at} = fixture(t);
  repo.saveReturnedManagement({action:'edit',items:[item()],status:'in_review',notes:'Conferir produto',caseId:'12345'});
  repo.saveReturnedManagement({action:'finalize',items:[item('order-a',1)],status:'resolved'});
  const finalizedAt = view().items.find(row=>row.orderId==='order-a').review.finalizedAt;
  const credit = (id,orderId,status='RELEASED',kind='SAFETReimbursement') => insert('transactions',id,{transactionId:id,type:'Adjustment',status,postedAt:at,totalCents:'10000',currency:'BRL',orderIds:[orderId],breakdowns:[{kind,amountCents:'10000',currency:'BRL'}]});
  credit('safe','order-a'); credit('deferred','order-b','DEFERRED'); credit('easy','order-b','RELEASED','EasyShipReimbursement');
  repo.syncRefundManagement({storeId:'store-a',now:at});
  const granted = view().items.find(row=>row.orderId==='order-a').review;
  assert.equal(granted.label,'SAFE-T CONCEDIDO'); assert.equal(granted.workflowState,'finalized');
  assert.equal(granted.finalizedAt,finalizedAt); assert.equal(granted.notes,'Conferir produto'); assert.equal(granted.caseId,'12345');
  assert.equal(view({reviewStatus:granted.status}).total,1);
  assert.equal(view().items.find(row=>row.orderId==='order-b').review.status,'pending');
  assert.equal(view({storeId:'store-b'}).items.find(row=>row.orderId==='order-a').review.version,0);
  const audit = repo.db.prepare('SELECT * FROM returned_management_history WHERE action=?').all('automatic-safe-t-granted');
  assert.equal(audit.length,1);
  repo.syncRefundManagement({storeId:'store-a',now:at});
  assert.equal(view().items.find(row=>row.orderId==='order-a').review.version,granted.version);
  repo.saveReturnedManagement({action:'edit',items:[item('order-a',granted.version)],status:'in_review'});
  repo.syncRefundManagement({storeId:'store-a',now:at});
  assert.equal(view().items.find(row=>row.orderId==='order-a').review.status,'in_review');
});

test('summary cards filter before pagination, retain queue counts and respect store, status and workflow', t => {
  const {repo, insert, view, item, at} = fixture(t);
  insert('transactions','refund-b',{transactionId:'refund-b',type:'Refund',status:'RELEASED',postedAt:at,totalCents:'-10000',currency:'BRL',orderIds:['order-b']});
  insert('transactions','credit-b',{transactionId:'credit-b',type:'Adjustment',status:'RELEASED',postedAt:at,totalCents:'10000',currency:'BRL',orderIds:['order-b'],breakdowns:[{kind:'SAFETReimbursement',amountCents:'10000',currency:'BRL'}]});
  for (const card of ['refunded','reimbursed']) {
    const result = view({card,limit:1});
    assert.deepEqual(result.items.map(row=>row.orderId),['order-b']);
    assert.equal(result.total,1); assert.equal(result.summary.total,2);
    assert.equal(result.summary.withRefund,1); assert.equal(result.summary.withReimbursement,1);
    assert.equal(view({card,offset:1,limit:1}).items.length,0);
    assert.equal(view({card,storeId:'store-b'}).total,0);
    assert.equal(view({card,status:'without_refund'}).total,0);
    assert.equal(view({card,query:'order-a'}).total,0);
  }
  assert.equal(view({card:'already_returned'}).total,2);
  repo.saveReturnedManagement({action:'finalize',items:[item('order-b')],status:'resolved'});
  assert.equal(view({card:'reimbursed',workflow:'active'}).total,0);
  assert.equal(view({card:'reimbursed',workflow:'finalized'}).total,1);
  repo.db.exec("UPDATE entities SET payload_json=json_set(payload_json,'$.status','PENDING') WHERE store_id='store-a' AND source='orders' AND source_id='order-b'");
  assert.equal(view({card:'refunded'}).total,0); assert.equal(view({card:'reimbursed'}).total,0);
  assert.throws(()=>view({card:'invalid'}),TypeError);
});


test('editing a returned order checks only its own tracking evidence, without reading unrelated finance', t => {
  const { repo, item, insert } = fixture(t);
  insert('orders', 'unrelated', { orderId: 'unrelated' });
  insert('transactions', 'unrelated-finance', { transactionId: 'unrelated-finance' });
  repo.db.exec("UPDATE entities SET payload_json='invalid unrelated payload' WHERE source_id IN ('unrelated','unrelated-finance')");
  assert.doesNotThrow(() => repo.saveReturnedManagement({ action: 'edit', items: [item()], status: 'rm_safe_t_investigation' }));
  assert.equal(getLocalReview(repo.db, { menu: 'returns', storeId: 'store-a', entityId: 'order-a' }).status, 'rm_safe_t_investigation');
  assert.throws(() => repo.saveReturnedManagement({ action: 'edit', items: [item('missing')], status: 'in_review' }), { code: 'CASE_NOT_FOUND' });
  assert.throws(() => repo.saveReturnedManagement({ action: 'edit', items: [item()], status: 'in_review' }), { code: 'REVIEW_CONFLICT' });
});
