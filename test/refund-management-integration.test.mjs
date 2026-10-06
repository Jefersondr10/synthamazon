import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Repository } from '../src/domain/repository.mjs';
import { SnapshotStore } from '../src/storage.mjs';
import { saveCustomerReturnJob,importCustomerReturnReport } from '../src/domain/customer-returns.mjs';
import { refundManagementStatuses, statusDefinition } from '../src/domain/review-statuses.mjs';

const at = day => `2026-09-${String(day).padStart(2,'0')}T12:00:00.000Z`;
const tx = (transactionId,type,amount,extra={}) => ({transactionId,transactionType:type,transactionStatus:'RELEASED',postedDate:at(3),
  totalAmount:{currencyAmount:amount,currencyCode:'BRL'},relatedIdentifiers:[{relatedIdentifierName:'ORDER_ID',relatedIdentifierValue:'order-a'}],...extra});
const credit = (id,amount,extra={}) => tx(id,'Adjustment',amount,{breakdowns:[{breakdownType:'SAFETReimbursement',breakdownAmount:{currencyAmount:amount,currencyCode:'BRL'}}],...extra});
async function fixture(t) {
  const base = path.resolve(os.tmpdir()),rootDir=await mkdtemp(path.join(base,'synth-management-integration-'));
  const repo=new Repository({rootDir,dbPath:path.join(rootDir,'test.sqlite'),stores:[{storeId:'store-a',name:'A'},{storeId:'store-b',name:'B'}]});
  t.after(async()=>{repo.close();assert.equal(path.dirname(rootDir),base);await rm(rootDir,{recursive:true,force:true});});
  const importRows=async(storeId,rows,observedAt=at(10))=>{
    const store=new SnapshotStore({rootDir,storeId});
    const saved=await store.savePage({source:'transactions',body:JSON.stringify({payload:{transactions:rows}})});
    const manifest={id:randomUUID(),storeId,startedAt:observedAt,finishedAt:observedAt,status:'collected-awaiting-validation',sources:[{
      source:'transactions',status:'api-pages-complete',dateBasis:'posted',requestedWindow:{from:at(1),to:at(28)},
      pages:[{...saved,observedAt,hasNextPage:false}]}]};
    await repo.importRun(manifest); return manifest;
  };
  const role=name=>refundManagementStatuses(repo.db).find(item=>item.semanticRole===name).code;
  const row=storeId=>repo.refundManagement({storeId,workflow:'all'}).items[0];
  return{repo,importRows,role,row};
}

