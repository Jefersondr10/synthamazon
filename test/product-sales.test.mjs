import test from 'node:test';
import assert from 'node:assert/strict';
import { productSales } from '../src/domain/product-sales.mjs';
import { sortProductSalesItems, renderProductSales, createProductSalesState } from '../public/product-sales.js';
const now='2026-10-01T12:00:00Z';
const coverage=(storeId='a',extra={})=>({storeId,source:'orders',dateBasis:'created',status:'api-pages-complete',from:'2026-01-01T03:00:00Z',to:'2026-10-01T03:00:00Z',...extra});
const item=(sku='SKU-A',quantityOrdered=1)=>({sku,quantityOrdered,title:'Produto '+sku,asin:'B07GPRWFC5'});
const order=(orderId='o1',extra={})=>({orderId,storeId:'a',fulfillmentMode:'DBA',status:'SHIPPED',createdAt:'2026-09-28T12:00:00Z',items:[item()],...extra});
const run=(extra={})=>productSales({orders:[order()],coverage:[coverage()],storeIds:['a'],now,...extra});
const view=(data,key='30')=>data.views.find(v=>v.key===key);

test('yesterday distinguishes missing imports from a complete day without sales and updates after the catch-up',()=>{
  const helpers={storeName:id=>id==='a'?'MultiVendas Prime':id,inventoryAsinLink:id=>id};
  const state={...createProductSalesState(),period:'yesterday'};
  const stale=run({coverage:[coverage('a',{to:'2026-09-29T17:00:00Z'})]});
  assert.equal(view(stale,'yesterday').from,'2026-09-30');
  assert.deepEqual(view(stale,'yesterday').missingStoreIds,['a']);
  const html=renderProductSales(stale,state,helpers);
  assert.match(html,/A importação de MultiVendas Prime ainda não cobre este período/);
  assert.match(html,/isso não significa que não houve vendas/);
  const complete=run({orders:[]});
  assert.deepEqual(view(complete,'yesterday').missingStoreIds,[]);
  assert.doesNotMatch(renderProductSales(complete,state,helpers),/Aguardando as vendas/);
  const caughtUp=run({orders:[order('yesterday',{createdAt:'2026-09-30T15:00:00Z',items:[item('A',7)]})]});
  assert.equal(view(caughtUp,'yesterday').summary.units,7);assert.equal(view(caughtUp,'yesterday').summary.averageDaily,7);
});

test('combined merchant sales count units and unique orders, exclude FBA and pending/cancelled, and reconcile daily totals',()=>{
  const orders=[order('one',{items:[item('A',2),item('B',3),item('A',1)]}),order('two',{fulfillmentMode:'MFN',items:[item('A',4)]}),
    order('fba',{fulfillmentMode:'FBA',items:[item('A',500)]}),order('cancel',{status:'CANCELED'}),order('pending',{status:'PENDING'})];
  const data=view(run({orders}));
  assert.equal(data.summary.units,10);assert.equal(data.summary.orders,2);assert.equal(data.summary.products,2);
  assert.deepEqual(data.summary.channels,{FBA:0,DBA:6,MFN:4});assert.equal(data.summary.averageDaily,10/30);
  assert.equal(data.daily.reduce((sum,d)=>sum+d.units,0),10);
  assert.equal(data.items[0].sku,'A');assert.equal(data.items[0].units,7);assert.equal(data.items[0].orders,2);
  assert.equal(data.items[1].orders,1);
});

