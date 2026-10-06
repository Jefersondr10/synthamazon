import { canonicalStoreSelection, storeArgs } from './store-filter.mjs';
import { createHash } from 'node:crypto';
import { projectLocalReviews } from './review-projection.mjs';
import { orderFinancialEligibility, transactionFinancialEligibility } from './financial-eligibility.mjs';
import { reimbursementIndex, reimbursement } from './financial-cases.mjs';
import { returnedManagement } from './returned-management.mjs';

const RETURNED = 'RETURNED_TO_SELLER';
const SAFE_STORE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const OFFICIAL_POLICY_URL = 'https://sellercentral.amazon.com.br/help/hub/reference/GNGYMYPKATHYPHJN';
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;

function instant(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match.map(Number);
  const maximum = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > maximum || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function requireIdentity(storeId, orderId) {
  if (typeof storeId !== 'string' || !SAFE_STORE.test(storeId)) throw new TypeError('Loja inválida.');
  if (!text(orderId) || orderId.length > 256) throw new TypeError('Pedido inválido.');
}

function normalizePackages(packages) {
  if (!Array.isArray(packages)) throw new TypeError('Pacotes inválidos.');
  return packages.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('Pacote inválido.');
    return {
      packageReferenceId: text(item.packageReferenceId), trackingNumber: text(item.trackingNumber),
      status: text(item.status), detailedStatus: text(item.detailedStatus),
    };
  });
}

