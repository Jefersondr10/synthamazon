import { createHash } from 'node:crypto';
import { DAY, dayStart, day, covers, orderHistoryWindows } from './sales-history.mjs';

const confirmed = new Set(['SHIPPED','PARTIALLY_SHIPPED','UNSHIPPED']);
const excluded = new Set(['CANCELED','CANCELLED','PENDING','PENDING_AVAILABILITY','UNFULFILLABLE']);
const channels = new Set(['FBA','DBA','MFN']);
const key = (store, sku, channel) => JSON.stringify([store,sku,channel]);
export const salesAlertId = (store,sku,channel) => createHash('sha256').update(key(store,sku,channel)).digest('hex');

// Only complete São Paulo days participate. Comparisons have a disjoint
// 28-day baseline and must persist over two adjacent daily evaluations.
export function salesAlertSignals({ orders, inventory = [], coverage, storeIds, now = new Date() }) {
  const current = Number(new Date(now));
  if (!Number.isFinite(current)) throw new TypeError('Invalid analysis date.');
  const today = dayStart(current), scope = new Set(storeIds), catalog = new Map(), invalid = new Set();
  const stores = storeIds.map(storeId => {
    const windows = orderHistoryWindows(coverage,storeId);
    return {storeId,ready:covers(windows,today-45*DAY,today),asOf:day(today-DAY)};
  });
  for (const order of orders) {
    if (!scope.has(order.storeId) || !channels.has(order.fulfillmentMode) || excluded.has(String(order.status).toUpperCase())) continue;
    const at = Date.parse(order.createdAt);
    if (Number.isFinite(at) && (at < today-60*DAY || at >= today)) continue;
    if (!Number.isFinite(at) || !confirmed.has(String(order.status).toUpperCase()) || !order.items?.length) { invalid.add(order.storeId); continue; }
    for (const item of order.items) {
      if (typeof item.sku !== 'string' || !item.sku || !Number.isSafeInteger(item.quantityOrdered) || item.quantityOrdered < 0) {invalid.add(order.storeId);continue;}
      if (!item.quantityOrdered) continue;
      const id = key(order.storeId,item.sku,order.fulfillmentMode);
      let product = catalog.get(id);
      if (!product) {product={id:salesAlertId(order.storeId,item.sku,order.fulfillmentMode),storeId:order.storeId,sku:item.sku,channel:order.fulfillmentMode,title:item.title||item.sku,asin:item.asin||null,daily:new Map()};catalog.set(id,product);}
      const date = dayStart(at);
      product.daily.set(date,(product.daily.get(date)||0)+item.quantityOrdered);
    }
  }
  stores.forEach(store=>{if(invalid.has(store.storeId))store.ready=false;});
  const ready = new Set(stores.filter(s=>s.ready).map(s=>s.storeId)), stocks = new Map();
  for (const item of inventory) {
    const id = key(item.storeId,item.sellerSku,'FBA'), observed = Date.parse(item.observedAt), quantity = item.inventoryDetails?.fulfillableQuantity;
    const known = Number.isSafeInteger(quantity) && quantity>=0 && observed<=current && current-observed<=2*DAY;
    // Multiple stock records for a SKU are ambiguous, not additive evidence.
    stocks.set(id,stocks.has(id)?null:known?quantity:null);
  }
  function evaluate(product,end) {
    const sum = (from,to) => [...product.daily].filter(([at])=>at>=from&&at<to).reduce((n,[,units])=>n+units,0);
    const initial = sum(end-35*DAY,end-7*DAY)/28;
    const periodDays = initial < 1 ? 14 : 7;
    const start=end-periodDays*DAY, baselineStart=start-28*DAY, baselineUnits=sum(baselineStart,start),units=sum(start,end);
    const activeDays=[...product.daily].filter(([at,n])=>at>=baselineStart&&at<start&&n>0).length;
    const baselineDaily=baselineUnits/28,averageDaily=units/periodDays;
    const changePercent=baselineDaily>0?(averageDaily/baselineDaily-1)*100:null;
    const salesDates=[...product.daily.keys()].filter(at=>at<end),lastSale=salesDates.length?Math.max(...salesDates):null;
    const daysWithoutSales=lastSale===null?60:(end-lastSale)/DAY-1;
    const stopAfterDays=Math.max(3,Math.min(14,Math.ceil(2.5*28/Math.max(1,activeDays))));
    const lostWeekly=(baselineDaily-averageDaily)*7;
    let type=null;
    if(baselineUnits>=12&&activeDays>=4&&daysWithoutSales>=stopAfterDays&&baselineDaily*daysWithoutSales>=3)type='stopped';
    else if(baselineUnits>=12&&activeDays>=4&&changePercent<=-40&&lostWeekly>=3)type='drop';
    else if(baselineUnits>=6&&activeDays>=3&&units>=10&&changePercent>=50&&(averageDaily-baselineDaily)*7>=5
      && [...product.daily].filter(([at,n])=>at>=start&&at<end&&n>baselineDaily*1.25).length>=3)type='surge';
    return {type,periodDays,from:day(start),to:day(end-DAY),baselineFrom:day(baselineStart),baselineTo:day(start-DAY),baselineUnits,baselineDaily,units,averageDaily,changePercent,daysWithoutSales,stopAfterDays,
      impactWeekly:Math.abs(lostWeekly),daily:Array.from({length:28+periodDays},(_,i)=>({date:day(baselineStart+i*DAY),units:product.daily.get(baselineStart+i*DAY)||0}))};
  }
  const products=[];
  for (const product of catalog.values()) {
    if (!ready.has(product.storeId)) continue;
    const comparisons=[0,1,2].map(offset=>evaluate(product,today-offset*DAY));
    const metric=comparisons[0],stock=stocks.get(key(product.storeId,product.sku,product.channel))??null;
    const stockSuppressed=product.channel==='FBA'&&stock===0&&['drop','stopped'].includes(metric.type);
    const stable=metric.type&&metric.type===comparisons[1].type&&!stockSuppressed;
    const {daily,...identity}=product;
    products.push({...identity,...metric,type:stable?metric.type:null,rawType:metric.type,stock,
      resolved:stockSuppressed||comparisons.every(c=>!c.type),resolution:stockSuppressed?'stockout':'recovered'});
  }
  return {generatedAt:new Date(current).toISOString(),asOf:day(today-DAY),stores,products};
}
