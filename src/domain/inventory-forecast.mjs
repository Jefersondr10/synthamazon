import { DAY, dayStart, day, covers, orderHistoryWindows } from './sales-history.mjs';
const PERIODS = [30, 60, 90];
const confirmed = new Set(['SHIPPED', 'PARTIALLY_SHIPPED', 'UNSHIPPED']);
const excluded = new Set(['CANCELED', 'CANCELLED', 'PENDING', 'PENDING_AVAILABILITY', 'UNFULFILLABLE']);
const instant = value => typeof value === 'string' && value ? Date.parse(value) : NaN;
const key = (storeId, sku) => JSON.stringify([storeId, sku]);
const quantity = value => Number.isSafeInteger(value) && value >= 0;

// Demand is matched by exact SKU within a store. ASINs can represent multiple
// independent offers and must not pool their stock or sales.
export function inventoryForecast({ items, orders, coverage, now = new Date() }) {
  const current = Number(new Date(now));
  if (!Number.isFinite(current)) throw new TypeError('Invalid forecast date.');
  const today = dayStart(current), histories = new Map(), stocks = new Map(), demand = new Map();
  for (const item of items) {
    const id = key(item.storeId, item.sellerSku);
    stocks.set(id, (stocks.get(id) || 0) + 1);
    if (histories.has(item.storeId)) continue;
    const windows = orderHistoryWindows(coverage, item.storeId);
    const latest = windows.length ? Math.max(...windows.map(range => range[1])) : today;
    const end = Math.min(today, dayStart(latest));
    histories.set(item.storeId, Object.fromEntries(PERIODS.map(period => [period, {
      from: day(end - period * DAY), to: day(end - DAY), start: end - period * DAY, end,
      complete: covers(windows, end - period * DAY, end), lagDays: (today - end) / DAY,
    }])));
  }
  for (const order of orders) {
    if (order.fulfillmentMode !== 'FBA' || !histories.has(order.storeId)) continue;
    const status = String(order.status || '').toUpperCase();
    if (excluded.has(status)) continue;
    const created = instant(order.createdAt);
    for (const item of order.items || []) {
      if (!item.sku || !stocks.has(key(order.storeId, item.sku))) continue;
      const id = key(order.storeId, item.sku);
      const stats = demand.get(id) || Object.fromEntries(PERIODS.map(period => [period, { units: 0, incomplete: false }]));
      const periods = histories.get(order.storeId);
      for (const period of PERIODS) {
        const range = periods[period];
        if (Number.isFinite(created) && (created < range.start || created >= range.end)) continue;
        if (!Number.isFinite(created) || !confirmed.has(status) || !quantity(item.quantityOrdered)) stats[period].incomplete = true;
        else {
          stats[period].units += item.quantityOrdered;
          if (!quantity(stats[period].units)) stats[period].incomplete = true;
        }
      }
      demand.set(id, stats);
    }
  }
  return { generatedAt: new Date(current).toISOString(), periods: PERIODS, items: items.map(item => {
    const id = key(item.storeId, item.sellerSku), available = item.inventoryDetails?.fulfillableQuantity;
    const observed = instant(item.observedAt), stockFresh = Number.isFinite(observed) && observed <= current && current - observed <= 2 * DAY;
    return { ...item, salesForecast: Object.fromEntries(PERIODS.map(period => {
      const history = histories.get(item.storeId)[period], stats = demand.get(id)?.[period] || { units: 0, incomplete: false };
      const reason = !item.sellerSku ? 'missing-sku' : stocks.get(id) > 1 ? 'ambiguous-sku' : !history.complete ? 'incomplete-history'
        : history.lagDays > 7 ? 'stale-history' : stats.incomplete ? 'incomplete-sales' : !quantity(available) ? 'unknown-stock' : !stockFresh ? 'stale-stock' : null;
      const averageDailyUnits = stats.units / period;
      const daysRemaining = !reason && averageDailyUnits > 0 ? available / averageDailyUnits : null;
      const stockoutDay = daysRemaining !== null && daysRemaining <= 3650 ? day(today + Math.floor(daysRemaining) * DAY) : null;
      return [period, { periodDays: period, from: history.from, to: history.to, historyComplete: history.complete, historyLagDays: history.lagDays,
        units: stats.incomplete ? null : stats.units, averageDailyUnits: !reason ? averageDailyUnits : null,
        daysRemaining, stockoutDay, reason, availableQuantity: quantity(available) ? available : null, stockFresh }];
    })) };
  }) };
}
