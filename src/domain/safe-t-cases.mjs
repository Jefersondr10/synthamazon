import { canonicalStoreSelection, matchesStoreSelection } from './store-filter.mjs';
import { createHash } from 'node:crypto';
import { decorateOrderStatus, ORDER_STATUS_CATALOG } from './order-status.mjs';
import { buildReturnSignals, customerReturnLink, returnedToSellerLink } from './return-signals.mjs';
import { orderFinancialEligibility } from './financial-eligibility.mjs';

const STORE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const STATUS = /^[A-Z_][A-Z0-9_]{0,79}$/;
const MODES = new Set(['ALL', 'DBA', 'FBA', 'MFN', 'UNKNOWN']);
const FBA_REPORT = 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA';
const CATEGORY_LABELS = {
  CUSTOMER_RETURN: 'Devolução', OPEN_RETURN: 'Devolução em aberto',
  ...Object.fromEntries(Object.entries(ORDER_STATUS_CATALOG).map(([code, value]) => [code, value.label])),
};
const FIXED_CATEGORIES = new Set(['CUSTOMER_RETURN', 'OPEN_RETURN', 'RETURNED_TO_SELLER', 'RETURNING_TO_SELLER',
  'LOST', 'PICKED_UP', 'REJECTED_BY_BUYER', 'UNDELIVERABLE', 'DELIVERED']);
const key = (storeId, orderId) => JSON.stringify([storeId, orderId]);
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const searchText = value => String(value ?? '').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('pt-BR');
const money = value => typeof value === 'string' && /^-?\d{1,2048}$/.test(value) ? BigInt(value) : null;
const currency = value => typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null;
const invalid = () => Object.assign(new TypeError('Invalid SAFE-T view parameters.'), { code: 'INVALID_PARAMETERS' });

function instant(value) {
  if (typeof value !== 'string') return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) return null;
  const [year, month, day, hour, minute, second] = parts.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    || hour > 23 || minute > 59 || second > 59 || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}
function boundary(value, end = false) {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string') throw invalid();
  const day = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = instant(day ? `${value}T00:00:00-03:00` : value);
  if (!parsed) throw invalid();
  return day && end ? new Date(Date.parse(parsed) + 86_400_000).toISOString() : parsed;
}
function selections(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > 4049) throw invalid();
  const values = value.split(',').map(code => code.toUpperCase());
  if (values.length > 50 || values.some(code => !STATUS.test(code)) || new Set(values).size !== values.length
    || values.includes('ALL') && values.length !== 1) throw invalid();
  return values[0] === 'ALL' ? null : new Set(values);
}
function checkedFilters(filters) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) throw invalid();
  let storeId; try { storeId = canonicalStoreSelection(filters.storeId); } catch { throw invalid(); }
  if (filters.storeId === null || filters.query !== undefined && (typeof filters.query !== 'string' || filters.query.length > 200)) throw invalid();
  const mode = filters.mode === undefined ? 'ALL' : typeof filters.mode === 'string' ? filters.mode.toUpperCase() : null;
  if (!MODES.has(mode)) throw invalid();
  const from = boundary(filters.from), to = boundary(filters.to, true);
  if (from && to && from >= to) throw invalid();
  const number = (name, fallback, minimum, maximum) => {
    if (filters[name] === undefined) return fallback;
    const value = filters[name];
    if (!(typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value))
      || !Number.isSafeInteger(Number(value)) || Number(value) < minimum || Number(value) > maximum) throw invalid();
    return Number(value);
  };
  return { storeId, mode, from, to, statuses: selections(filters.status), query: searchText(filters.query),
    offset: number('offset', 0, 0, 1_000_000), limit: number('limit', 100, 1, 500) };
}
function categoryCode(value) {
  const raw = text(value) ?? 'UNKNOWN';
  const normalized = raw.toUpperCase() === 'CANCELED' ? 'CANCELLED' : raw.toUpperCase();
  return STATUS.test(normalized) ? normalized : `OTHER_STATUS_${createHash('sha256').update(raw).digest('hex').slice(0, 16).toUpperCase()}`;
}
function productsFor(order, reports) {
  const products = (order?.items ?? []).map(item => ({ sku: item.sku ?? null, asin: item.asin ?? null,
    title: item.title ?? null, quantityOrdered: Number.isSafeInteger(item.quantityOrdered) ? item.quantityOrdered : null }));
  for (const item of reports) {
    if (!item.sku && !item.asin && !item.productName) continue;
    const known = products.some(product => item.sku ? product.sku === item.sku : item.asin ? product.asin === item.asin
      : !product.sku && !product.asin && product.title === item.productName);
    if (known) continue;
    // A returned quantity is not the quantity originally ordered.
    products.push({ sku: item.sku ?? null, asin: item.asin ?? null, title: item.productName ?? null, quantityOrdered: null });
  }
  return products;
}
function financialRefund(cases) {
  const allocated = cases.filter(item => new Set(item.orderIds).size === 1), amounts = new Map();
  for (const item of allocated) for (const row of item.byCurrency ?? []) {
    if (!currency(row.currency)) continue;
    const total = amounts.get(row.currency) ?? { sum: 0n, unknown: false };
    const value = money(row.totalCents);
    if (value === null) total.unknown = true; else total.sum += value;
    amounts.set(row.currency, total);
  }
  const dates = [...new Set(cases.flatMap(item => [item.firstEventAt, item.lastEventAt,
    ...(item.transactions ?? []).map(transaction => transaction.originalPostedAt)]).map(instant).filter(Boolean))].sort();
  return { refund: { source: 'financial-transactions',
    byCurrency: [...amounts].sort(([a], [b]) => a.localeCompare(b)).map(([currency, value]) => ({ currency, totalCents: value.unknown ? null : value.sum.toString() })),
    latestPostedAt: dates.at(-1) ?? null,
    count: cases.reduce((sum, item) => sum + (Number.isSafeInteger(item.refundCount) ? item.refundCount : 0), 0),
    dateKnown: dates.length > 0 && cases.every(item => item.eventDateKnown === true),
    allocation: allocated.length === cases.length ? 'order' : 'multiple-orders-unallocated',
    unallocatedCaseCount: cases.length - allocated.length }, dates };
}
function reportedRefund(reports) {
  const amounts = new Map();
  for (const item of reports) {
    const value = money(item.reportedRefundCents);
    if (value === null || value <= 0n || !currency(item.currency)) continue;
    const values = amounts.get(item.currency) ?? new Set(); values.add(value.toString()); amounts.set(item.currency, values);
  }
  // The reports do not identify independent financial events. Repeated values
  // are one piece of evidence; divergent values are not summed speculatively.
  return { refund: { source: 'return-report', byCurrency: [...amounts].sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, values]) => ({ currency, totalCents: values.size === 1 ? [...values][0] : null })),
    latestPostedAt: null, count: null, dateKnown: false, allocation: 'reported-not-reconciled' }, dates: [] };
}