test('each channel combination updates rankings, days, orders and comparisons without mixing excluded channels',()=>{
  const orders=['FBA','DBA','MFN'].flatMap((channel,index)=>[
    order(channel,{fulfillmentMode:channel,items:[item('shared',index+1),item(channel,2)]}),
    order(channel+'-before',{fulfillmentMode:channel,createdAt:'2026-08-20T12:00:00Z',items:[item('shared',index+3)]}),
  ]);
  orders.push(order('unknown',{fulfillmentMode:'UNKNOWN',items:[item('shared',999)]}),order('fba-pending',{fulfillmentMode:'FBA',status:'PENDING'}));
  for(const channels of [['FBA'],['DBA'],['MFN'],['FBA','DBA'],['FBA','MFN'],['DBA','MFN'],['FBA','DBA','MFN']]) {
    const result=run({orders,channels}),data=view(result),expected=channels.reduce((sum,c)=>sum+['FBA','DBA','MFN'].indexOf(c)+3,0);
    assert.deepEqual(result.channels,channels);
    assert.equal(data.summary.units,expected);assert.equal(data.summary.orders,channels.length);
    assert.equal(data.summary.products,channels.length+1);assert.equal(data.summary.averageDaily,expected/30);
    assert.equal(data.daily.reduce((sum,day)=>sum+day.units,0),expected);
    assert.equal(data.summary.changePercent,0);
    assert.equal(data.items.find(i=>i.sku==='shared').orders,channels.length);
    for(const channel of ['FBA','DBA','MFN'])assert.equal(data.summary.channels[channel],channels.includes(channel)?['FBA','DBA','MFN'].indexOf(channel)+3:0);
  }
  assert.equal(view(run({orders:[...orders,order('bad-fba',{fulfillmentMode:'FBA',items:[]})],channels:['DBA']})).complete,true);
  assert.equal(view(run({orders:[...orders,order('bad-fba',{fulfillmentMode:'FBA',items:[]})],channels:['FBA']})).complete,false);
  for(const channels of [[],['UNKNOWN'],['FBA','FBA'],'FBA'])assert.throws(()=>run({channels}),/Invalid sales channels/);
});

test('store and SKU identities stay separate even with identical order IDs or ASINs',()=>{
  const orders=[order('same',{items:[item('same-sku',2)]}),order('same',{storeId:'b',items:[item('same-sku',9)]})];
  assert.equal(view(run({orders})).summary.units,2);
  const all=view(run({orders,coverage:[coverage(),coverage('b')],storeIds:['a','b']}));
  assert.equal(all.items.length,2);assert.equal(all.summary.orders,2);assert.equal(all.items[0].storeId,'b');
});

test('rolling windows use São Paulo day boundaries and exclude the current partial day',()=>{
  const orders=[order('start',{createdAt:'2026-09-24T03:00:00Z',items:[item('A',2)]}),
    order('before',{createdAt:'2026-09-24T02:59:59Z',items:[item('A',4)]}),
    order('end',{createdAt:'2026-10-01T02:59:59Z',items:[item('A',3)]}),
    order('today',{createdAt:'2026-10-01T03:00:00Z',items:[item('A',50)]})];
  const data=run({orders});assert.equal(view(data,'7').summary.units,5);assert.equal(view(data).summary.units,9);
  assert.equal(view(data,'7').from,'2026-09-24');assert.equal(view(data,'7').to,'2026-09-30');
});

test('last calendar month is separate from rolling 30 days, including leap years and year boundaries',()=>{
  const data=run({now:'2028-03-01T12:00:00Z',coverage:[coverage('a',{to:'2028-03-01T03:00:00Z'})],orders:[]});
  assert.equal(view(data,'previousMonth').from,'2028-02-01');assert.equal(view(data,'previousMonth').to,'2028-02-29');assert.equal(view(data,'previousMonth').days,29);
  assert.equal(view(data,'month').days,1);assert.equal(view(data,'month').summary.averageDaily,null);
  const january=run({now:'2027-01-05T12:00:00Z',coverage:[coverage('a',{to:'2027-01-05T03:00:00Z'})],orders:[]});
  assert.equal(view(january,'previousMonth').from,'2026-12-01');assert.equal(view(january,'previousMonth').to,'2026-12-31');
});

