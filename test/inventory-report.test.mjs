import test from 'node:test';
import assert from 'node:assert/strict';
import { createInventoryReport, csvCell } from '../public/inventory-report.js';
import { selectInventoryItems } from '../public/inventory-planning.js';
import { loadAllRecords } from '../public/list-data.js';

const preferences = { period:30, leadDays:7, bufferDays:8, alert:'all' };
const options = { preferences, storeId:'all', stores:[{storeId:'a',name:'Loja A'},{storeId:'b',name:'Loja B'}], collectionState:'partial', generatedAt:'2026-10-05T01:00:00Z' };
const item = (extra = {}) => ({storeId:'a',sellerSku:'SKU-A',asin:'B07GPRWFC5',fnSku:'FNSKU-A',title:'Teclado',totalQuantity:999,
  inventoryDetails:{fulfillableQuantity:10,reservedQuantity:{totalReservedQuantity:8,pendingTransshipmentQuantity:6,pendingCustomerOrderQuantity:1,fcProcessingQuantity:1},inboundWorkingQuantity:2,inboundShippedQuantity:3,inboundReceivingQuantity:4,unfulfillableQuantity:{totalUnfulfillableQuantity:0}},
  observedAt:'2026-10-04T12:00:00Z',salesForecast:{30:{units:20,averageDailyUnits:2/3,daysRemaining:15,reason:null,stockFresh:true,availableQuantity:10,historyComplete:true,historyLagDays:0,from:'2026-09-04',to:'2026-10-03'}},...extra});

test('inventory CSV preserves imported total, separates transfer and inbound units, and uses Brazilian dates/numbers', () => {
  const report=createInventoryReport([item()],options),lines=report.csv.slice(1).trim().split('\r\n');
  const headers=lines[0].split(';').map(cell=>cell.slice(1,-1)),values=lines[1].split(';').map(cell=>cell.slice(1,-1)),row=Object.fromEntries(headers.map((header,index)=>[header,values[index]]));
  assert.ok(report.csv.startsWith('\uFEFF'));assert.equal(headers.length,values.length);
  assert.equal(row['Loja'],'Loja A');assert.equal(row['Disponível'],'10');assert.equal(row['Em entrada'],'9');assert.equal(row['Transferência entre centros Amazon'],'6');assert.equal(row['Total Amazon'],'999');
  assert.equal(row['Média de vendas por dia'],'0,6667');assert.equal(row['Duração prevista (dias)'],'15');
  assert.equal(row['Estoque observado em (Brasília)'],'04/10/2026, 09:00');assert.match(row['Situação da coleta'],/Parcial/);
  assert.equal(report.filename,'estoque-fba-todas-as-lojas-2026-10-04.csv');
});
test('missing quantities and forecasts remain empty, distinct from known zero', () => {
  const report=createInventoryReport([item({inventoryDetails:{fulfillableQuantity:0},salesForecast:undefined,totalQuantity:undefined})],options);
  const [header,line]=report.csv.slice(1).trim().split('\r\n'),headers=header.split(';'),values=line.split(';');
  const get=name=>values[headers.indexOf(`"${name}"`)];
  assert.equal(get('Disponível'),'"0"');assert.equal(get('Em entrada'),'""');assert.equal(get('Total Amazon'),'""');assert.equal(get('Duração prevista (dias)'),'""');assert.equal(get('Situação do estoque'),'"Dados pendentes"');
});
test('CSV quotes separators, newlines and quotes, and prevents formula execution from product text', () => {
  assert.equal(csvCell('Cabo; "USB"\nAzul'),'"Cabo; ""USB""\nAzul"');
  for(const value of ['=1+1',' +SUM(A1)','\t@SUM(A1)','\r-HYPERLINK("x")']) assert.ok(csvCell(value).startsWith('"\''));
  assert.equal(csvCell(null),'""');assert.equal(csvCell(0),'"0"');assert.equal(csvCell(1.25),'"1,25"');
});
test('shared inventory selection respects store, search, stock, alert and sort before exporting every page', async () => {
  const records=Array.from({length:505},(_,i)=>item({sellerSku:`SKU-${String(i).padStart(3,'0')}`}));
  const data=await loadAllRecords(async url=>{const p=new URL(url,'http://local').searchParams,o=Number(p.get('offset'));return {items:records.slice(o,o+500),total:records.length,hasMore:o+500<records.length};},'/api/inventory',{storeId:'a'});
  const selected=selectInventoryItems(data.items,{storeId:'a'},preferences);
  assert.equal(createInventoryReport(selected,options).count,505);
  assert.equal(selectInventoryItems([...records,item({storeId:'b'})],{storeId:'b',query:'TeClAdO',stock:'available'},preferences).length,1);
  assert.equal(selectInventoryItems(records,{stock:'zero'},preferences).length,0);
  assert.equal(selectInventoryItems(records,{}, {...preferences,alert:'no_sales'}).length,0);
  const other=item({sellerSku:'OTHER',salesForecast:{30:{...records[0].salesForecast[30],daysRemaining:3}}});
  assert.equal(selectInventoryItems([records[0],other],{durationSort:'asc'},preferences)[0].sellerSku,'OTHER');
});
