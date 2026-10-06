import { DAY, day, dayStart, covers, orderHistoryWindows } from './sales-history.mjs';

const FBA_REPORT = 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA';
const SELLER_REPORT = 'GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE';
const confirmed = new Set(['SHIPPED', 'PARTIALLY_SHIPPED', 'UNSHIPPED']);
const excluded = new Set(['CANCELED', 'CANCELLED', 'PENDING', 'PENDING_AVAILABILITY', 'UNFULFILLABLE']);
const identity = (...parts) => JSON.stringify(parts);
const asinOf = value => /^[A-Z0-9]{10}$/.test(String(value || '').toUpperCase()) ? String(value).toUpperCase() : null;
const productKey = (store, item) => asinOf(item.asin) ? `asin:${asinOf(item.asin)}` : item.sku ? identity(store, item.sku) : null;
const dateKey = value => {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value ? value : null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? day(time) : null;
};
const stats = () => ({units:0, orders:new Set(), gross:0n, pricedUnits:0, unpricedUnits:0, returnOrders:new Set(), sellerOrders:new Set(), fbaOrders:new Set(), cohortOrders:new Set()});
const serialize = s => ({units:s.units, orders:s.orders.size, grossCents:s.pricedUnits ? String(s.gross) : null, unpricedUnits:s.unpricedUnits,
  returnOrders:s.returnOrders.size, sellerReturnOrders:s.sellerOrders.size, fbaReturnOrders:s.fbaOrders.size, cohortReturnOrders:s.cohortOrders.size,
  observedReturnRate:s.orders.size ? s.cohortOrders.size / s.orders.size * 100 : null});

export function panelRange({from, to, now = new Date()} = {}) {
  const current = Number(new Date(now)), today = day(dayStart(current));
  if (!from && !to) { to = day(dayStart(current) - DAY); from = day(dayStart(current) - 30 * DAY); }
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)
      || dateKey(from) !== from || dateKey(to) !== to || from > to || to > today) throw new TypeError('Invalid panel dates.');
  const start = Date.parse(`${from}T03:00:00Z`), end = Math.min(Date.parse(`${to}T03:00:00Z`) + DAY, current);
  const days = (Date.parse(`${to}T03:00:00Z`) - start) / DAY + 1;
  if (days > 366) throw new TypeError('Panel range exceeds one year.');
  return {from, to, today, start, end, days, ongoing:to === today, previousFrom:day(start - days * DAY), previousTo:day(start - DAY)};
}