test('current month includes imported sales on its first day despite an older shared history cutoff',()=>{
  const orders=[order('last-month',{createdAt:'2026-10-01T02:59:59Z',items:[item('A',20)]}),
    order('month-start',{createdAt:'2026-10-01T03:00:00Z',items:[{...item('A',3),unitPriceCents:'1050',unitPriceCurrency:'BRL'}]}),
    order('today',{createdAt:'2026-10-01T11:59:59Z',items:[item('B',2)]}),
    order('future',{createdAt:'2026-10-01T12:01:00Z',items:[item('A',50)]})];
  const data=run({orders,coverage:[coverage('a',{to:'2026-09-29T03:00:00Z'})]}),month=view(data,'month');
  assert.equal(data.asOf,'2026-09-28');
  assert.equal(month.from,'2026-10-01');assert.equal(month.to,'2026-10-01');assert.equal(month.days,1);
  assert.equal(month.summary.units,5);assert.equal(month.summary.orders,2);assert.equal(month.summary.products,2);
  assert.equal(month.summary.grossCents,'3150');assert.equal(month.summary.grossComplete,false);
  assert.equal(month.ongoing,true);assert.equal(month.complete,false);
  assert.equal(month.summary.averageDaily,null);assert.equal(month.summary.changePercent,null);
  assert.deepEqual(month.daily,[{date:'2026-10-01',units:5}]);
  assert.equal(month.items.filter(i=>i.units>0).length,2);
  assert.equal(view(data,'today').summary.units,month.summary.units);
  const html=renderProductSales(data,{...createProductSalesState(),period:'month'},{storeName:id=>id,inventoryAsinLink:asin=>asin});
  assert.match(html,/Mês em andamento/);assert.match(html,/01\/10\/2026/);
  assert.doesNotMatch(html,/Aguardando dias completos|primeiro dia completo deste mês/);
});

test('current month keeps calendar boundaries through today, including Brasília midnight and a new year',()=>{
  const orders=[order('month-start',{createdAt:'2027-01-01T03:00:00Z',items:[item('A',3)]}),
    order('middle',{createdAt:'2027-01-14T20:00:00Z',items:[item('A',4)]}),
    order('today',{createdAt:'2027-01-15T04:00:00Z',items:[item('A',5)]})];
  const month=view(run({now:'2027-01-15T12:00:00Z',orders}),'month');
  assert.equal(month.from,'2027-01-01');assert.equal(month.to,'2027-01-15');assert.equal(month.days,15);
  assert.equal(month.summary.units,12);assert.equal(month.daily.length,15);
  assert.equal(month.daily.reduce((sum,d)=>sum+d.units,0),12);
  assert.equal(month.previous.from,'2026-12-01');assert.equal(month.previous.to,'2026-12-15');
  const before=view(run({now:'2027-01-01T02:59:59Z',orders}),'month');
  assert.equal(before.from,'2026-12-01');assert.equal(before.to,'2026-12-31');assert.equal(before.days,31);
  assert.equal(before.previous.to,'2026-11-30');assert.equal(before.summary.units,0);
  const after=view(run({now:'2027-01-01T03:00:01Z',orders}),'month');
  assert.equal(after.from,'2027-01-01');assert.equal(after.to,'2027-01-01');assert.equal(after.days,1);
  assert.equal(after.summary.units,3);
});

