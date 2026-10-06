import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedCollectionTimes } from '../public/store-selection.js';

const stores = [{storeId:'hd-comercio'},{storeId:'origem-comercio'},{storeId:'multivendas-prime'}];
const hd = '2026-10-05T14:55:19Z', origem = '2026-10-06T02:07:00Z';
const coverage = [
  {storeId:'hd-comercio',status:'api-pages-complete',source:'fba-inventory',observedAt:hd},
  {storeId:'origem-comercio',status:'api-pages-complete',source:'fba-inventory',observedAt:origem},
  {storeId:'hd-comercio',status:'partial',source:'orders',observedAt:'2026-10-06T03:00:00Z'},
];
test('HD never borrows the more recent timestamp from Origem or from an incomplete collection',()=>{
  assert.deepEqual(selectedCollectionTimes(coverage,'hd-comercio',stores),{from:hd,to:hd,count:1,missing:0});
  assert.equal(selectedCollectionTimes(coverage,'origem-comercio',stores).to,origem);
});
test('multiple stores display the span of each store latest complete collection',()=>{
  assert.deepEqual(selectedCollectionTimes(coverage,'hd-comercio,origem-comercio',stores),{from:hd,to:origem,count:2,missing:0});
  assert.deepEqual(selectedCollectionTimes(coverage,'all',stores),{from:hd,to:origem,count:3,missing:1});
});
test('unknown timestamps and uncollected stores cannot appear fresh',()=>{
  const rows=[...coverage,{storeId:'multivendas-prime',status:'api-pages-complete',observedAt:'invalid'}];
  assert.deepEqual(selectedCollectionTimes(rows,'multivendas-prime',stores),{from:null,to:null,count:1,missing:1});
});
