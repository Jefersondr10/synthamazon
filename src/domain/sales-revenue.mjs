import { orderFinancialEligibility } from './financial-eligibility.mjs';
import { categoryFromNodes, platformExpenses } from './platform-expenses.mjs';

const money = value => typeof value === 'string' && /^-?\d{1,2048}$/.test(value) ? BigInt(value) : null;
const validCurrency = value => typeof value === 'string' && /^[A-Z]{3}$/.test(value);
const key = (storeId, orderId) => JSON.stringify([storeId, orderId]);
const saleFees = new Set(['MFNPostageFee', 'MFNShippingChargeback', 'ShippingChargeback', 'ShippingHB',
  'Commission', 'FBAPerUnitFulfillmentFee', 'AmazonForAllFee', 'VariableClosingFee', 'FixedClosingFee']);

function merchandise(order) {
  const explicit = categoryFromNodes(order, new Set(['ITEM']));
  if (explicit) return [...explicit].every(([currency, value]) => validCurrency(currency) && !value.unknown) ? explicit : null;
  if (!order.items?.length) return null;
  const amounts = new Map();
  for (const item of order.items) {
    const unit = money(item.unitPriceCents), currency = item.unitPriceCurrency;
    if (unit === null || !validCurrency(currency) || !Number.isSafeInteger(item.quantityOrdered) || item.quantityOrdered < 0) return null;
    const total = (amounts.get(currency)?.total || 0n) + unit * BigInt(item.quantityOrdered);
    amounts.set(currency, { total, unknown: false });
  }
  return amounts;
}

/** The same sales cohort drives gross and net; transactions arrive already deduplicated. */
export function salesRevenue(orders, transactions) {
  const sales = orders.filter(order => orderFinancialEligibility(order).included
    && !['CANCELLED', 'CANCELED'].includes(String(order.status).toUpperCase()));
  const keys = new Set(sales.map(order => key(order.storeId, order.orderId)));
  const gross = new Map(), net = new Map(), netOrders = new Set(), incomplete = new Set();
  const contributions = [];
  let knownGrossOrders = 0, unclassifiedFeeCount = 0, deferredSaleCount = 0;
  for (const order of sales) {
    const amounts = merchandise(order);
    if (!amounts) continue;
    knownGrossOrders++;
    for (const [currency, amount] of amounts) gross.set(currency, (gross.get(currency) || 0n) + amount.total);
  }
  const scoped = transactions.map(transaction => ({ transaction,
    orders: [...new Set((transaction.orderIds || []).map(id => key(transaction.storeId, id)))] }))
    .filter(row => row.orders.length && row.orders.every(id => keys.has(id)));
  for (const { transaction, orders: ids } of scoped) {
    if (transaction.type !== 'Shipment') continue;
    const amount = money(transaction.totalCents);
    if (amount === null || !validCurrency(transaction.currency)) { ids.forEach(id => incomplete.add(id)); continue; }
    ids.forEach(id => netOrders.add(id));
    if (transaction.status === 'DEFERRED') deferredSaleCount++;
    // Shipment totals already include the commissions and fulfillment fees in their breakdowns.
    contributions.push({ ids, currency: transaction.currency, amount });
  }
  for (const { transaction, orders: ids } of scoped) {
    if (transaction.type !== 'ServiceFee' || !ids.every(id => netOrders.has(id))) continue;
    const amounts = categoryFromNodes(transaction, saleFees);
    if (!amounts) {
      const expenses = platformExpenses([transaction]);
      if (!expenses.counts.ads && !expenses.counts.fbaStorage) unclassifiedFeeCount++;
      continue;
    }
    for (const [currency, amount] of amounts) {
      if (!validCurrency(currency) || amount.unknown) ids.forEach(id => incomplete.add(id));
      else contributions.push({ ids, currency, amount: amount.total });
    }
  }
  // An incomplete linked order also invalidates any inseparable, mixed-order contribution.
  let previousSize;
  do {
    previousSize = incomplete.size;
    for (const row of contributions) if (row.ids.some(id => incomplete.has(id))) row.ids.forEach(id => incomplete.add(id));
  } while (incomplete.size !== previousSize);
  for (const row of contributions) if (!row.ids.some(id => incomplete.has(id))) net.set(row.currency, (net.get(row.currency) || 0n) + row.amount);
  for (const id of incomplete) netOrders.delete(id);
  const serialize = (values, field) => [...values].sort(([a], [b]) => a.localeCompare(b)).map(([currency, amount]) => ({ currency, [field]: amount.toString() }));
  return { grossByCurrency: serialize(gross, 'grossCents'), netByCurrency: serialize(net, 'netCents'),
    orderCount: sales.length, knownGrossOrderCount: knownGrossOrders, missingGrossOrderCount: sales.length - knownGrossOrders,
    netOrderCount: netOrders.size, missingNetOrderCount: sales.length - netOrders.size, unclassifiedFeeCount, deferredSaleCount,
    dateBasis: 'order-created-at', netBasis: 'shipment-net-plus-linked-sale-fees', cashReceivedCents: null };
}