test('today and yesterday follow the Brasília calendar even with delayed imports; today stays explicitly ongoing',()=>{
  const orders=[order('before',{createdAt:'2026-09-30T02:59:59Z',items:[item('A',20)]}),
    order('yesterday',{createdAt:'2026-10-01T02:59:59Z',items:[item('A',3)]}),
    order('today',{createdAt:'2026-10-01T03:00:00Z',items:[item('A',5)]}),
    order('later',{createdAt:'2026-10-01T12:01:00Z',items:[item('A',50)]})];
  const data=run({orders,coverage:[coverage('a',{to:now})]});
  assert.equal(data.today,'2026-10-01');assert.equal(view(data,'today').from,'2026-10-01');assert.equal(view(data,'today').to,'2026-10-01');
  assert.equal(view(data,'today').summary.units,5);assert.equal(view(data,'today').days,1);assert.equal(view(data,'today').ongoing,true);
  assert.equal(view(data,'today').summary.averageDaily,null);assert.equal(view(data,'today').summary.changePercent,null);
  assert.deepEqual(view(data,'today').daily,[{date:'2026-10-01',units:5}]);
  assert.equal(view(data,'yesterday').summary.units,3);assert.equal(view(data,'yesterday').complete,true);assert.equal(view(data,'yesterday').summary.averageDaily,3);
  const stale=run({orders,coverage:[coverage('a',{to:'2026-09-29T03:00:00Z'})]});
  assert.equal(view(stale,'yesterday').from,'2026-09-30');assert.equal(view(stale,'yesterday').summary.units,3);assert.equal(view(stale,'yesterday').complete,false);
});

test('custom period includes both dates, compares an equally long preceding period and leaves the four existing windows unchanged',()=>{
  const orders=[order('first',{createdAt:'2026-09-10T03:00:00Z',items:[item('A',2)]}),
    order('last',{createdAt:'2026-09-13T02:59:59Z',items:[item('A',4)]}),
    order('past-end',{createdAt:'2026-09-13T03:00:00Z',items:[item('A',20)]}),
    order('previous',{createdAt:'2026-09-10T02:59:59Z',items:[item('A',3)]})];
  const data=run({orders,from:'2026-09-10',to:'2026-09-12'}),custom=view(data,'custom');
  assert.equal(custom.days,3);assert.equal(custom.summary.units,6);assert.equal(custom.summary.averageDaily,2);assert.equal(custom.summary.changePercent,100);
  assert.equal(custom.previous.from,'2026-09-07');assert.equal(custom.previous.to,'2026-09-09');
  assert.equal(custom.daily.reduce((sum,d)=>sum+d.units,0),6);
  assert.deepEqual(data.views.slice(0,4),run({orders}).views.slice(0,4));
  const ongoing=view(run({from:'2026-09-30',to:'2026-10-01'}),'custom');
  assert.equal(ongoing.days,2);assert.equal(ongoing.ongoing,true);assert.equal(ongoing.summary.averageDaily,null);
  for(const range of [{from:'2026-09-10'}, {to:'2026-09-10'}, {from:'2026-09-12',to:'2026-09-10'},
    {from:'2026-02-30',to:'2026-03-01'}, {from:'2026-09-10T00:00:00Z',to:'2026-09-12'},
    {from:'2026-10-01',to:'2026-10-02'}, {from:'2000-01-01',to:'2026-10-01'}]) assert.throws(()=>run(range),/Invalid sales date/);
});

test('complete shared cutoff is used for all stores and missing or updated-only coverage never supplies reliable averages',()=>{
  const all=run({storeIds:['a','b'],coverage:[coverage(),coverage('b',{to:'2026-09-29T16:00:00Z'})]});
  assert.equal(all.asOf,'2026-09-28');assert.equal(view(all).complete,true);
  for(const c of [[],[coverage('a',{dateBasis:'updated'})],[coverage('a',{status:'partial'})],
    [coverage('a',{to:'2026-09-15T03:00:00Z'}),coverage('a',{from:'2026-09-16T03:00:00Z'})]]) {
    const result=view(run({coverage:c}));assert.equal(result.complete,false);assert.equal(result.summary.averageDaily,null);
  }
  assert.equal(view(run({storeIds:['a','missing']})).complete,false);
});