test('management uses the financial refund base only, isolates stores, exposes legacy notes and leaves legacy finance untouched',async t=>{
  const {repo,importRows,role,row}=await fixture(t);
  await importRows('store-a',[tx('refund','Refund','-100.00')]);
  await importRows('store-b',[tx('refund','Refund','-70.00')]);
  const legacy=repo.financialCases('refunds',{storeId:'store-a'}).items[0];
  repo.saveFinancialReview({storeId:'store-a',kind:'refunds',caseId:legacy.caseId,status:'in_review',notes:'Histórico preexistente.',expectedVersion:0});
  const reportType='GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE';
  saveCustomerReturnJob(repo.db,{storeId:'store-a',reportId:'report',reportType,status:'DONE',createdAt:at(10),checkedAt:at(10)});
  importCustomerReturnReport(repo.db,{storeId:'store-a',reportId:'report',reportType,observedAt:at(10),records:[
    {orderId:'order-a',rmaId:'rma-a',reportedRefundCents:'10000',currency:'BRL'},
    {orderId:'report-only',rmaId:'rma-report',reportedRefundCents:'3000',currency:'BRL'}]});
  assert.equal(repo.safeTCases({storeId:'store-a'}).total,2);
  const sourceBefore=JSON.stringify(repo.db.prepare('SELECT * FROM entities ORDER BY store_id,source,source_id').all());
  const legacyBefore=JSON.stringify(repo.db.prepare('SELECT * FROM financial_case_reviews').all());
  assert.deepEqual(repo.syncRefundManagement(),{created:2,updated:0,reopened:0,missing:0});
  assert.equal(repo.refundManagement({workflow:'all'}).total,2);
  let a=row('store-a'),b=row('store-b');
  assert.notEqual(a.managementId,b.managementId);assert.equal(a.management.status,'in_review');
  assert.equal(a.refund.byCurrency[0].totalCents,'10000');assert.equal(b.refund.byCurrency[0].totalCents,'7000');
  assert.equal(a.returnLinks.customerReturns.length,1);
  const detail=repo.refundManagementDetail('store-a',a.managementId);
  assert.equal(detail.legacyReviews[0].review.notes,'Histórico preexistente.');
  assert.equal(detail.legacyReviews[0].history.length,1);
  assert.equal(repo.refundManagementDetail('store-b',a.managementId),null);
  const edited=repo.saveRefundManagement({action:'edit',items:[{storeId:'store-a',managementId:a.managementId,expectedVersion:0}],
    status:role('concluded'),note:'Nova observação.',shortNote:'Conferir',caseId:'Caso 123-456',safeTId:'SAFE-T-local',returnTracking:'Código manual'});
  a=edited.items[0];assert.equal(a.management.workflowState,'active');assert.equal(a.management.caseId,'123456');
  assert.equal(a.notes[0].note,'Nova observação.');assert.equal(a.management.latestNote,'Nova observação.');
  assert.equal(repo.refundManagement({storeId:'store-a',returnFilter:'withReturn'}).total,1);
  assert.equal(repo.refundManagement({storeId:'store-a',returnFilter:'withoutReturn'}).total,0);
  assert.equal(JSON.stringify(repo.db.prepare('SELECT * FROM entities ORDER BY store_id,source,source_id').all()),sourceBefore);
  assert.equal(JSON.stringify(repo.db.prepare('SELECT * FROM financial_case_reviews').all()),legacyBefore);
  assert.equal(row('store-b').management.version,0);
});

test('explicit credits finalize locally, repeated imports do not reopen, and genuinely new credit reopens once with a new confirmation delta',async t=>{
  const {repo,importRows,role,row}=await fixture(t);
  const original=tx('refund-old','Refund','-100.00',{transactionStatus:'DEFERRED_RELEASED',relatedIdentifiers:[
    {relatedIdentifierName:'ORDER_ID',relatedIdentifierValue:'order-a'},{relatedIdentifierName:'RELEASE_TRANSACTION_ID',relatedIdentifierValue:'refund-release'}]});
  const release=tx('refund-release','Refund','-100.00',{postedDate:at(15),relatedIdentifiers:[
    {relatedIdentifierName:'ORDER_ID',relatedIdentifierValue:'order-a'},{relatedIdentifierName:'DEFERRED_TRANSACTION_ID',relatedIdentifierValue:'refund-old'}]});
  const initial=await importRows('store-a',[original,release,credit('safe-t','100.00')]);
  repo.getBootstrap();
  let a=row('store-a');
  assert.equal(a.refund.count,1);assert.equal(a.refund.firstEventAt,at(3));
  assert.equal(a.safeTDueAt,new Date(Date.parse(at(3))+50*86400000).toISOString());
  assert.equal(a.payment.confirmationRequired,true);
  const finalized=repo.saveRefundManagement({action:'finalize',items:[{storeId:'store-a',managementId:a.managementId,expectedVersion:a.management.version}],
    status:role('concluded'),acknowledgePaymentVariance:false,note:'Valor conferido no registro Amazon.'}).items[0];
  assert.equal(finalized.management.workflowState,'finalized');assert.equal(finalized.management.finalizationReason,'amazon_payment');
  assert.equal(finalized.payment.confirmedByCurrency[0].totalCents,'10000');assert.equal(finalized.payment.confirmationRequired,false);
  assert.equal((await repo.importRun(initial)).imported,false);
  repo.getBootstrap(); assert.equal(row('store-a').management.workflowState,'finalized');
  assert.equal(row('store-a').management.version,finalized.management.version);
  await importRows('store-a',[original,release,credit('safe-t','100.00'),credit('extra','5.00',{postedDate:at(20)})],at(21));
  const synced=repo.syncRefundManagement();assert.equal(synced.reopened,1);
  a=row('store-a');assert.equal(a.management.workflowState,'active');assert.equal(a.management.status,role('safe_t_granted'));
  assert.equal(a.payment.newByCurrency[0].totalCents,'500');assert.equal(a.payment.confirmedByCurrency[0].totalCents,'10000');
  assert.equal(repo.syncRefundManagement().reopened,0);
  const detail=repo.refundManagementDetail('store-a',a.managementId);
  assert.equal(detail.history.filter(item=>item.type==='automatic-reopen').length,1);
  assert.equal(detail.notes[0].note,'Valor conferido no registro Amazon.');
  assert.throws(()=>repo.saveRefundManagement({action:'edit',items:[{storeId:'store-a',managementId:a.managementId,expectedVersion:finalized.management.version}],note:'Stale'}),{code:'REVIEW_CONFLICT'});
});

