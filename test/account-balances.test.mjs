import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { collectAccountBalance, ensureAccountBalanceSchema, accountBalanceView } from '../src/domain/account-balances.mjs';
import { normalizeFinancialEventGroups } from '../src/domain/normalize.mjs';
import { Repository } from '../src/domain/repository.mjs';

const stamp = '2026-09-26T12:00:00.000Z', now = () => new Date(stamp);
const group = (id, amount, status = 'Open', currency = 'BRL') => ({ FinancialEventGroupId: id, ProcessingStatus: status, OriginalTotal: { CurrencyCode: currency, CurrencyAmount: amount } });
const page = groups => ({ rawBody: JSON.stringify({ payload: { FinancialEventGroupList: groups } }) });
const emptyDeferred = async function* () { yield { rawBody: JSON.stringify({ payload: { transactions: [] } }) }; };
const clientFor = groups => ({ async *listFinancialEventGroups() { yield page(groups); }, listTransactions: emptyDeferred });
function fixture(t) { const db = new DatabaseSync(':memory:'); ensureAccountBalanceSchema(db); t.after(() => db.close()); return db; }
async function collect(db, groups, storeId = 'store') { return collectAccountBalance({ db, config: { storeId }, client: clientFor(groups), now }); }

test('saldo usa só ciclos abertos, separa moedas e preserva centavos sem campos bancários', async t => {
  const db = fixture(t);
  await collect(db, [group('a', '10.15'), group('b', '-3.11'), group('closed', '999', 'Closed'), group('usd', '20', 'Open', 'USD')]);
  const result = accountBalanceView(db, ['store'], Date.parse(stamp));
  assert.equal(result.state, 'complete');
  assert.deepEqual(result.byCurrency, [{ currency:'BRL', totalCents:'704', openCents:'704', deferredCents:'0' }, { currency:'USD', totalCents:'2000', openCents:'2000', deferredCents:'0' }]);
  const raw = '{"payload":{"FinancialEventGroupList":[{"FinancialEventGroupId":"huge","ProcessingStatus":"Open","AccountTail":"PRIVATE","TraceId":"PRIVATE","OriginalTotal":{"CurrencyCode":"BRL","CurrencyAmount":9007199254740993.17}}]}}';
  const normalized = normalizeFinancialEventGroups(raw, { storeId:'store', observedAt:stamp });
  assert.equal(normalized[0].totalCents, '900719925474099317');
  assert.equal(JSON.stringify(normalized).includes('PRIVATE'), false);
});

test('consulta incompleta não publica saldo parcial nem perde o último saldo válido', async t => {
  const db = fixture(t);
  await collect(db, [group('a', '10')]);
  const broken = { async *listFinancialEventGroups() { yield page([group('b', '900')]); throw Object.assign(new Error('PRIVATE'), { code: 'PAGINATION_LIMIT' }); } };
  await assert.rejects(collectAccountBalance({ db, config:{storeId:'store'}, client:broken, now }), {code:'PAGINATION_LIMIT'});
  const result = accountBalanceView(db,['store'],Date.parse(stamp));
  assert.equal(result.state,'stale'); assert.equal(result.byCurrency[0].totalCents,'1000');
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM account_balances').all()).includes('PRIVATE'),false);
  await collect(db, [group('a','10','Closed')]);
  assert.deepEqual(accountBalanceView(db,['store'],Date.parse(stamp)).byCurrency, []);
});

test('duplicação idêntica entre páginas não duplica saldo; conflito rejeita a coleta', async t => {
  const db = fixture(t);
  const client = { listTransactions: emptyDeferred, async *listFinancialEventGroups() { yield page([group('a','10')]); yield page([group('a','10')]); } };
  await collectAccountBalance({db,config:{storeId:'store'},client,now});
  assert.equal(accountBalanceView(db,['store'],Date.parse(stamp)).byCurrency[0].totalCents,'1000');
  client.listFinancialEventGroups = async function*() { yield page([group('a','10')]); yield page([group('a','20')]); };
  await assert.rejects(collectAccountBalance({db,config:{storeId:'store'},client,now}), {code:'INVALID_RESPONSE'});
});

test('loja sem coleta, valor ausente e coleta antiga não aparentam saldo completo', async t => {
  const db = fixture(t);
  await collect(db,[group('a','10')]);
  assert.equal(accountBalanceView(db,['store','missing'],Date.parse(stamp)).state,'incomplete');
  assert.equal(accountBalanceView(db,['store'],Date.parse(stamp)+3*3600000).state,'stale');
  await collect(db,[group('a',null)]);
  assert.equal(accountBalanceView(db,['store'],Date.parse(stamp)).state,'incomplete');
  assert.deepEqual(accountBalanceView(db,['store'],Date.parse(stamp)).byCurrency,[]);
});

