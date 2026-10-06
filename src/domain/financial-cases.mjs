import { parseStoreSelection, matchesStoreSelection } from './store-filter.mjs';
import { createHash } from 'node:crypto';
import { ensureReviewStatusSchema, statusDefinition, availableReviewStatuses, validateReviewStatus } from './review-statuses.mjs';
import { orderFinancialEligibility, transactionFinancialEligibility } from './financial-eligibility.mjs';

const SAFE_STORE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SAFE_CASE = /^(refunds|charges)-[a-f0-9]{64}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const searchText = value => String(value ?? '').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('pt-BR');
const ids = value => [...new Set(Array.isArray(value) ? value.filter(item => text(item)).map(item => item.trim()) : [])].sort();
const amount = value => typeof value === 'string' && /^-?\d{1,2048}$/.test(value) ? BigInt(value) : null;
const currency = value => typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null;
const released = item => ['RELEASED', 'DEFERRED_RELEASED'].includes(item.status);
const error = code => Object.assign(new Error(code), { code });
const REIMBURSEMENT_TYPES = Object.freeze({ SAFETReimbursement: ['safe_t', 'SAFE-T'], LostOrDamagedReimbursement: ['easy_ship', 'Easy Ship'] });
const REIMBURSEMENT_FILTERS = Object.freeze({ identified: 'Com crédito identificado', unidentified: 'Sem crédito identificado', safe_t: 'SAFE-T', easy_ship: 'Easy Ship' });
function reimbursementSelection(value) {
  if (value === undefined || value === 'all') return null;
  if (typeof value !== 'string' || value.length > 51) throw error('INVALID_PARAMETERS');
  const selected = value.split(',');
  if (selected.length > 4 || new Set(selected).size !== selected.length
    || selected.some(code => !Object.hasOwn(REIMBURSEMENT_FILTERS, code))) throw error('INVALID_PARAMETERS');
  return selected;
}
const descendants = nodes => (Array.isArray(nodes) ? nodes : []).flatMap(node => [node, ...descendants(node?.children)]);
const KNOWN_CHARGE_KINDS = ['MFNPostageFee', 'MFNShippingChargeback', 'StorageBillingFee', 'FBAStorageFee', 'AdvertisingFee'];
const knownServiceFee = item => item.type === 'ServiceFee' && [...descendants(item.breakdowns), ...(item.items ?? []).flatMap(product => descendants(product.breakdowns))]
  .some(node => KNOWN_CHARGE_KINDS.includes(node?.kind));
function otherExpense(nodes) {
  return (Array.isArray(nodes) ? nodes : []).some(node => !KNOWN_CHARGE_KINDS.includes(node?.kind)
    && (amount(node?.amountCents) !== null && amount(node.amountCents) < 0n && !['Sales', 'Expenses', 'AmazonFees', 'FBAFees', 'Base', 'Tax'].includes(node.kind)
      || otherExpense(node?.children)));
}

function instant(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 || minute > 59 || second > 59 || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}
function kindCheck(kind) { if (!['refunds', 'charges'].includes(kind)) throw error('INVALID_PARAMETERS'); }
function identity(storeId, kind, caseId) {
  kindCheck(kind);
  if (!SAFE_STORE.test(storeId ?? '') || !SAFE_CASE.test(caseId ?? '') || !caseId.startsWith(`${kind}-`)) throw error('INVALID_REVIEW');
}
function bounds(filters) {
  const parse = (value, end) => {
    if (!value) return null;
    const day = /^\d{4}-\d{2}-\d{2}$/.test(value);
    const parsed = instant(day ? `${value}T00:00:00-03:00` : value);
    if (!parsed) throw error('INVALID_PARAMETERS');
    return day && end ? new Date(Date.parse(parsed) + 86400000).toISOString() : parsed;
  };
  const from = parse(filters.from, false), to = parse(filters.to, true);
  if (from && to && from >= to) throw error('INVALID_PARAMETERS');
  return { from, to };
}

