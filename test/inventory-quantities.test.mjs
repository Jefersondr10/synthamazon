import test from 'node:test';
import assert from 'node:assert/strict';
import { inventoryQuantities } from '../public/inventory-quantities.js';
import { createInventoryReport } from '../public/inventory-report.js';

const item = { totalQuantity:57,inventoryDetails:{fulfillableQuantity:20,inboundWorkingQuantity:3,inboundShippedQuantity:8,inboundReceivingQuantity:4,
  reservedQuantity:{totalReservedQuantity:20,pendingCustomerOrderQuantity:6,pendingTransshipmentQuantity:9,fcProcessingQuantity:5},
  unfulfillableQuantity:{totalUnfulfillableQuantity:2},researchingQuantity:{totalResearchingQuantity:1}} };

test('usable Amazon stock includes each inbound and internal movement once, excluding committed and unavailable positions',()=>{
  const values=inventoryQuantities(item);
  assert.equal(values.usableQuantity,49);assert.equal(values.available,20);assert.equal(values.incoming,15);assert.equal(values.internalMovement,14);
  assert.equal(values.amazonTotal,57);assert.equal(values.reservedForOrders,6);assert.equal(values.unfulfillable,2);assert.equal(values.researching,1);
  assert.equal(inventoryQuantities({...item,totalQuantity:58}).usableQuantity,49,'Researching may already be outside the source total; never deduct twice');
  assert.equal(item.totalQuantity,57);
});

test('missing or invalid components leave usable stock unknown instead of inventing zero or using a misleading source total',()=>{
  for(const value of [undefined,null,-1,1.5,Number.MAX_SAFE_INTEGER]){
    const stock={...item,inventoryDetails:{...item.inventoryDetails,inboundShippedQuantity:value}};
    assert.equal(inventoryQuantities(stock).usableQuantity,null);
  }
  assert.equal(inventoryQuantities({...item,inventoryDetails:{...item.inventoryDetails,reservedQuantity:{totalReservedQuantity:20}}}).usableQuantity,null);
  assert.equal(inventoryQuantities({inventoryDetails:{fulfillableQuantity:0,inboundWorkingQuantity:0,inboundShippedQuantity:0,inboundReceivingQuantity:0,reservedQuantity:{pendingTransshipmentQuantity:0,fcProcessingQuantity:0}}}).usableQuantity,0);
});

test('the report keeps raw Amazon total and usable stock separate without changing available-stock forecast',()=>{
  const record={...item,storeId:'a',sellerSku:'SKU',salesForecast:{30:{units:30,averageDailyUnits:1,daysRemaining:20,availableQuantity:20,reason:null}}};
  const report=createInventoryReport([record],{preferences:{period:30,leadDays:7,bufferDays:8},generatedAt:'2026-10-05T12:00:00Z'});
  const [header,values]=report.csv.slice(1).trim().split('\r\n').map(line=>line.split(';').map(cell=>cell.slice(1,-1)));
  const row=Object.fromEntries(header.map((name,index)=>[name,values[index]]));
  assert.equal(row['Total Amazon'],'57');assert.equal(row['Total Amazon apto'],'49');assert.equal(row['Disponível'],'20');assert.equal(row['Duração prevista (dias)'],'20');
});