/** Read-only union of refund evidence. Presence never establishes SAFE-T eligibility. */
export function buildSafeTCases({ orders = [], refundCases = [], customerReturns = [], returnedToSeller = [], filters = {} } = {}) {
  if (![orders, refundCases, customerReturns, returnedToSeller].every(Array.isArray)) throw invalid();
  const selected = checkedFilters(filters), labels = new Map(Object.entries(CATEGORY_LABELS));
  const orderMap = new Map(orders.map(order => [key(order.storeId, order.orderId), order]));
  const returnedMap = new Map(returnedToSeller.map(row => [key(row.storeId, row.orderId), row]));
  const groups = new Map(), reportIndex = new Map();
  const groupFor = (storeId, orderId) => {
    if (!STORE.test(storeId ?? '') || !text(orderId)) return null;
    const identity = key(storeId, orderId);
    if (!groups.has(identity)) groups.set(identity, { storeId, orderId, cases: new Map() });
    return groups.get(identity);
  };
  for (const row of customerReturns) {
    if (!STORE.test(row?.storeId ?? '') || !text(row.orderId) || !text(row.returnId)) continue;
    const identity = key(row.storeId, row.orderId), reports = reportIndex.get(identity) ?? new Map();
    const previous = reports.get(row.returnId);
    if (!previous || String(row.observedAt ?? '') >= String(previous.observedAt ?? '')) reports.set(row.returnId, row);
    reportIndex.set(identity, reports);
  }
  for (const reports of reportIndex.values()) for (const row of reports.values()) {
    const amount = money(row.reportedRefundCents);
    if (amount !== null && amount > 0n) groupFor(row.storeId, row.orderId);
  }
  let unlinkedRefundCaseCount = 0;
  for (const item of refundCases) {
    if (item?.kind !== 'refunds' || item.type !== 'Refund' || !text(item.caseId)) continue;
    const orderIds = [...new Set((item.orderIds ?? []).filter(text))];
    if (!orderIds.length) { if (matchesStoreSelection(selected.storeId, item.storeId)) unlinkedRefundCaseCount++; continue; }
    for (const orderId of orderIds) groupFor(item.storeId, orderId)?.cases.set(item.caseId, item);
  }
  const rows = [...groups].map(([identity, group]) => {
    const sourceOrder = orderMap.get(identity), order = sourceOrder ? decorateOrderStatus(sourceOrder) : null;
    const reports = [...(reportIndex.get(identity)?.values() ?? [])];
    const displayStatus = order?.displayStatus ?? decorateOrderStatus({}).displayStatus;
    const mode = ['DBA', 'FBA', 'MFN'].includes(order?.fulfillmentMode) ? order.fulfillmentMode
      : reports.length && reports.every(row => row.reportType === FBA_REPORT) ? 'FBA' : 'unknown';
    const categories = new Set();
    const add = (raw, label) => {
      const code = categoryCode(raw); categories.add(code);
      if (!labels.has(code)) labels.set(code, label ?? text(raw) ?? 'Não informado');
    };
    add(displayStatus.code, displayStatus.label);
    // Mixed packages retain their individual current states without replacing
    // an explicit order-level cancellation or pending state with old tracking.
    if (displayStatus.source === 'tracking' || displayStatus.partial) for (const pkg of order.packages ?? []) {
      const raw = pkg.detailedStatus || pkg.status;
      if (raw) add(['CANCELLED', 'CANCELED'].includes(raw.toUpperCase()) ? 'PACKAGE_CANCELLED'
        : ['PENDING','PENDING_AVAILABILITY'].includes(raw.toUpperCase()) ? 'PACKAGE_PENDING' : raw);
    }
    const customerLinks = reports.map(row => customerReturnLink(row, group.orderId)).sort((a, b) => a.returnId.localeCompare(b.returnId));
    const returned = returnedToSellerLink(returnedMap.get(identity), group.orderId);
    const returnSignals = buildReturnSignals({ customerReturns: customerLinks, returnedToSeller: returned });
    if (reports.length) categories.add('CUSTOMER_RETURN');
    if (returnSignals.openCustomerReturns.length) categories.add('OPEN_RETURN');
    const cases = [...group.cases.values()], { refund, dates } = cases.length ? financialRefund(cases) : reportedRefund(reports);
    const excluded = !orderFinancialEligibility(order).included || cases.some(item => item.financialEligibility?.included === false);
    return { storeId: group.storeId, orderId: group.orderId, order, products: productsFor(order, reports), fulfillmentMode: mode,
      financialEligibility: { included: !excluded, reason: excluded ? 'payment-pending' : null },
      displayStatus, categoryCodes: [...categories], refund, refundCaseIds: cases.map(item => item.caseId).sort(),
      customerReturns: customerLinks, returnedToSeller: returned, returnSignals,
      _dates: dates };
  });
  const scoped = rows.filter(row => (matchesStoreSelection(selected.storeId, row.storeId))
    && (selected.mode === 'ALL' || row.fulfillmentMode.toUpperCase() === selected.mode)
    && (!selected.query || searchText([row.orderId, ...row.products.flatMap(item => [item.sku, item.asin, item.title])].filter(Boolean).join(' ')).includes(selected.query)));
  const dated = scoped.filter(row => !selected.from && !selected.to
    || row._dates.some(date => (!selected.from || date >= selected.from) && (!selected.to || date < selected.to)));
  const matchesStatus = row => selected.statuses === null || row.categoryCodes.some(code => selected.statuses.has(code));
  const counts = new Map();
  for (const row of dated) for (const code of row.categoryCodes) counts.set(code, (counts.get(code) ?? 0) + 1);
  for (const code of selected.statuses ?? []) if (!labels.has(code)) labels.set(code, code);
  const statusOptions = [...labels].filter(([code]) => FIXED_CATEGORIES.has(code) || counts.has(code) || selected.statuses?.has(code))
    .map(([code, label]) => ({ code, label, count: counts.get(code) ?? 0 }));
  const filtered = dated.filter(matchesStatus)
    .sort((a, b) => String(b.refund.latestPostedAt ?? '').localeCompare(String(a.refund.latestPostedAt ?? ''))
      || a.storeId.localeCompare(b.storeId) || a.orderId.localeCompare(b.orderId));
  return { items: filtered.slice(selected.offset, selected.offset + selected.limit).map(({ _dates, ...row }) => row),
    total: filtered.length, offset: selected.offset, limit: selected.limit, hasMore: selected.offset + selected.limit < filtered.length,
    statusOptions, summary: { orderCount: filtered.length, availableOrderCount: dated.length,
      withoutDateCount: scoped.filter(row => matchesStatus(row) && row._dates.length === 0).length, unlinkedRefundCaseCount },
    dateBasis: 'refund-original-event', eligibilityAssessed: false };
}
