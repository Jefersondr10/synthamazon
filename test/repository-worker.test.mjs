import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Repository} from '../src/domain/repository.mjs';
import {createRepositoryWorkers} from '../src/web/repository-worker.mjs';
import { EventEmitter } from 'node:events';

test('worker lanes keep the event loop and reads responsive during a blocked write, preserve errors and observe committed changes', async t => {
  const base=path.resolve(os.tmpdir()),rootDir=await mkdtemp(path.join(base,'synth-worker-'));
  const options={rootDir,stores:[{storeId:'a',name:'A'}]};
  const local=new Repository(options);
  const api=await createRepositoryWorkers(options);
  t.after(async()=>{await api.close();local.close();assert.equal(path.dirname(rootDir),base);await rm(rootDir,{recursive:true,force:true});});
  assert.equal(api.db,undefined); assert.equal(api.importRun,undefined);
  assert.deepEqual((await api.getBootstrap()).stores,local.listStores());
  const status=(await api.reviewStatusSettings()).items.find(item=>item.code==='in_review');
  const input={...status,label:'Conferência no teste',expectedVersion:status.version};
  local.db.exec('BEGIN IMMEDIATE');
  let saved=false;
  const write=api.saveReviewStatus(input).then(value=>{saved=true;return value;});
  // SQLite's busy wait occurs only in the write worker. A main-thread timer
  // can release the external lock and an unrelated read can finish meanwhile.
  try {
    await delay(100);
    const data=await api.productSales({storeId:'a'});
    assert.equal(data.views.length,6);assert.equal(saved,false);
  } finally {local.db.exec('ROLLBACK');}
  await write;
  assert.equal((await api.reviewStatusSettings()).items.find(item=>item.code===status.code).label,input.label);
  await assert.rejects(api.saveReviewStatus(input),{code:'STATUS_CONFLICT'});
  await assert.rejects(api.productSales({channels:'invalid'}),TypeError);
  await api.close();
  await assert.rejects(api.productSales({}),{code:'REPOSITORY_UNAVAILABLE'});
});

test('blocked reports cannot hold startup or stock; duplicate reads share work while edits remain distinct', async () => {
  const workers=[];
  const workerFactory=(_url,config)=>{
    const worker=new EventEmitter();worker.name=config.name;worker.calls=[];
    worker.postMessage=call=>worker.calls.push(call);
    worker.reply=call=>worker.emit('message',{id:call.id,value:{method:call.method,lane:worker.name}});
    worker.terminate=async()=>{worker.emit('exit',0);};
    workers.push(worker);queueMicrotask(()=>worker.emit('message',{ready:true}));return worker;
  };
  const api=await createRepositoryWorkers({},{workerFactory});
  const reports=workers.find(w=>w.name==='reports'),quick=workers.find(w=>w.name==='navigation'),stock=workers.find(w=>w.name==='inventory'),writes=workers.find(w=>w.name==='writes');
  let reportFinished=false;
  const report=api.dashboard({storeId:'all'}).then(value=>{reportFinished=true;return value;});
  const duplicate=api.dashboard({storeId:'all'});
  assert.equal(reports.calls.length,1);
  const startup=api.getBootstrap(),quantities=api.inventory({storeId:'all'}),prediction=api.inventory({storeId:'all',forecast:'true'});
  assert.equal(quick.calls.length,2);assert.equal(stock.calls.length,1);
  for(const call of quick.calls)quick.reply(call);
  assert.equal((await startup).lane,'navigation');assert.equal((await quantities).lane,'navigation');assert.equal(reportFinished,false);
  stock.reply(stock.calls[0]);assert.equal((await prediction).lane,'inventory');assert.equal(reportFinished,false);
  const edit1=api.saveLocalReview({storeId:'a'}),edit2=api.saveLocalReview({storeId:'a'});
  assert.equal(writes.calls.length,2);for(const call of writes.calls)writes.reply(call);await Promise.all([edit1,edit2]);
  reports.reply(reports.calls[0]);assert.deepEqual(await report,await duplicate);
  const fresh=api.dashboard({storeId:'all'});assert.equal(reports.calls.length,2);reports.reply(reports.calls[1]);await fresh;
  await api.close();
});

test('return history has a fixed, bounded lane and cannot block other reports or edits', async t => {
  const workers=[];
  const workerFactory=(_url,config)=>{
    const worker=new EventEmitter();worker.name=config.name;worker.calls=[];
    worker.postMessage=call=>worker.calls.push(call);
    worker.reply=call=>worker.emit('message',{id:call.id,value:{method:call.method,lane:worker.name}});
    worker.terminate=async()=>{worker.emit('exit',0);};
    workers.push(worker);queueMicrotask(()=>worker.emit('message',{ready:true}));return worker;
  };
  const api=await createRepositoryWorkers({},{workerFactory,maxPending:2});
  t.after(()=>api.close());
  assert.deepEqual(workers.map(worker=>worker.name),['reports','writes','alerts','navigation','inventory','returns']);
  const returns=workers.find(worker=>worker.name==='returns');
  const reports=workers.find(worker=>worker.name==='reports');
  const writes=workers.find(worker=>worker.name==='writes');
  let returnFinished=false;
  const history=api.returns({storeId:'all',offset:0}).then(value=>{returnFinished=true;return value;});
  const nextPage=api.returns({storeId:'all',offset:500});
  // Identical reads still share pending work, even when the lane is full.
  const duplicate=api.returns({storeId:'all',offset:0});
  assert.equal(returns.calls.length,2);
  await assert.rejects(api.returns({storeId:'all',offset:1000}),{code:'REPOSITORY_BUSY'});
  assert.equal(workers.length,6);

  const dashboard=api.dashboard({storeId:'all'});
  const orders=api.orders({storeId:'all'});
  const edit=api.saveReturnedManagement({storeId:'a',orderId:'example'});
  assert.equal(reports.calls.length,2);assert.equal(writes.calls.length,1);
  for (const call of reports.calls) reports.reply(call);
  writes.reply(writes.calls[0]);
  assert.equal((await dashboard).lane,'reports');
  assert.equal((await orders).lane,'reports');
  assert.equal((await edit).lane,'writes');
  assert.equal(returnFinished,false);

  returns.reply(returns.calls[0]);
  assert.deepEqual(await history,await duplicate);
  const freedSlot=api.returns({storeId:'all',offset:1000});
  assert.equal(returns.calls.length,3);
  returns.reply(returns.calls[1]);returns.reply(returns.calls[2]);
  await Promise.all([nextPage,freedSlot]);

  // Isolation works in both directions: an unrelated report does not hold
  // a return request after the previous return history has finished.
  let reportFinished=false;
  const blockedReport=api.productSales({storeId:'all'}).then(value=>{reportFinished=true;return value;});
  const freshHistory=api.returns({storeId:'all',offset:0});
  returns.reply(returns.calls[3]);
  assert.equal((await freshHistory).lane,'returns');
  assert.equal(reportFinished,false);
  reports.reply(reports.calls[2]);await blockedReport;
});
