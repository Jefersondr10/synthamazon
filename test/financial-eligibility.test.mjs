import test from 'node:test';
import assert from 'node:assert/strict';
import { orderFinancialEligibility, transactionFinancialEligibility } from '../src/domain/financial-eligibility.mjs';

test('only explicit order payment authorization states are financially excluded', () => {
  for (const status of ['PENDING','Pending',' pending ','PENDING_AVAILABILITY']) assert.deepEqual(orderFinancialEligibility({ status }), { included:false,reason:'payment-pending' });
  for (const status of ['UNSHIPPED','SHIPPED','DEFERRED','PENDING_PICK_UP','CANCELLED',null,undefined]) {
    assert.equal(orderFinancialEligibility({ status, packages:[{status:'PENDING'}], displayStatus:{code:'PENDING'} }).included,true);
  }
});

test('all explicit-reference movements of a mixed pending event are excluded without guessing absent orders or cross-store links', () => {
  const orders = [{storeId:'a',orderId:'p',status:'PENDING'}, {storeId:'b',orderId:'p',status:'UNSHIPPED'}];
  const tx = (transactionId,extra={}) => ({storeId:'a',transactionId,orderIds:[],deferredTransactionIds:[],releaseTransactionIds:[],totalCents:'900719925474099313',...extra});
  const transactions = [tx('original',{orderIds:['p','unimported'],releaseTransactionIds:['release']}),tx('release',{deferredTransactionIds:['original']}),
    tx('second-release',{deferredTransactionIds:['original']}),tx('original',{storeId:'b',orderIds:['p'],releaseTransactionIds:['release']}),
    tx('release',{storeId:'b',deferredTransactionIds:['original']}),tx('orphan'),tx('unknown',{orderIds:['absent']})];
  const before=JSON.stringify({transactions,orders}), result=transactionFinancialEligibility(transactions,orders);
  assert.equal(result.excludedTransactionCount,3);assert.equal(result.mixedOrderTransactionCount,3);
  assert.deepEqual(result.excluded.map(row=>row.transactionId),['original','release','second-release']);
  assert.equal(result.included.length,4);
  assert.ok(result.included.some(row=>row.storeId==='b'&&row.transactionId==='release'));
  assert.equal(JSON.stringify({transactions,orders}),before);
});