test('saldo do dashboard ignora o período e respeita a loja selecionada', async t => {
  const repository = new Repository({dbPath:':memory:',rootDir:'.',stores:[{storeId:'one'},{storeId:'two'}]});
  t.after(()=>repository.close());
  await collect(repository.db,[group('a','11')],'one');
  await collect(repository.db,[group('a','22')],'two');
  const first = repository.dashboard({storeId:'one',from:'2020-01-01',to:'2020-01-01'}).accountBalance;
  const second = repository.dashboard({storeId:'one',from:'2026-09-01',to:'2026-09-26'}).accountBalance;
  assert.deepEqual(first,second);
  assert.equal(first.byCurrency[0].totalCents,'1100');
  assert.equal(repository.dashboard({storeId:'all'}).accountBalance.byCurrency[0].totalCents,'3300');
});

test('saldo total soma ciclos abertos e snapshot DEFERRED, segmenta o ano e não repete transações entre páginas', async t => {
  const db = fixture(t), queries = [];
  const deferred = { transactionId:'deferred',transactionType:'Shipment',transactionStatus:'DEFERRED',postedDate:'2026-09-01T12:00:00Z',
    totalAmount:{currencyCode:'BRL',currencyAmount:'86400.38'} };
  const client = { ...clientFor([group('open','47607.66')]), async *listTransactions(query) {
    queries.push(query);
    yield {rawBody:JSON.stringify({payload:{transactions:[deferred]}})};
    yield {rawBody:JSON.stringify({payload:{transactions:[deferred]}})};
  }};
  await collectAccountBalance({db,config:{storeId:'store',historyStart:'2026-01-01T03:00:00Z'},client,now});
  assert.equal(queries.length,2);
  assert.ok(queries.every(q=>q.transactionStatus==='DEFERRED' && Date.parse(q.postedBefore)-Date.parse(q.postedAfter)<=180*86400000));
  assert.deepEqual(accountBalanceView(db,['store'],Date.parse(stamp)).byCurrency,[{currency:'BRL',totalCents:'13400804',openCents:'4760766',deferredCents:'8640038'}]);
  const before = db.prepare('SELECT groups_json,deferred_json,observed_at FROM account_balances').get();
  client.listTransactions = async function*() { yield {rawBody:JSON.stringify({payload:{transactions:[deferred]}})}; throw Object.assign(new Error(),{code:'TIMEOUT'}); };
  await assert.rejects(collectAccountBalance({db,config:{storeId:'store'},client,now}),{code:'TIMEOUT'});
  assert.deepEqual(db.prepare('SELECT groups_json,deferred_json,observed_at FROM account_balances').get(),before);
  assert.equal(accountBalanceView(db,['store'],Date.parse(stamp)).state,'stale');
});

test('snapshot legado sem transações adiadas não é apresentado como saldo total completo', async t => {
  const db = fixture(t);
  await collect(db,[group('a','10')]);
  db.prepare('UPDATE account_balances SET deferred_json=NULL').run();
  assert.equal(accountBalanceView(db,['store'],Date.parse(stamp)).state,'incomplete');
});

test('uma coleta antiga que termina depois não substitui o saldo da consulta mais recente', async t => {
  const db = fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const slow = { ...clientFor([]), async *listFinancialEventGroups() { await gate; yield page([group('old','10')]); } };
  let clockCalls = 0;
  const older = collectAccountBalance({db,config:{storeId:'store'},client:slow,now:()=>new Date(clockCalls++ ? '2026-09-26T12:02:00Z' : '2026-09-26T11:59:00Z')});
  await collect(db,[group('new','25')]);
  release(); await older;
  const result = accountBalanceView(db,['store'],Date.parse(stamp));
  assert.equal(result.byCurrency[0].totalCents,'2500');
  assert.equal(result.stores[0].observedAt,stamp);
});

test('uma falha atrasada não marca como desatualizado um saldo que já foi renovado', async t => {
  const db = fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const slow = {async *listFinancialEventGroups() { await gate; throw Object.assign(new Error('PRIVATE'),{code:'TIMEOUT'}); }};
  const older = collectAccountBalance({db,config:{storeId:'store'},client:slow,now:()=>new Date('2026-09-26T11:59:00Z')});
  await collect(db,[group('new','25')]);
  release(); await assert.rejects(older,{code:'TIMEOUT'});
  assert.equal(accountBalanceView(db,['store'],Date.parse(stamp)).state,'complete');
  assert.equal(db.prepare('SELECT attempted_at FROM account_balances').get().attempted_at,stamp);
});