test('undated release-only refunds never borrow a return or release date for the internal deadline',async t=>{
  const {repo,importRows,row}=await fixture(t);
  await importRows('store-a',[tx('release-only','Refund','-45.00',{postedDate:at(20),relatedIdentifiers:[
    {relatedIdentifierName:'ORDER_ID',relatedIdentifierValue:'order-a'},{relatedIdentifierName:'DEFERRED_TRANSACTION_ID',relatedIdentifierValue:'missing-original'}]})]);
  repo.syncRefundManagement();
  const a=row('store-a');assert.equal(a.refund.dateKnown,false);assert.equal(a.refund.firstEventAt,null);assert.equal(a.safeTDueAt,null);
  assert.equal(repo.refundManagement({storeId:'store-a',from:'2026-09-01',to:'2026-09-30'}).total,0);
  assert.equal(repo.refundManagement({storeId:'store-a',deadline:'overdue'}).total,0);
  assert.match(a.deadlinePolicy.label,/Não confirma prazo/);
});

test('unassigning a catalog status preserves existing labels, filters, note editing and history without permitting new assignment',async t=>{
  const {repo,importRows,row}=await fixture(t);
  await importRows('store-a',[tx('refund','Refund','-15.00')]);
  await importRows('store-b',[tx('refund','Refund','-15.00')]);
  repo.syncRefundManagement();
  let a=row('store-a');
  repo.saveRefundManagement({action:'edit',items:[{storeId:'store-a',managementId:a.managementId,expectedVersion:0}],status:'in_review'});
  const definition=statusDefinition(repo.db,'in_review');
  repo.saveReviewStatus({...definition,menus:definition.menus.filter(menu=>menu!=='refund-management'),expectedVersion:definition.version});
  a=repo.refundManagement({storeId:'store-a',status:'in_review'}).items[0];
  assert.equal(a.management.label,'Em análise');
  const saved=repo.saveRefundManagement({action:'edit',items:[{storeId:'store-a',managementId:a.managementId,expectedVersion:a.management.version}],status:'in_review',note:'Preservar revisão.'});
  assert.equal(saved.items[0].management.label,'Em análise');assert.equal(saved.items[0].notes[0].note,'Preservar revisão.');
  const b=row('store-b');
  assert.throws(()=>repo.saveRefundManagement({action:'edit',items:[{storeId:'store-b',managementId:b.managementId,expectedVersion:b.management.version}],status:'in_review'}),{code:'INVALID_MANAGEMENT'});
});