export function ensureFinancialCaseSchema(db) {
  ensureReviewStatusSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS financial_case_reviews (
    store_id TEXT NOT NULL,kind TEXT NOT NULL,case_id TEXT NOT NULL,
    status TEXT NOT NULL,notes TEXT NOT NULL,version INTEGER NOT NULL,updated_at TEXT NOT NULL,
    PRIMARY KEY(store_id,kind,case_id));
    CREATE TABLE IF NOT EXISTS financial_case_review_history (
    store_id TEXT NOT NULL,kind TEXT NOT NULL,case_id TEXT NOT NULL,version INTEGER NOT NULL,
    previous_status TEXT NOT NULL,status TEXT NOT NULL,previous_notes TEXT NOT NULL,notes TEXT NOT NULL,changed_at TEXT NOT NULL,
    PRIMARY KEY(store_id,kind,case_id,version));`);
}
function presentReview(db, row) {
  const definition = statusDefinition(db, row.status);
  return { ...row, label: definition?.label ?? row.status, color: definition?.color ?? 'neutral', closesCase: definition?.closesCase ?? false };
}
function review(db, storeId, kind, caseId) {
  const row = db.prepare('SELECT status,notes,version,updated_at AS updatedAt FROM financial_case_reviews WHERE store_id=? AND kind=? AND case_id=?').get(storeId, kind, caseId);
  return presentReview(db, row ? { ...row } : { status: 'pending', notes: '', version: 0, updatedAt: null });
}
function validateStatus(db, kind, status, previousStatus) {
  try { return validateReviewStatus(db, kind, status, { previousStatus }); }
  catch (failure) { if (failure.code === 'INVALID_STATUS') throw error('INVALID_REVIEW'); throw failure; }
}
function history(db, storeId, kind, caseId) {
  return db.prepare(`SELECT version,previous_status AS previousStatus,status,previous_notes AS previousNotes,notes,changed_at AS changedAt
    FROM financial_case_review_history WHERE store_id=? AND kind=? AND case_id=? ORDER BY version`).all(storeId, kind, caseId).map(row => ({ ...row }));
}

// Called only inside the caller's transaction, after optimistic versions match.
function writeReview(db, { storeId, kind, caseId, previous, status, notes, timestamp }) {
  if (previous.status === status && previous.notes === notes) return previous;
  const version = previous.version + 1;
  db.prepare(`INSERT INTO financial_case_reviews VALUES(?,?,?,?,?,?,?) ON CONFLICT(store_id,kind,case_id)
    DO UPDATE SET status=excluded.status,notes=excluded.notes,version=excluded.version,updated_at=excluded.updated_at`)
    .run(storeId, kind, caseId, status, notes, version, timestamp);
  db.prepare('INSERT INTO financial_case_review_history VALUES(?,?,?,?,?,?,?,?,?)')
    .run(storeId, kind, caseId, version, previous.status, status, previous.notes, notes, timestamp);
  return presentReview(db, { status, notes, version, updatedAt: timestamp });
}

/** The caller verifies case existence. Local review never changes financial evidence. */
export function saveFinancialCaseReview({ db, storeId, kind, caseId, status, notes, expectedVersion, now = new Date() }) {
  identity(storeId, kind, caseId);
  const timestamp = instant(now);
  if (typeof status !== 'string'
    || typeof notes !== 'string' || notes.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(notes)
    || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || !timestamp) throw error('INVALID_REVIEW');
  ensureFinancialCaseSchema(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    const previous = review(db, storeId, kind, caseId);
    if (previous.version !== expectedVersion) throw error('REVIEW_CONFLICT');
    validateStatus(db, kind, status, previous.status);
    const result = writeReview(db, { storeId, kind, caseId, previous, status, notes, timestamp });
    db.exec('COMMIT');
    return result;
  } catch (failure) { db.exec('ROLLBACK'); throw failure; }
}

/** The caller verifies all cases exist. A bulk update changes statuses only. */
export function saveFinancialCaseReviews({ db, kind, items, status, now = new Date() }) {
  const timestamp = instant(now);
  if (kind !== 'refunds' || typeof status !== 'string'
    || !Array.isArray(items) || items.length < 1 || items.length > 100 || !timestamp) throw error('INVALID_REVIEW');
  const seen = new Set();
  const targets = items.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || typeof item.storeId !== 'string' || typeof item.caseId !== 'string'
      || !Number.isSafeInteger(item.expectedVersion) || item.expectedVersion < 0) throw error('INVALID_REVIEW');
    const { storeId, caseId, expectedVersion } = item;
    identity(storeId, kind, caseId);
    const key = JSON.stringify([storeId, caseId]);
    if (seen.has(key)) throw error('INVALID_REVIEW');
    seen.add(key);
    return { storeId, caseId, expectedVersion };
  });
  ensureFinancialCaseSchema(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = targets.map(item => {
      const previous = review(db, item.storeId, kind, item.caseId);
      if (previous.version !== item.expectedVersion) throw error('REVIEW_CONFLICT');
      validateStatus(db, kind, status, previous.status);
      return { ...item, previous };
    });
    let updatedCount = 0;
    const reviews = current.map(item => {
      const result = writeReview(db, { ...item, kind, status, notes: item.previous.notes, timestamp });
      if (result.version !== item.previous.version) updatedCount++;
      return { storeId: item.storeId, caseId: item.caseId, review: result };
    });
    db.exec('COMMIT');
    return { updatedCount, unchangedCount: targets.length - updatedCount, reviews };
  } catch (failure) { db.exec('ROLLBACK'); throw failure; }
}

function latestTransactions(transactions) {
  const latest = new Map();
  for (const item of transactions) {
    if (!SAFE_STORE.test(item?.storeId ?? '') || !text(item?.transactionId)) throw error('INVALID_PARAMETERS');
    const key = JSON.stringify([item.storeId, item.transactionId]), previous = latest.get(key);
    const observed = instant(item.observedAt) ?? '', previousObserved = instant(previous?.observedAt) ?? '';
    if (!previous || observed > previousObserved || observed === previousObserved && (!released(previous) || released(item))) latest.set(key, item);
  }
  return [...latest.values()];
}

// Explicit references join the original and releases, including absent originals.
function eventsFor(transactions, kind) {
  const stores = new Map();
  for (const item of latestTransactions(transactions)) {
    const type = String(item.type ?? '').toLowerCase();
    // Charges need the complete explicit-reference group before classification:
    // an original/refund and its release can carry different order identifiers.
    const candidate = kind === 'charges' || (kind === 'refunds' ? type === 'refund' : !['refund', 'transfer', 'shipment'].includes(type) && item.countsAsSales !== true);
    if (candidate) { const values = stores.get(item.storeId) ?? []; values.push(item); stores.set(item.storeId, values); }
  }
  const events = [];
  for (const [storeId, values] of stores) {
    const parents = new Map(values.map(item => [item.transactionId, item.transactionId]));
    const find = id => { if (!parents.has(id)) parents.set(id, id); let root = id; while (parents.get(root) !== root) root = parents.get(root); return root; };
    for (const item of values) for (const linked of [...ids(item.deferredTransactionIds), ...ids(item.releaseTransactionIds)]) parents.set(find(linked), find(item.transactionId));
    const groups = new Map();
    for (const item of values) { const key = find(item.transactionId), group = groups.get(key) ?? []; group.push(item); groups.set(key, group); }
    for (const group of groups.values()) {
      const refundGroup = group.some(item => String(item.type ?? '').toLowerCase() === 'refund');
      const orderIds = ids(group.flatMap(item => ids(item.orderIds)));
      if (kind === 'charges') {
        // A known order identifier is enough to exclude a refund, even if its
        // order entity has not been imported. Missing amount is never zero.
        if (refundGroup && orderIds.length) continue;
        if (!refundGroup && !group.some(item => !['transfer','shipment'].includes(String(item.type ?? '').toLowerCase())
          && item.countsAsSales !== true && amount(item.totalCents) !== null && amount(item.totalCents) < 0n)) continue;
      }
      if (kind === 'charges' && group.every(item => item.type === 'ProductAdsPayment')) continue;
      // Known expenses remain in the ledger; this queue is for charges to identify.
      // An explicit release is the same event, even when its breakdown is sparse.
      if (kind === 'charges' && group.every(item => item.type === 'ServiceFee'
        && !otherExpense(item.breakdowns) && !(item.items ?? []).some(product => otherExpense(product.breakdowns))) && group.some(knownServiceFee)) continue;
      const byId = new Map(group.map(item => [item.transactionId, item]));
      const releaseIds = new Set(group.flatMap(item => ids(item.releaseTransactionIds)));
      const isRelease = item => ids(item.deferredTransactionIds).length > 0 || releaseIds.has(item.transactionId);
      const originals = group.filter(item => !isRelease(item));
      const missingOriginal = group.some(item => ids(item.deferredTransactionIds).some(id => !byId.has(id)));
      const dates = originals.map(item => instant(item.postedAt)).filter(Boolean).sort();
      const originalPostedAt = originals.length && !missingOriginal && dates.length === originals.length ? dates[0] : null;
      const originalIds = ids(group.flatMap(item => ids(item.deferredTransactionIds)));
      const identityId = originalIds[0] ?? originals.map(item => item.transactionId).sort()[0] ?? group.map(item => item.transactionId).sort()[0];
      const eventId = hash(JSON.stringify([storeId, identityId]));
      const releases = group.filter(item => isRelease(item) && released(item));
      const candidates = releases.length ? releases : originals.length ? originals : group;
      const signatures = new Set(candidates.map(item => JSON.stringify([currency(item.currency), amount(item.totalCents)?.toString() ?? null])));
      const uncertain = signatures.size !== 1;
      const chosen = uncertain ? null : [...candidates].sort((a, b) => String(instant(a.postedAt) ?? '').localeCompare(String(instant(b.postedAt) ?? '')) || a.transactionId.localeCompare(b.transactionId)).at(-1);
      const types = ids(originals.map(item => item.type));
      const type = kind === 'refunds' || kind === 'charges' && refundGroup ? 'Refund' : types.length === 1 ? types[0] : types.length > 1 ? 'Multiple' : text(chosen?.type) ?? text(group[0].type) ?? 'Unknown';
      const movementDates = group.map(item => instant(item.postedAt)).filter(Boolean).sort();
      const date = kind === 'refunds' ? originalPostedAt : instant(chosen?.postedAt);
      const currencies = ids(group.map(item => currency(item.currency)));
      events.push({ eventId, storeId, identityId, orderIds, type, date, originalPostedAt,
        lastMovementAt: movementDates.at(-1) ?? null, currency: currency(chosen?.currency) ?? (currencies.length === 1 ? currencies[0] : null),
        totalCents: chosen && amount(chosen.totalCents) !== null ? amount(chosen.totalCents).toString() : null,
        amountUncertain: uncertain,
        transactions: group.map(item => ({ ...item, eventId, isReleaseMovement: isRelease(item), originalPostedAt,
          countsInTotal: chosen?.transactionId === item.transactionId, superseded: Boolean(chosen && chosen.transactionId !== item.transactionId) })) });
    }
  }
  return events;
}

export function refundEventCount(transactions) {
  return eventsFor(transactions, 'refunds').length;
}

function totals(events) {
  const currencies = new Map();
  let unknownCurrencyCount = 0;
  for (const event of events) {
    if (!currency(event.currency)) { unknownCurrencyCount++; continue; }
    const row = currencies.get(event.currency) ?? { currency: event.currency, knownTotalCents: 0n, unknownAmountCount: 0 };
    const value = amount(event.totalCents);
    if (value === null) row.unknownAmountCount++; else row.knownTotalCents += value;
    currencies.set(event.currency, row);
  }
  return { byCurrency: [...currencies.values()].sort((a, b) => a.currency.localeCompare(b.currency)).map(row => ({ currency: row.currency,
    totalCents: row.unknownAmountCount ? null : row.knownTotalCents.toString(), knownTotalCents: row.knownTotalCents.toString(), unknownAmountCount: row.unknownAmountCount })), unknownCurrencyCount };
}

// Stop at the identified node: its children detail that amount, not more money.
function identifiedNodes(nodes) {
  return (Array.isArray(nodes) ? nodes : []).flatMap(node => Object.hasOwn(REIMBURSEMENT_TYPES, node?.kind)
    ? [node] : identifiedNodes(node?.children));
}
function reimbursementAmount(item) {
  const root = identifiedNodes(item.breakdowns), items = (item.items ?? []).flatMap(product => identifiedNodes(product.breakdowns));
  const summarize = nodes => {
    if (!nodes.length) return null;
    const kinds = ids(nodes.map(node => node.kind)), currencies = ids(nodes.map(node => currency(node.currency)));
    if (kinds.length !== 1 || currencies.length !== 1 || nodes.some(node => !currency(node.currency) || amount(node.amountCents) === null || amount(node.amountCents) <= 0n)) return null;
    return { code: REIMBURSEMENT_TYPES[kinds[0]][0], label: REIMBURSEMENT_TYPES[kinds[0]][1], currency: currencies[0],
      totalCents: nodes.reduce((sum, node) => sum + amount(node.amountCents), 0n).toString() };
  };
  const top = summarize(root), detail = summarize(items);
  if (root.length && !top || items.length && !detail) return null;
  if (top && detail && JSON.stringify(top) !== JSON.stringify(detail)) return null;
  const result = top ?? detail;
  return result && result.currency === currency(item.currency) ? result : null;
}
export function reimbursementIndex(transactions) {
  const index = new Map();
  for (const event of eventsFor(transactions, 'reimbursements')) {
    if (event.orderIds.length !== 1 || event.amountUncertain) continue;
    const chosen = event.transactions.find(item => item.countsInTotal);
    if (!chosen || !released(chosen) || amount(chosen.totalCents) === null || amount(chosen.totalCents) <= 0n) continue;
    const money = reimbursementAmount(chosen);
    if (!money) continue;
    // Conflicting type evidence in one explicitly joined event is not allocated.
    const codes = new Set(event.transactions.flatMap(item => [...identifiedNodes(item.breakdowns), ...(item.items ?? []).flatMap(product => identifiedNodes(product.breakdowns))])
      .map(node => REIMBURSEMENT_TYPES[node.kind][0]));
    if (codes.size !== 1) continue;
    const key = JSON.stringify([event.storeId, event.orderIds[0]]), credits = index.get(key) ?? [];
    credits.push({ eventId: event.eventId, transactionId: chosen.transactionId, type: money.code, label: money.label,
      totalCents: money.totalCents, currency: money.currency, postedAt: instant(chosen.postedAt), status: chosen.status });
    index.set(key, credits);
  }
  return index;
}
export function reimbursement(credits = []) {
  const sorted = [...credits].sort((a, b) => String(a.postedAt ?? '').localeCompare(String(b.postedAt ?? '')) || a.eventId.localeCompare(b.eventId));
  const types = [...new Map(sorted.map(item => [item.type, { code: item.type, label: item.label }])).values()].sort((a, b) => a.code.localeCompare(b.code));
  return { identified: sorted.length > 0, types, byCurrency: totals(sorted).byCurrency, credits: sorted,
    lastCreditAt: sorted.map(item => item.postedAt).filter(Boolean).sort().at(-1) ?? null };
}
function reimbursementMatches(item, filter) {
  if (filter === 'all') return true;
  if (item.financialEligibility?.included === false) return false;
  if (filter === 'identified') return item.reimbursement.identified;
  if (filter === 'unidentified') return !item.reimbursement.identified;
  return item.reimbursement.types.some(type => type.code === filter);
}
function orderSummary(order) {
  return order ? { orderId: order.orderId, title: order.items?.[0]?.title ?? null, sku: order.items?.[0]?.sku ?? null,
    mode: order.fulfillmentMode ?? 'unknown', displayStatus: order.displayStatus ?? null } : null;
}
function legacyEventReviews(db, storeId, kind, caseId, events) {
  const references = new Map();
  for (const event of events) {
    if (event.type !== 'Refund') continue;
    // The former orphan refund case was keyed by this same stable event identity.
    // A later order link changes its grouping, not ownership of its saved audit.
    for (const legacyKind of kind === 'charges' ? ['refunds'] : ['refunds','charges']) {
      const legacyCaseId = `${legacyKind}-${hash(JSON.stringify([storeId,legacyKind,'event',event.identityId]))}`;
      if (legacyCaseId === caseId) continue;
      const persisted = db.prepare('SELECT 1 FROM financial_case_reviews WHERE store_id=? AND kind=? AND case_id=?').get(storeId,legacyKind,legacyCaseId);
      if (persisted) references.set(legacyCaseId,{kind:legacyKind,caseId:legacyCaseId,
        review:review(db,storeId,legacyKind,legacyCaseId),history:history(db,storeId,legacyKind,legacyCaseId)});
    }
  }
  return [...references.values()];
}
function cases({ db, kind, transactions, orders }) {
  kindCheck(kind); ensureFinancialCaseSchema(db);
  if (!Array.isArray(transactions) || !Array.isArray(orders)) throw error('INVALID_PARAMETERS');
  const orderMap = new Map(orders.map(item => [JSON.stringify([item.storeId, item.orderId]), item]));
  const eligibility = transactionFinancialEligibility(transactions, orders);
  const reimbursements = kind === 'refunds' ? reimbursementIndex(transactions) : null;
  const groups = new Map();
  for (const event of eventsFor(transactions, kind)) {
    const scope = kind === 'refunds' && event.orderIds.length === 1 ? ['order', event.orderIds[0]] : ['event', event.identityId];
    const key = JSON.stringify([event.storeId, kind, ...scope]), group = groups.get(key) ?? [];
    group.push(event); groups.set(key, group);
  }
  return [...groups].map(([key, events]) => {
    const storeId = events[0].storeId, caseId = `${kind}-${hash(key)}`, orderIds = ids(events.flatMap(event => event.orderIds));
    const dated = events.map(event => event.date).filter(Boolean).sort();
    const movements = events.map(event => event.lastMovementAt).filter(Boolean).sort();
    const money = totals(events), singleCurrency = money.byCurrency.length === 1 && !money.unknownCurrencyCount;
    const total = singleCurrency ? amount(money.byCurrency[0].totalCents) : null;
    const types = ids(events.map(event => event.type));
    const type = types.length === 1 ? types[0] : 'Multiple';
    const transactions = events.flatMap(event => event.transactions).sort((a, b) => String(instant(a.postedAt) ?? '').localeCompare(String(instant(b.postedAt) ?? '')) || a.transactionId.localeCompare(b.transactionId));
    const excluded = orderIds.some(id => !orderFinancialEligibility(orderMap.get(JSON.stringify([storeId,id]))).included)
      || transactions.some(transaction => eligibility.excludedKeys.has(JSON.stringify([transaction.storeId,transaction.transactionId])));
    return { caseId, storeId, kind, orderIds, order: orderIds.length === 1 ? orderSummary(orderMap.get(JSON.stringify([storeId, orderIds[0]]))) : null,
      financialEligibility: { included: !excluded, reason: excluded ? 'payment-pending' : null },
      allocation: orderIds.length === 1 ? 'order' : orderIds.length ? 'multiple-orders-unallocated' : 'unlinked',
      type, ...(kind === 'charges' && type === 'Refund' && !orderIds.length ? { typeLabel:'Reembolso sem pedido' } : {}),
      firstEventAt: dated[0] ?? null, lastEventAt: dated.at(-1) ?? null,
      lastMovementAt: movements.at(-1) ?? null, eventDateKnown: dated.length === events.length,
      totalCents: singleCurrency ? money.byCurrency[0].totalCents : null, currency: singleCurrency ? money.byCurrency[0].currency : null,
      financialEffect: total === null ? 'unknown' : total > 0n ? 'credit' : total < 0n ? 'debit' : 'zero',
      hasCreditMovement: transactions.some(item => amount(item.totalCents) !== null && amount(item.totalCents) > 0n),
      ...money, transactions, review: review(db, storeId, kind, caseId), legacyReviews:legacyEventReviews(db,storeId,kind,caseId,events),
      refundCount: kind === 'refunds' ? events.length : 0,
      ...(kind === 'refunds' ? { reimbursement: reimbursement(orderIds.length === 1 ? reimbursements.get(JSON.stringify([storeId, orderIds[0]])) : []) } : {}),
      eventCount: events.length, movementCount: transactions.length, amountUncertain: events.some(event => event.amountUncertain),
      _events: events, _order: orderIds.length === 1 ? orderMap.get(JSON.stringify([storeId, orderIds[0]])) : null };
  });
}
function publicCase({ _events, _order, ...item }) { return item; }
function searchable(item, query) {
  const values = [item.caseId, item.type, ...item.orderIds, ...(item._order?.items ?? []).flatMap(product => [product.title, product.sku, product.asin]),
    ...item.transactions.flatMap(transaction => [transaction.transactionId, ...(transaction.items ?? []).flatMap(product => [product.sku, product.asin])])];
  return !query || searchText(values.filter(Boolean).join(' ')).includes(query);
}
function options(rows, key, label = value => value) {
  const counts = new Map();
  for (const row of rows) { const code = key(row); counts.set(code, (counts.get(code) ?? 0) + 1); }
  return [...counts].map(([code, count]) => ({ code, label: label(code), count })).sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
}

/** Dates select whole cases by a known event; totals include every event in selected cases. */
export function buildFinancialCases({ db, kind, transactions, orders, filters = {}, now = new Date() }) {
  if (!instant(now)) throw error('INVALID_PARAMETERS');
  const { from, to } = bounds(filters);
  try { parseStoreSelection(filters.storeId); } catch { throw error('INVALID_PARAMETERS'); }
  const query = searchText(filters.query);
  const status = filters.status === undefined ? 'all' : filters.status, type = filters.type ?? 'all';
  const reimbursementFilters = reimbursementSelection(filters.reimbursement);
  if (filters.reimbursement !== undefined && kind !== 'refunds') throw error('INVALID_PARAMETERS');
  const allCases = cases({ db, kind, transactions, orders });
  const filterDefinition = status === 'all' ? null : statusDefinition(db, status);
  if (typeof status !== 'string' || status !== 'all' && (!filterDefinition
    || !filterDefinition.menus.includes(kind) && !allCases.some(item => item.review.status === status))) throw error('INVALID_PARAMETERS');
  const scoped = allCases.filter(item => matchesStoreSelection(filters.storeId, item.storeId) && searchable(item, query));
  const undatedExcludedCount = from || to ? scoped.filter(item => !item._events.some(event => event.date)).length : 0;
  const dated = scoped.filter(item => !from && !to || item._events.some(event => event.date && (!from || event.date >= from) && (!to || event.date < to)));
  const reimbursed = dated.filter(item => reimbursementFilters === null || reimbursementFilters.some(filter => reimbursementMatches(item, filter)));
  const statusOptions = options(reimbursed.filter(item => type === 'all' || item.type === type), item => item.review.status,
    code => statusDefinition(db, code)?.label ?? code).map(option => {
      const definition = statusDefinition(db, option.code);
      return { ...option, color: definition?.color ?? 'neutral', closesCase: definition?.closesCase ?? false };
    });
  const typeOptions = options(reimbursed.filter(item => status === 'all' || item.review.status === status), item => item.type,
    code => kind === 'charges' && code === 'Refund' ? 'Reembolso sem pedido' : code);
  const facetScope = dated.filter(item => (status === 'all' || item.review.status === status) && (type === 'all' || item.type === type));
  const reimbursementOptions = kind === 'refunds' ? Object.entries(REIMBURSEMENT_FILTERS).map(([code, label]) => ({ code, label, count: facetScope.filter(item => reimbursementMatches(item, code)).length })) : [];
  const selected = reimbursed.filter(item => (status === 'all' || item.review.status === status) && (type === 'all' || item.type === type))
    .sort((a, b) => String(b.lastEventAt ?? '').localeCompare(String(a.lastEventAt ?? '')) || a.caseId.localeCompare(b.caseId));
  const financiallyIncluded = selected.filter(item => item.financialEligibility.included);
  const summary = { caseCount: selected.length, eventCount: selected.reduce((sum, item) => sum + item.eventCount, 0),
    movementCount: selected.reduce((sum, item) => sum + item.movementCount, 0), unknownEventDateCount: selected.filter(item => !item.eventDateKnown).length,
    unallocatedCaseCount: selected.filter(item => item.allocation !== 'order').length, undatedExcludedCount, reimbursementCount: financiallyIncluded.filter(item => item.reimbursement?.identified).length,
    excludedPendingCaseCount: selected.length - financiallyIncluded.length,
    ...totals(financiallyIncluded.flatMap(item => item._events)), pendingCount: 0, inReviewCount: 0, requestSafeTCount: 0, waitingAmazonCount: 0, resolvedCount: 0 };
  const countKeys = { pending: 'pendingCount', in_review: 'inReviewCount', request_safe_t: 'requestSafeTCount', waiting_amazon: 'waitingAmazonCount' };
  for (const item of selected) summary[item.review.closesCase ? 'resolvedCount' : countKeys[item.review.status] ?? 'inReviewCount']++;
  const offset = Math.max(0, Number.isSafeInteger(Number(filters.offset)) ? Number(filters.offset) : 0);
  const limit = Math.max(1, Math.min(500, Number.isSafeInteger(Number(filters.limit)) && Number(filters.limit) > 0 ? Number(filters.limit) : 100));
  return { items: selected.slice(offset, offset + limit).map(publicCase), total: selected.length, offset, limit, hasMore: offset + limit < selected.length,
    summary, statusOptions, typeOptions, reimbursementOptions, reviewStatuses: availableReviewStatuses(db, kind), dateBasis: kind === 'refunds' ? 'refund-original-event' : 'transaction-posted-at' };
}

export function getFinancialCase({ db, kind, transactions, orders, caseId, storeId, filters = {} }) {
  const selectedStore = storeId ?? filters.storeId;
  identity(selectedStore, kind, caseId);
  const item = cases({ db, kind, transactions, orders }).find(item => item.storeId === selectedStore && item.caseId === caseId);
  return item ? { ...publicCase(item), reviewHistory: history(db, selectedStore, kind, caseId), reviewStatuses: availableReviewStatuses(db, kind) } : null;
}