test('bad quantities, dates, statuses and missing SKU are visible as incomplete data without counting invented units',()=>{
  for(const invalid of [order('bad',{items:[item('A',null)]}),order('bad',{createdAt:null}),order('bad',{status:null}),order('bad',{items:[item(null,4)]}),order('bad',{items:[]})]){
    const result=view(run({orders:[order('good',{items:[item('A',2)]}),invalid]}));
    assert.equal(result.summary.units,2);assert.equal(result.invalidRecords,1);assert.equal(result.complete,false);assert.equal(result.summary.averageDaily,null);
  }
});

test('comparison uses previous units and never invents an infinite percentage from a zero baseline',()=>{
  const orders=[order('now',{items:[item('A',20)]}),order('before',{createdAt:'2026-08-20T12:00:00Z',items:[item('A',10)]})];
  const result=view(run({orders}));assert.equal(result.summary.changePercent,100);assert.equal(result.items[0].changePercent,100);
  assert.equal(view(run()).summary.changePercent,null);
  assert.equal(view(run({orders:[]})).summary.averageDaily,0);
});

test('gross product revenue uses exact unit prices and quantities for selected channels and dates, never order totals or fees',()=>{
  const priced=(sku,quantityOrdered,cents)=>({...item(sku,quantityOrdered),unitPriceCents:cents,unitPriceCurrency:'BRL',proceedsCents:'999999'});
  const orders=[order('a',{grandTotalCents:'777777',items:[priced('A',3,'1001'),priced('B',2,'2000')]}),
    order('b',{fulfillmentMode:'FBA',items:[priced('A',2,'2002')]}),
    order('cancel',{status:'CANCELED',items:[priced('A',100,'99999')]}),
    order('old',{createdAt:'2026-08-20T12:00:00Z',items:[priced('A',99,'99999')]})];
  const data=view(run({orders,channels:['DBA','FBA']}));
  assert.equal(data.summary.grossCents,'11007');assert.equal(data.summary.grossComplete,true);
  assert.equal(data.items.find(i=>i.sku==='A').grossCents,'7007');
  assert.equal(view(run({orders,channels:['DBA']})).summary.grossCents,'7003');
  const large=view(run({orders:[order('large',{items:[priced('A',3,'900719925474099301')]})]}));
  assert.equal(large.summary.grossCents,'2702159776422297903');
});

test('missing prices stay unknown, foreign currencies are not added to BRL, and partial revenue does not invalidate unit averages',()=>{
  const items=[{...item('A',2),unitPriceCents:'1050',unitPriceCurrency:'BRL'},item('A',3),
    {...item('USD',4),unitPriceCents:'5000',unitPriceCurrency:'USD'},
    {...item('Zero',1),unitPriceCents:'0',unitPriceCurrency:'BRL'},
    {...item('Invalid',1),unitPriceCents:'-100',unitPriceCurrency:'BRL'}];
  const data=run({orders:[order('a',{items})]}),result=view(data);
  assert.equal(result.summary.grossCents,'2100');assert.equal(result.summary.unpricedUnits,8);
  assert.equal(result.summary.grossComplete,false);assert.equal(result.summary.averageDaily,11/30);
  assert.equal(result.items.find(i=>i.sku==='USD').grossCents,null);
  assert.equal(result.items.find(i=>i.sku==='Zero').grossCents,'0');
  const sorted=sortProductSalesItems(result.items,'revenue');
  assert.deepEqual(sorted.map(i=>i.sku),['A','Zero','USD','Invalid']);
  const large=sortProductSalesItems([{sku:'B',units:1,grossCents:'900719925474099300'},{sku:'A',units:1,grossCents:'900719925474099301'}],'revenue');
  assert.equal(large[0].sku,'A');
  const html=renderProductSales(data,{...createProductSalesState(),sort:'revenue'},{storeName:id=>id,inventoryAsinLink:asin=>asin});
  assert.match(html,/Maior faturamento/);assert.match(html,/Valor parcial/);assert.match(html,/Valor não informado/);assert.match(html,/R\$ 21,00/);
});