/** One pass per source. Products are grouped by ASIN only inside the selected store scope. */
export function productPanel({orders, returns = [], returnJobs = [], coverage = [], storeIds, channels = ['FBA','DBA','MFN'], from, to, now = new Date()}) {
  if (!Array.isArray(channels) || !channels.length || new Set(channels).size !== channels.length || channels.some(c => !['FBA','DBA','MFN'].includes(c))) throw new TypeError('Invalid panel channels.');
  const range = panelRange({from,to,now}), scope = new Set(storeIds), chosen = new Set(channels);
  const total = stats(), channelStats = new Map(channels.map(c => [c, stats()])), products = new Map(), orderIndex = new Map(), daily = new Map(), reasons = new Map();
  let invalidSales = 0, invalidPrevious = 0, unmatchedReturns = 0, undatedReturns = 0, unknownChannelReturns = 0;
  const ensureProduct = (store, item) => {
    const key = productKey(store, item); if (!key) return null;
    if (!products.has(key)) products.set(key, {id:key, asin:asinOf(item.asin), title:item.title || item.productName || item.sku || item.asin,
      stores:new Set(), skus:new Set(), current:stats(), previousUnits:0, reasons:new Map()});
    const p = products.get(key); p.stores.add(store); if (item.sku) p.skus.add(item.sku); return p;
  };
  for (const order of orders) {
    if (!scope.has(order.storeId)) continue;
    const key = identity(order.storeId, order.orderId), date = dateKey(order.createdAt);
    orderIndex.set(key, order);
    if (!chosen.has(order.fulfillmentMode)) continue;
    const status = String(order.status || '').toUpperCase();
    if (excluded.has(status)) continue;
    if (!date) {invalidSales++;invalidPrevious++;continue;}
    if (date > range.to || date < range.previousFrom || Date.parse(order.createdAt) > Number(new Date(now))) continue;
    const current = date >= range.from;
    if (!confirmed.has(status) || !order.items?.length) { if(current) invalidSales++; else invalidPrevious++; continue; }
    for (const item of order.items) {
      if (!Number.isSafeInteger(item.quantityOrdered) || item.quantityOrdered < 0 || !productKey(order.storeId,item)) {if(current) invalidSales++;else invalidPrevious++;continue;}
      if (!item.quantityOrdered) continue;
      const p = ensureProduct(order.storeId,item);
      if (!current) {p.previousUnits += item.quantityOrdered;continue;}
      const price = item.unitPriceCurrency === 'BRL' && /^\d{1,30}$/.test(item.unitPriceCents ?? '') ? BigInt(item.unitPriceCents) : null;
      for (const target of [total,p.current,channelStats.get(order.fulfillmentMode)]) {
        target.units += item.quantityOrdered; target.orders.add(key);
        if (price === null) target.unpricedUnits += item.quantityOrdered;
        else {target.pricedUnits += item.quantityOrdered;target.gross += price * BigInt(item.quantityOrdered);}
      }
      const d = daily.get(date) || {date, units:0, returnOrders:new Set()}; d.units += item.quantityOrdered; daily.set(date,d);
    }
  }
  const seen = new Set();
  for (const record of returns) {
    if (!scope.has(record.storeId) || ![FBA_REPORT,SELLER_REPORT].includes(record.reportType)) continue;
    if (/cancel/i.test(record.returnStatus || '')) continue;
    const recordKey = record.returnId && identity(record.storeId,record.returnId); if(recordKey && seen.has(recordKey))continue; if(recordKey)seen.add(recordKey);
    const key = identity(record.storeId, record.orderId), order = orderIndex.get(key);
    const mode = record.reportType === FBA_REPORT ? 'FBA' : ['DBA','MFN'].includes(order?.fulfillmentMode) ? order.fulfillmentMode : 'unknown';
    const date = dateKey(record.reportType === FBA_REPORT ? record.returnReceivedAt : record.returnRequestedAt);
    if (!date) {undatedReturns++;continue;}
    const eventAt = record.reportType === FBA_REPORT ? record.returnReceivedAt : record.returnRequestedAt;
    if (date > range.today || String(eventAt).includes('T') && Date.parse(eventAt) > Number(new Date(now))) continue;
    const inPeriod = date >= range.from && date <= range.to;
    if (mode === 'unknown') {if(inPeriod)unknownChannelReturns++;if(chosen.size !== 3)continue;}
    else if (!chosen.has(mode)) continue;
    const matches = (order?.items || []).filter(item => record.sku ? item.sku === record.sku : asinOf(record.asin) && asinOf(item.asin) === asinOf(record.asin));
    const match = matches.length && new Set(matches.map(i => productKey(record.storeId,i))).size === 1 ? matches[0] : null;
    // Only a matching item can contribute to the sale cohort; a report's ASIN alone never links another item in the order.
    const saleProduct = match && products.get(productKey(record.storeId,match));
    const canLink = saleProduct?.current.orders.has(key) && date >= dateKey(order.createdAt) && (!asinOf(record.asin) || !asinOf(match.asin) || asinOf(record.asin) === asinOf(match.asin));
    if (canLink) {
      saleProduct.current.cohortOrders.add(key); total.cohortOrders.add(key); channelStats.get(order.fulfillmentMode)?.cohortOrders.add(key);
    }
    if (!inPeriod) continue;
    if (!record.orderId) {unmatchedReturns++;continue;}
    const p = ensureProduct(record.storeId, {...match, ...record, asin:record.asin || match?.asin, title:record.productName || match?.title});
    if (!p) unmatchedReturns++;
    for (const target of [total,p?.current,channelStats.get(mode)].filter(Boolean)) {
      target.returnOrders.add(key); target[mode === 'FBA' ? 'fbaOrders' : 'sellerOrders'].add(key);
    }
    const reason = record.reasonCode || 'NOT_PROVIDED';
    for (const target of [reasons,p?.reasons].filter(Boolean)) {if(!target.has(reason))target.set(reason,new Set());target.get(reason).add(key);}
    const d = daily.get(date) || {date, units:0, returnOrders:new Set()};d.returnOrders.add(key);daily.set(date,d);
  }
  const windows = new Map(storeIds.map(id => [id,orderHistoryWindows(coverage,id)]));
  const salesComplete = storeIds.length > 0 && !invalidSales && storeIds.every(id => covers(windows.get(id),range.start,range.end));
  const previousComplete = storeIds.length > 0 && !invalidPrevious && storeIds.every(id => covers(windows.get(id),Date.parse(`${range.previousFrom}T03:00:00Z`),range.start));
  const requiredTypes = [...(chosen.has('FBA') ? [FBA_REPORT] : []), ...(chosen.has('DBA') || chosen.has('MFN') ? [SELLER_REPORT] : [])];
  const returnsComplete = storeIds.length > 0 && storeIds.every(store => requiredTypes.every(type => {
    const jobs = returnJobs.filter(j => j.storeId === store && j.reportType === type && j.status === 'IMPORTED' && !j.warningCount);
    return covers(jobs.map(j => [Date.parse(j.from),Date.parse(j.to)]).filter(([a,b]) => Number.isFinite(a) && Number.isFinite(b)).sort((a,b) => a[0]-b[0]),range.start,range.end);
  }));
  const serializeReasons = map => [...map].map(([code,ids]) => ({code,orders:ids.size})).sort((a,b) => b.orders-a.orders || a.code.localeCompare(b.code));
  const items = [...products.values()].filter(p => p.current.units || p.current.returnOrders.size).map(p => ({id:p.id,asin:p.asin,title:p.title,
    storeIds:[...p.stores].sort(),skus:[...p.skus].sort(),...serialize(p.current),previousUnits:p.previousUnits,
    changePercent:salesComplete && previousComplete && !range.ongoing && p.previousUnits >= 5 ? (p.current.units-p.previousUnits)/p.previousUnits*100 : null,
    reasons:serializeReasons(p.reasons).slice(0,3)}));
  const stable = (a,b) => a.id.localeCompare(b.id), top = (predicate,compare) => items.filter(predicate).sort((a,b) => compare(a,b) || stable(a,b)).slice(0,20);
  const revenueSort = (a,b) => BigInt(a.grossCents) === BigInt(b.grossCents) ? 0 : BigInt(a.grossCents) > BigInt(b.grossCents) ? -1 : 1;
  return {generatedAt:new Date(now).toISOString(),range,storeIds,channels:[...chosen],summary:{...serialize(total),products:items.filter(i => i.units).length,
    averageDaily:salesComplete && !range.ongoing ? total.units / range.days : null},
    quality:{salesComplete,returnsComplete,previousComplete,invalidSales,unmatchedReturns,undatedReturns,unknownChannelReturns},
    rankings:{sales:top(i => i.units>0,(a,b) => b.units-a.units),revenue:top(i => i.grossCents!==null,revenueSort),
      returns:top(i => i.returnOrders>0,(a,b) => b.returnOrders-a.returnOrders),
      rate:top(i => i.orders>=10 && i.cohortReturnOrders>=2,(a,b) => b.observedReturnRate-a.observedReturnRate)},
    reasons:serializeReasons(reasons).slice(0,8),channelSummary:[...channelStats].map(([channel,s]) => ({channel,...serialize(s)})),
    daily:Array.from({length:range.days},(_,i) => {const date=day(range.start+i*DAY),d=daily.get(date);return {date,units:d?.units || 0,returnOrders:d?.returnOrders.size || 0};})};
}
