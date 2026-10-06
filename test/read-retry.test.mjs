import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchReadWithRetry } from '../public/list-data.js';

test('transient read failures retry briefly and stop once the request succeeds',async()=>{
  let calls=0,cancelled=0;const delays=[];
  const response=await fetchReadWithRetry('/api/bootstrap',{}, {fetchImpl:async()=>{
    calls++;if(calls===1)throw new TypeError('Network failed');
    return {status:calls===2?502:200,body:{cancel:async()=>cancelled++}};
  },pause:async ms=>delays.push(ms)});
  assert.equal(response.status,200);assert.equal(calls,3);assert.equal(cancelled,1);assert.deepEqual(delays,[400,1200]);
});

test('read retries are bounded and never replay writes, auth failures, validation errors or cancelled requests',async()=>{
  for(const status of [401,403,400,409,500]){
    let calls=0;
    assert.equal((await fetchReadWithRetry('/api/bootstrap',{}, {fetchImpl:async()=>{calls++;return {status};}})).status,status);
    assert.equal(calls,1);
  }
  for(const method of ['POST','PUT','PATCH','DELETE']){
    let calls=0;
    const result=await fetchReadWithRetry('/api/refund-management',{method}, {fetchImpl:async()=>{calls++;return {status:503};}});
    assert.equal(result.status,503);assert.equal(calls,1);
  }
  let calls=0;
  const response=await fetchReadWithRetry('/api/bootstrap',{}, {fetchImpl:async()=>{calls++;return {status:504};},pause:async()=>{}});
  assert.equal(response.status,504);assert.equal(calls,3);
  calls=0;
  await assert.rejects(fetchReadWithRetry('/api/bootstrap',{}, {fetchImpl:async()=>{calls++;throw Object.assign(new Error('Cancelled'),{name:'AbortError'});}}),{name:'AbortError'});
  assert.equal(calls,1);
});