test('manual status edits do not resynchronize the store and still enforce row versions', async t => {
  const { repo, importRows, row, role } = await fixture(t);
  await importRows('store-a', [tx('refund-fast', 'Refund', '-100.00')]);
  repo.syncRefundManagement();
  const before = row('store-a');
  repo.syncRefundManagement = () => assert.fail('manual edits must not rescan the store');
  const input = { action: 'edit', items: [{ storeId: 'store-a', managementId: before.managementId, expectedVersion: before.management.version }], status: role('safe_t_investigation'), shortNote: 'Aguardando investigação' };
  const result = repo.saveRefundManagement(input);
  assert.equal(result.items[0].management.status, role('safe_t_investigation'));
  assert.equal(result.items[0].management.shortNote, 'Aguardando investigação');
  assert.deepEqual(result.items[0].refund, before.refund);
  assert.equal(repo.refundManagement({ storeId: 'store-a', status: role('safe_t_investigation') }).total, 1);
  assert.throws(() => repo.saveRefundManagement(input), { code: 'REVIEW_CONFLICT' });
});

test('bulk finalization preserves SAFE-T granted while confirming credits and recording workflow history', async t => {
  const { repo, importRows, row, role } = await fixture(t);
  for (const storeId of ['store-a', 'store-b']) {
    await importRows(storeId, [tx('refund', 'Refund', '-100.00'), credit('safe-credit', '100.00')]);
  }
  repo.syncRefundManagement();
  const before = [row('store-a'), row('store-b')];
  for (const item of before) assert.equal(item.management.status, role('safe_t_granted'));
  const result = repo.saveRefundManagement({ action: 'finalize',
    items: before.map(item => ({ storeId: item.storeId, managementId: item.managementId, expectedVersion: item.management.version })),
    status: role('safe_t_granted'), acknowledgePaymentVariance: false, note: 'Conferido sem trocar o status concedido.' });
  assert.equal(result.changed, 2);
  assert.equal(result.confirmedPayments, 2);
  for (const item of result.items) {
    assert.equal(item.management.status, role('safe_t_granted'));
    assert.equal(item.management.workflowState, 'finalized');
    assert.equal(item.payment.confirmationRequired, false);
    assert.deepEqual(item.payment.confirmedByCurrency, [{ currency: 'BRL', totalCents: '10000' }]);
    assert.equal(item.history.filter(entry => entry.type === 'finalize').length, 1);
    assert.equal(item.notes.at(-1).note, 'Conferido sem trocar o status concedido.');
    assert.deepEqual(item.refund, before.find(previous => previous.storeId === item.storeId).refund);
  }
  assert.equal(repo.refundManagement({ workflow: 'active' }).total, 0);
  assert.equal(repo.refundManagement({ workflow: 'finalized', status: role('safe_t_granted') }).total, 2);
});

test('100 confirmations use reviewed snapshots without rescanning stores, and a single stale item rolls back the entire batch', async t => {
  const {repo,importRows,role}=await fixture(t);
  const rows=Array.from({length:100},(_,i)=>[tx('refund-'+i,'Refund','-100.00'),credit('credit-'+i,'100.00')]
    .map(row=>({...row,relatedIdentifiers:[{relatedIdentifierName:'ORDER_ID',relatedIdentifierValue:'order-'+i}]}))).flat();
  await importRows('store-a',rows);repo.syncRefundManagement();
  const items=repo.refundManagement({workflow:'active',limit:100}).items;
  assert.equal(items.length,100);
  repo.syncRefundManagement=()=>assert.fail('finalizing a batch must not reproject the whole store');
  const input={action:'finalize',status:role('safe_t_granted'),acknowledgePaymentVariance:false,
    items:items.map(item=>({storeId:item.storeId,managementId:item.managementId,expectedVersion:item.management.version}))};
  const invalid=structuredClone(input);invalid.items[99].expectedVersion++;
  assert.throws(()=>repo.saveRefundManagement(invalid),{code:'REVIEW_CONFLICT'});
  assert.equal(repo.refundManagement({workflow:'active'}).total,100);
  assert.equal(repo.refundManagement({workflow:'finalized'}).total,0);
  const result=repo.saveRefundManagement(input);
  assert.equal(result.changed,100);assert.equal(result.confirmedPayments,100);
  assert.equal(repo.refundManagement({workflow:'active'}).total,0);
  assert.equal(repo.refundManagement({workflow:'finalized'}).total,100);
  assert.ok(result.items.every(item=>item.history.filter(entry=>entry.type==='finalize').length===1));
});
