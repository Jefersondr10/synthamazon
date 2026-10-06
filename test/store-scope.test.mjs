import test from 'node:test';
import assert from 'node:assert/strict';
import { scopeRepository } from '../src/web/store-scope.mjs';
import { Repository } from '../src/domain/repository.mjs';

test('bootstrap restrito não enumera outra empresa', t => {
  const repository = new Repository({ dbPath: ':memory:', rootDir: process.cwd(), stores: [{ storeId:'origem-comercio' }, { storeId:'hd-comercio' }] });
  t.after(() => repository.close());
  const remote = scopeRepository(repository, 'origem-comercio');
  assert.deepEqual(remote.getBootstrap().stores.map(store => store.storeId), ['origem-comercio']);
  assert.equal(repository.getBootstrap().stores.length, 2);
});

test('escopo força todas as leituras e bloqueia detalhes e ações em lote de outra loja', () => {
  const calls = [];
  const names = ['dashboard','dashboardTransactions','orders','inventory','returns','customerReturns','safeTCases','refundManagement','syncRefundManagement','orderDetail','refundManagementDetail','financialCases','financialCaseDetail','localReview','saveLocalReview','saveFinancialReview','saveRefundManagement','saveReturnedManagement','saveFinancialReviews','getBootstrap','loadWorkspace'];
  const repository = Object.fromEntries(names.map(name => [name, (...args) => calls.push([name,...args])]));
  const remote = scopeRepository(repository, 'origem-comercio');
  for (const name of names.slice(0,9)) {
    remote[name]({ storeId:'all' });
    assert.equal(calls.at(-1)[1].storeId, 'origem-comercio');
    const count = calls.length;
    assert.throws(() => remote[name]({storeId:'hd-comercio'}), {code:'FORBIDDEN'});
    assert.equal(calls.length,count);
  }
  for (const name of ['orderDetail','refundManagementDetail']) assert.throws(() => remote[name]('hd-comercio','id'), {code:'FORBIDDEN'});
  assert.throws(() => remote.financialCaseDetail('refunds','hd-comercio','id'), {code:'FORBIDDEN'});
  for (const name of ['localReview','saveLocalReview','saveFinancialReview']) assert.throws(() => remote[name]({storeId:'hd-comercio'}), {code:'FORBIDDEN'});
  for (const name of ['saveRefundManagement','saveReturnedManagement','saveFinancialReviews']) {
    const count = calls.length;
    assert.throws(() => remote[name]({items:[{storeId:'origem-comercio'},{storeId:'hd-comercio'}]}), {code:'FORBIDDEN'});
    assert.equal(calls.length,count);
  }
  remote.loadWorkspace(); assert.deepEqual(calls.at(-1), ['loadWorkspace',{storeId:'origem-comercio'}]);
});