export function ensureReturnSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS tracking_observations (
    store_id TEXT NOT NULL, order_id TEXT NOT NULL, observed_at TEXT NOT NULL,
    content_hash TEXT NOT NULL, packages_json TEXT NOT NULL,
    PRIMARY KEY (store_id, order_id, observed_at, content_hash)
  );
  CREATE INDEX IF NOT EXISTS idx_tracking_observations_order
    ON tracking_observations(store_id, order_id, observed_at);`);
}

/** Store only normalized tracking evidence, never replace prior observations. */
export function recordTrackingObservation(db, { storeId, orderId, observedAt, packages }) {
  requireIdentity(storeId, orderId);
  const observed = instant(observedAt);
  if (!observed) throw new TypeError('Data da observação inválida.');
  const payload = JSON.stringify(normalizePackages(packages));
  ensureReturnSchema(db);
  const result = db.prepare('INSERT OR IGNORE INTO tracking_observations VALUES(?,?,?,?,?)')
    .run(storeId, orderId, observed, hash(payload), payload);
  return { recorded: result.changes > 0 };
}

export function latestTracking(db, { storeId, orderId }) {
  requireIdentity(storeId, orderId);
  ensureReturnSchema(db);
  const rows = db.prepare(`SELECT observed_at,packages_json FROM tracking_observations
    WHERE store_id=? AND order_id=? ORDER BY observed_at,content_hash`).all(storeId, orderId);
  let result = null;
  for (const row of rows) {
    const packages = normalizePackages(JSON.parse(row.packages_json));
    if (packages.length) result = { observedAt: row.observed_at, packages: mergeTrackingPackages(result?.packages ?? [], packages) };
  }
  return result;
}

/** Read the same merged history for a whole list in one ordered query. */
export function latestTrackingIndex(db, storeId = null) {
  canonicalStoreSelection(storeId);
  ensureReturnSchema(db);
  const result = new Map();
  for (const row of db.prepare(`SELECT store_id,order_id,observed_at,packages_json FROM tracking_observations
    WHERE (? IS NULL OR store_id IN (SELECT value FROM json_each(?))) ORDER BY store_id,order_id,observed_at,content_hash`).all(...storeArgs(storeId))) {
    const packages = normalizePackages(JSON.parse(row.packages_json));
    if (!packages.length) continue;
    const key = JSON.stringify([row.store_id, row.order_id]);
    result.set(key, { observedAt: row.observed_at, packages: mergeTrackingPackages(result.get(key)?.packages ?? [], packages) });
  }
  return result;
}

/** A partial package response never erases previously observed packages/fields. */
export function mergeTrackingPackages(existing, incoming) {
  const merged = existing.map(pkg => ({ ...pkg }));
  for (const pkg of incoming) {
    if (!pkg.packageReferenceId && !pkg.trackingNumber) continue;
    let index = pkg.packageReferenceId ? merged.findIndex(prior => prior.packageReferenceId === pkg.packageReferenceId) : -1;
    if (index < 0 && pkg.trackingNumber) {
      const matches = merged.flatMap((prior, i) => prior.trackingNumber === pkg.trackingNumber
        && (!pkg.packageReferenceId || !prior.packageReferenceId) ? [i] : []);
      if (matches.length === 1) index = matches[0];
      else if (matches.length > 1) continue;
    }
    const explicit = Object.fromEntries(Object.entries(pkg).filter(([, value]) => value !== null && value !== undefined && value !== ''));
    if (index < 0) merged.push(explicit);
    else merged[index] = { ...merged[index], ...explicit };
  }
  return merged;
}

function localCalendarDay(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(value));
  const part = type => parts.find(item => item.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function dayNumber(value) {
  return Date.parse(`${localCalendarDay(value)}T00:00:00Z`) / 86_400_000;
}

function filterBoundary(value, end) {
  if (!value) return null;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const first = instant(`${value}T00:00:00-03:00`);
    if (!first) throw new TypeError('Período inválido.');
    return new Date(Date.parse(first) + (end ? 86_400_000 : 0)).toISOString();
  }
  const parsed = instant(value);
  if (!parsed) throw new TypeError('Período inválido.');
  return parsed;
}

function safePolicy(policy) {
  if (!Number.isSafeInteger(policy.days) || policy.days < 1 || policy.days > 365 || policy.kind !== 'calendar') {
    throw new TypeError('O alerta interno exige uma quantidade de dias corridos.');
  }
  return { days: policy.days, kind: 'calendar', isOfficial: false, label: 'Alerta interno antecipado',
    timeZone: 'America/Sao_Paulo', officialPolicyUrl: OFFICIAL_POLICY_URL };
}

function refundEvidence(transactions) {
  const refunds = transactions.filter(item => item.type === 'Refund');
  const byId = new Map(refunds.map(item => [item.transactionId, item]));
  const parents = new Map(refunds.map(item => [item.transactionId, item.transactionId]));
  const find = id => {
    let root = id;
    while (parents.get(root) !== root) root = parents.get(root);
    return root;
  };
  for (const item of refunds) {
    for (const linked of [...(item.deferredTransactionIds ?? []), ...(item.releaseTransactionIds ?? [])]) {
      if (!parents.has(linked)) parents.set(linked, linked);
      parents.set(find(linked), find(item.transactionId));
    }
  }
  const groups = new Map();
  for (const item of refunds) {
    const key = find(item.transactionId), group = groups.get(key) ?? [];
    group.push(item); groups.set(key, group);
  }
  const projected = [], eventDates = [];
  let unknownOriginalDates = 0;
  for (const group of groups.values()) {
    const releaseIds = new Set(group.flatMap(item => item.releaseTransactionIds ?? []));
    const isRelease = item => (item.deferredTransactionIds?.length ?? 0) > 0 || releaseIds.has(item.transactionId);
    const originalKnown = group.some(item => !isRelease(item));
    const missingOriginal = group.some(item => (item.deferredTransactionIds ?? []).some(id => !byId.has(id)));
    const dates = group.filter(item => !isRelease(item)).map(item => instant(item.postedAt)).filter(Boolean).sort();
    const originalUndated = group.some(item => !isRelease(item) && !instant(item.postedAt));
    const originalPostedAt = originalKnown && !missingOriginal && !originalUndated ? dates[0] ?? null : null;
    if (originalPostedAt) eventDates.push(originalPostedAt); else unknownOriginalDates++;
    const eventId = group.filter(item => !isRelease(item)).map(item => item.transactionId).sort()[0]
      ?? group.flatMap(item => item.deferredTransactionIds ?? []).sort()[0]
      ?? group.map(item => item.transactionId).sort()[0];
    for (const item of group) projected.push({
      transactionId: item.transactionId, postedAt: instant(item.postedAt), status: text(item.status),
      totalCents: typeof item.totalCents === 'string' && /^-?\d+$/.test(item.totalCents) ? BigInt(item.totalCents).toString() : null,
      currency: text(item.currency), isReleaseMovement: isRelease(item), refundEventId: eventId, originalPostedAt,
    });
  }
  projected.sort((a, b) => String(a.postedAt ?? '').localeCompare(String(b.postedAt ?? '')) || a.transactionId.localeCompare(b.transactionId));
  eventDates.sort();
  const movementDates = projected.map(item => item.postedAt).filter(Boolean).sort();
  return { status: projected.length ? 'recorded' : 'not-found', latestPostedAt: eventDates.at(-1) ?? null,
    firstPostedAt: eventDates[0] ?? null, count: groups.size, transactions: projected,
    movementCount: projected.length, latestMovementPostedAt: movementDates.at(-1) ?? null,
    hasUndatedTransactions: unknownOriginalDates > 0, hasUnknownOriginalDate: unknownOriginalDates > 0,
    unknownOriginalDateCount: unknownOriginalDates };
}

function alertFor(episode, refund, policy, now) {
  const unset = { referenceAt: null, dueAt: null, daysRemaining: null, basis: null };
  if (refund.financialEligibility?.included === false) return { state: 'financial-excluded', ...unset };
  if (episode.detectionKind === 'already-returned') return { state: 'needs-confirmation', ...unset };
  if (refund.status !== 'recorded') return { state: 'pending-refund', ...unset };
  if (!refund.latestPostedAt || refund.hasUndatedTransactions) return { state: 'needs-confirmation', ...unset };
  const referenceAt = episode.transitionDetectedAt > refund.latestPostedAt ? episode.transitionDetectedAt : refund.latestPostedAt;
  // This is explicitly an internal observation-based reminder, not an Amazon
  // deadline. The pilot observations are in the current Brasília UTC-03 era.
  const dueAt = new Date(Date.parse(referenceAt) + policy.days * 86_400_000).toISOString();
  const daysRemaining = dayNumber(dueAt) - dayNumber(now);
  return { state: daysRemaining < 0 ? 'overdue' : daysRemaining === 0 ? 'due-today' : 'open',
    referenceAt, dueAt, daysRemaining, basis: 'internal-observation' };
}

function packageHistory(observations) {
  const states = [];
  const references = new Map();
  const tracking = new Map();
  let largestSnapshotCount = 0;
  for (const observation of observations) {
    largestSnapshotCount = Math.max(largestSnapshotCount, observation.packages.length);
    for (const pkg of observation.packages) {
      if (!pkg.packageReferenceId && !pkg.trackingNumber) continue;
      let state = pkg.packageReferenceId ? references.get(pkg.packageReferenceId) : null;
      const candidates = pkg.trackingNumber ? [...(tracking.get(pkg.trackingNumber) ?? [])] : [];
      if (!state && candidates.length === 1 && (!pkg.packageReferenceId || !candidates[0].packageReferenceId)) state = candidates[0];
      // An identifier-free reference to a tracking number shared by multiple
      // packages cannot be assigned safely to either package.
      if (!state && !pkg.packageReferenceId && candidates.length > 1) continue;
      if (!state) {
        state = { key: pkg.packageReferenceId ? `package:${pkg.packageReferenceId}` : `tracking:${pkg.trackingNumber}`,
          packageReferenceId: pkg.packageReferenceId, trackingNumber: pkg.trackingNumber,
          status: null, detailedStatus: null, statusObservedAt: null, lastNonReturnedAt: null, episode: null };
        states.push(state);
      }
      if (pkg.packageReferenceId) { references.set(pkg.packageReferenceId, state); state.packageReferenceId ??= pkg.packageReferenceId; }
      if (pkg.trackingNumber) {
        const set = tracking.get(pkg.trackingNumber) ?? new Set(); set.add(state); tracking.set(pkg.trackingNumber, set);
        state.trackingNumber = pkg.trackingNumber;
      }
      // Missing packages or detailed statuses do not prove either a return or
      // a transition away from one. Keep the last explicit status evidence.
      if (pkg.status) state.status = pkg.status;
      if (!pkg.detailedStatus) continue;
      if (pkg.detailedStatus === RETURNED && !state.episode) {
        const previousObservedAt = state.lastNonReturnedAt && state.lastNonReturnedAt < observation.observedAt ? state.lastNonReturnedAt : null;
        state.episode = { detectedAt: observation.observedAt, transitionDetectedAt: previousObservedAt ? observation.observedAt : null,
          previousObservedAt, detectionKind: previousObservedAt ? 'transition' : 'already-returned' };
      }
      if (pkg.detailedStatus !== RETURNED) state.lastNonReturnedAt = observation.observedAt;
      state.detailedStatus = pkg.detailedStatus;
      state.statusObservedAt = observation.observedAt;
    }
  }
  return { states, packageCount: Math.max(states.length, largestSnapshotCount) };
}

function trackingHistoryForOrder(db, record, order) {
  const observations = db.prepare(`SELECT observed_at,payload_json FROM observations
    WHERE store_id=? AND source='orders' AND source_id=? ORDER BY observed_at,run_id,version_hash`).all(record.store_id, record.source_id)
    .map(item => ({ observedAt: instant(item.observed_at), packages: normalizePackages(JSON.parse(item.payload_json).packages ?? []) }));
  observations.push({ observedAt: instant(record.observed_at), packages: normalizePackages(order.packages ?? []) });
  observations.push(...db.prepare(`SELECT observed_at,packages_json FROM tracking_observations
    WHERE store_id=? AND order_id=? ORDER BY observed_at,content_hash`).all(record.store_id, record.source_id)
    .map(item => ({ observedAt: instant(item.observed_at), packages: normalizePackages(JSON.parse(item.packages_json)) })));
  const seen = new Set();
  const unique = observations.filter(item => {
    if (!item.observedAt) return false;
    const key = `${item.observedAt}\u0000${JSON.stringify(item.packages)}`;
    if (seen.has(key)) return false; seen.add(key); return true;
  }).sort((a, b) => a.observedAt.localeCompare(b.observedAt) || JSON.stringify(a.packages).localeCompare(JSON.stringify(b.packages)));
  return packageHistory(unique);
}

// Validate only the selected order; a manual status edit does not need the
// financial projection or tracking histories of every other order in the store.
export function hasReturnedOrder(db, storeId, orderId) {
  requireIdentity(storeId, orderId);
  ensureReturnSchema(db);
  const record = db.prepare("SELECT store_id,source_id,observed_at,payload_json FROM entities WHERE store_id=? AND source='orders' AND source_id=?").get(storeId, orderId);
  if (!record) return false;
  const order = JSON.parse(record.payload_json);
  return order.orderId === orderId && order.fulfillmentMode === 'DBA'
    && trackingHistoryForOrder(db, record, order).states.some(item => item.episode);
}

/** One operational row per DBA order with evidence of a returned package. */
export function returnsView({ db, filters = {}, now = new Date(), policy = { days: 5, kind: 'calendar' } }) {
  ensureReturnSchema(db);
  const generatedAt = now instanceof Date && Number.isFinite(now.getTime()) ? now.toISOString() : instant(now);
  if (!generatedAt) throw new TypeError('Horário atual inválido.');
  const appliedPolicy = safePolicy(policy);
  const storeId = canonicalStoreSelection(filters.storeId);
  canonicalStoreSelection(storeId);
  const status = filters.status ?? 'all';
  const workflow = filters.workflow ?? 'all';
  const card = filters.card ?? 'all';
  if (!['all', 'refunded', 'reimbursed', 'already_returned'].includes(card)) throw new TypeError('Filtro de resumo inválido.');
  if (!['all', 'active', 'finalized'].includes(workflow)) throw new TypeError('Filtro de acompanhamento inválido.');
  if (!['all', 'refunded', 'without_refund'].includes(status)) throw new TypeError('Filtro de reembolso inválido.');
  const from = filterBoundary(filters.from, false);
  const to = filterBoundary(filters.to, true);
  if (from && to && from >= to) throw new TypeError('Período inválido.');
  const query = String(filters.query ?? '').trim().toLocaleLowerCase('pt-BR');
  const orders = db.prepare(`SELECT entities.store_id,entities.source_id,entities.observed_at,entities.payload_json,
    stores.name AS store_name FROM entities JOIN stores ON stores.store_id=entities.store_id
    WHERE entities.source='orders' AND (? IS NULL OR entities.store_id IN (SELECT value FROM json_each(?)))`).all(...storeArgs(storeId));
  const transactions = db.prepare(`SELECT store_id,payload_json FROM entities WHERE source='transactions'
    AND (? IS NULL OR store_id IN (SELECT value FROM json_each(?)))`).all(...storeArgs(storeId)).map(row => ({ ...JSON.parse(row.payload_json), storeId: row.store_id }));
  const transactionEligibility = transactionFinancialEligibility(transactions,
    orders.map(row => ({ ...JSON.parse(row.payload_json), storeId: row.store_id })));
  let rows = [];
  for (const record of orders) {
    const order = JSON.parse(record.payload_json);
    if (order.fulfillmentMode !== 'DBA') continue;
    const history = trackingHistoryForOrder(db, record, order);
    const returned = history.states.filter(item => item.episode).sort((a, b) => a.episode.detectedAt.localeCompare(b.episode.detectedAt) || a.key.localeCompare(b.key));
    if (!returned.length) continue;
    const first = returned[0];
    const episode = first.episode;
    const currentReturnedPackageCount = returned.filter(item => item.detailedStatus === RETURNED).length;
    const linkedTransactions = transactions.filter(item => item.storeId === record.store_id && item.orderIds?.includes(order.orderId));
    const excludedRefund = linkedTransactions.some(item => item.type === 'Refund'
      && transactionEligibility.excludedKeys.has(JSON.stringify([item.storeId, item.transactionId])));
    const financialEligibility = excludedRefund ? { included: false, reason: 'payment-pending' } : orderFinancialEligibility(order);
    const refund = { ...refundEvidence(linkedTransactions), financialEligibility };
    refund.transactions = refund.transactions.map(item => ({ ...item, financialEligibility }));
    const searchable = [order.orderId, record.store_name, ...(order.items ?? []).flatMap(item => [item.sku, item.asin, item.title]),
      ...history.states.flatMap(item => [item.packageReferenceId, item.trackingNumber])].filter(Boolean).join(' ').toLocaleLowerCase('pt-BR');
    if ((query && !searchable.includes(query)) || (from && episode.detectedAt < from) || (to && episode.detectedAt >= to)) continue;
    if (status !== 'all' && !financialEligibility.included
      || (status === 'refunded' && refund.status !== 'recorded') || (status === 'without_refund' && refund.status !== 'not-found')) continue;
    rows.push({ storeId: record.store_id, storeName: record.store_name, orderId: order.orderId,
      orderStatus: order.status ?? null, fulfillmentMode: 'DBA', createdAt: order.createdAt ?? null, financialEligibility,
      trackingNumber: first.trackingNumber, status: first.status, detailedStatus: first.detailedStatus,
      occurrenceId: hash(`${record.store_id}\u0000${order.orderId}\u0000${first.key}`), ...episode,
      returnedPackageCount: returned.length, packageCount: history.packageCount,
      partialReturn: returned.length < history.packageCount, currentReturnedPackageCount,
      returnStatusChanged: currentReturnedPackageCount < returned.length,
      statusObservedAt: first.statusObservedAt, refund, alert: alertFor(episode, refund, appliedPolicy, generatedAt) });
  }
  rows.sort((a, b) => a.detectedAt.localeCompare(b.detectedAt) || a.storeId.localeCompare(b.storeId) || a.orderId.localeCompare(b.orderId));
  const projection = projectLocalReviews(db, 'returns', rows, row => row.orderId, filters.reviewStatus);
  const credits = reimbursementIndex(transactions.filter(item => !transactionEligibility.excludedKeys.has(JSON.stringify([item.storeId, item.transactionId]))));
  rows = projection.items.map(row => ({ ...row,
    review: returnedManagement(db, row.storeId, row.orderId, row.review),
    reimbursement: reimbursement(row.financialEligibility.included ? credits.get(JSON.stringify([row.storeId, row.orderId])) : []) }));
  const workflowCounts = { all: rows.length, active: rows.filter(row => row.review.workflowState === 'active').length,
    finalized: rows.filter(row => row.review.workflowState === 'finalized').length };
  rows = rows.filter(row => workflow === 'all' || row.review.workflowState === workflow);
  const summary = { total: rows.length, withRefund: rows.filter(item => item.financialEligibility.included && item.refund.status === 'recorded').length,
    withoutRefundEvidence: rows.filter(item => item.financialEligibility.included && item.refund.status === 'not-found').length,
    excludedPaymentPendingCount: rows.filter(item => !item.financialEligibility.included).length,
    transitions: rows.filter(item => item.detectionKind === 'transition').length,
    alreadyReturned: rows.filter(item => item.detectionKind === 'already-returned').length,
    withReimbursement: rows.filter(row => row.reimbursement.identified).length };
  // Keep the queue's card counts stable while filtering all matching rows before pagination.
  rows = rows.filter(row => card === 'all'
    || (card === 'refunded' && row.financialEligibility.included && row.refund.status === 'recorded')
    || (card === 'reimbursed' && row.reimbursement.identified)
    || (card === 'already_returned' && row.detectionKind === 'already-returned'));
  const offset = Math.max(0, Number.isSafeInteger(Number(filters.offset)) ? Number(filters.offset) : 0);
  const limit = Math.max(1, Math.min(500, Number.isSafeInteger(Number(filters.limit)) && Number(filters.limit) > 0 ? Number(filters.limit) : 100));
  return { items: rows.slice(offset, offset + limit), total: rows.length, offset, limit, hasMore: offset + limit < rows.length,
    summary: { ...summary, workflowCounts }, policy: appliedPolicy, generatedAt, reviewStatusOptions: projection.reviewStatusOptions, reviewStatuses: projection.reviewStatuses };
}
