function validStoreSelection(value) { try { parseStoreSelection(value); return typeof value === 'string'; } catch { return false; } }
import { parseStoreSelection, storeArgs } from './store-filter.mjs';
import { createHash } from 'node:crypto';
import { refundManagementStatuses, statusDefinition, safeTGrantedEvidence } from './review-statuses.mjs';
import { buildReturnSignals, customerReturnLink, returnedToSellerLink } from './return-signals.mjs';
import { ORDER_STATUS_CATALOG } from './order-status.mjs';
import { orderFinancialEligibility } from './financial-eligibility.mjs';
import { ensureSafeTClaimsSchema, safeTClaimMetadata } from './safe-t-claims.mjs';

export const MANAGEMENT_MENU = 'refund-management';
export const managementError = code => Object.assign(new Error(code), { code });
export const cents = value => typeof value === 'string' && /^-?\d{1,2048}$/.test(value) ? BigInt(value) : null;
const key = (storeId, orderId) => JSON.stringify([storeId, orderId]);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const storePattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const idPattern = /^management-[a-f0-9]{64}$/;
const clean = value => String(value ?? '').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('pt-BR');
const localDay = value => new Date(Date.parse(value) - 3 * 3600000).toISOString().slice(0,10);
export const DEADLINE_POLICY = Object.freeze({ kind: 'internal-reference', days: 50,
  label: 'Data SAFE-T: 45 dias após o reembolso no status Aguardando reembolso FBA (45 dias); 50 dias para DBA ou acompanhamento comum; 60 dias para reembolso proativo ou Devolução de cliente · SAFE-T 60 dias. Referência de acompanhamento. Não confirma prazo nem elegibilidade da Amazon.' });
const PROACTIVE_REFUND_POLICY = Object.freeze({ kind: 'proactive-refund', days: 60,
  label: 'Reembolso proativo da Amazon',
  description: '60 dias após a data original conhecida do reembolso ao cliente.' });
const PROACTIVE_DBA_REFUND_POLICY = Object.freeze({ kind: 'proactive-dba-refund', days: 50,
  label: 'SAFE-T encerrado · reembolso proativo DBA',
  description: '50 dias após a data original do reembolso ao cliente. Aguardar o reembolso informado pela Amazon enquanto a devolução continuar sem entrega.' });
const FBA_REFUND_POLICY = Object.freeze({ kind: 'fba-refund', days: 45,
  label: 'Aguardando reembolso FBA · 45 dias',
  description: '45 dias após a data original conhecida do reembolso ao cliente. Referência interna de acompanhamento do reembolso FBA.' });
const CUSTOMER_RETURN_WAIT_POLICY = Object.freeze({ kind: 'customer-return-wait', days: 60,
  label: 'Devolução de cliente · SAFE-T 60 dias',
  description: 'Devolução aberta pelo cliente, não devolvida ou com problema pendente. Aguardar para solicitar SAFE-T. Referência interna: 60 dias após a data original conhecida do reembolso ao cliente, conforme o prazo de espera informado no atendimento.' });

export function managementIdentity(storeId, managementId) {
  if (!storePattern.test(storeId ?? '') || storeId === 'all' || !idPattern.test(managementId ?? '')) throw managementError('INVALID_MANAGEMENT');
}
export function managementInstant(value = new Date()) {
  const result = value instanceof Date ? value : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) ? new Date(value) : null;
  if (!result || !Number.isFinite(result.getTime())) throw managementError('INVALID_MANAGEMENT');
  return result.toISOString();
}
export function ensureRefundManagementSchema(db) {
  ensureSafeTClaimsSchema(db);
  refundManagementStatuses(db);
  db.exec(`CREATE TABLE IF NOT EXISTS refund_management (
    store_id TEXT NOT NULL,order_id TEXT NOT NULL,management_id TEXT NOT NULL,
    source_json TEXT NOT NULL,source_fingerprint TEXT NOT NULL,source_missing INTEGER NOT NULL DEFAULT 0,
    status TEXT,workflow_state TEXT NOT NULL,short_note TEXT NOT NULL DEFAULT '',case_id TEXT NOT NULL DEFAULT '',
    safe_t_id TEXT NOT NULL DEFAULT '',return_tracking TEXT NOT NULL DEFAULT '',confirmed_json TEXT NOT NULL DEFAULT '[]',
    confirmed_at TEXT,finalized_at TEXT,finalization_reason TEXT,version INTEGER NOT NULL,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    PRIMARY KEY(store_id,order_id),UNIQUE(store_id,management_id));
    CREATE TABLE IF NOT EXISTS refund_management_history (
    store_id TEXT NOT NULL,management_id TEXT NOT NULL,version INTEGER NOT NULL,event_type TEXT NOT NULL,
    changes_json TEXT NOT NULL,changed_at TEXT NOT NULL,PRIMARY KEY(store_id,management_id,version));
    CREATE TABLE IF NOT EXISTS refund_management_notes (
    store_id TEXT NOT NULL,management_id TEXT NOT NULL,version INTEGER NOT NULL,note TEXT NOT NULL,
    created_at TEXT NOT NULL,PRIMARY KEY(store_id,management_id,version));`);
  if (!db.prepare('PRAGMA table_info(refund_management)').all().some(column => column.name === 'safe_t_status_evidence')) {
    db.exec('ALTER TABLE refund_management ADD COLUMN safe_t_status_evidence TEXT');
  }
}
export function readManagementRow(db, storeId, managementId) {
  return db.prepare('SELECT * FROM refund_management WHERE store_id=? AND management_id=?').get(storeId, managementId);
}
export function managementHistory(db, { storeId, managementId, version, type, changes, now, note }) {
  db.prepare('INSERT INTO refund_management_history VALUES(?,?,?,?,?,?)').run(storeId, managementId, version, type, JSON.stringify(changes), now);
  if (note) db.prepare('INSERT INTO refund_management_notes VALUES(?,?,?,?,?)').run(storeId, managementId, version, note, now);
}
export function sumCurrency(rows) {
  const values = new Map();
  for (const row of rows) {
    if (!/^[A-Z]{3}$/.test(row?.currency ?? '')) continue;
    const item = values.get(row.currency) ?? { currency: row.currency, total: 0n, unknown: false };
    const value = cents(row.totalCents); if (value === null) item.unknown = true; else item.total += value;
    values.set(row.currency, item);
  }
  return [...values.values()].sort((a, b) => a.currency.localeCompare(b.currency))
    .map(item => ({ currency: item.currency, totalCents: item.unknown ? null : item.total.toString(), knownTotalCents: item.total.toString() }));
}
function absoluteRefund(rows) {
  return rows.map(row => { const value = cents(row.totalCents); return { currency: row.currency, totalCents: value === null ? null : (value < 0n ? -value : 0n).toString() }; });
}
export function refundPaymentState(source, confirmed = []) {
  if (source.financialEligibility?.included === false) return { confirmationRequired: false, newByCurrency: [], confirmedByCurrency: confirmed,
    variance: { byCurrency: [], requiresAcknowledgement: false } };
  const confirmedMap = new Map(confirmed.map(row => [row.currency, cents(row.totalCents) ?? 0n]));
  const debits = new Map(source.refund.byCurrency.map(row => [row.currency, cents(row.totalCents)]));
  const next = [], variances = [];
  for (const row of source.payment.byCurrency) {
    const paid = cents(row.totalCents), debit = debits.get(row.currency);
    if (paid === null || paid <= 0n) continue;
    const delta = paid - (confirmedMap.get(row.currency) ?? 0n);
    if (delta > 0n) next.push({ currency: row.currency, totalCents: delta.toString() });
    const difference = debit === null || debit === undefined ? null : paid - debit;
    const important = difference !== null && (difference < 0n ? -difference : difference) >= 2000n;
    const kind = debit === null || debit === undefined || debit <= 0n || source.refund.allocation !== 'order' ? 'uncomparable'
      : important && paid * 100n <= debit * 80n ? 'much_lower'
        : important && paid * 100n >= debit * 120n ? 'much_higher' : 'within_range';
    variances.push({ currency: row.currency, kind, differenceCents: difference?.toString() ?? null,
      requiresAcknowledgement: kind !== 'within_range' });
  }
  return { confirmationRequired: next.length > 0, newByCurrency: next, confirmedByCurrency: confirmed,
    variance: { byCurrency: variances, requiresAcknowledgement: variances.some(row => row.requiresAcknowledgement) } };
}
function sourceFor(row, creditIndex, financialCaseIndex) {
  const credits = creditIndex.get(key(row.storeId, row.orderId)) ?? [];
  const types = [...new Map(credits.map(item => [item.type, { code: item.type, label: item.label }])).values()];
  const firstDates = (row.refundCaseIds ?? []).map(id => financialCaseIndex.get(key(row.storeId,id))?.firstEventAt).filter(Boolean).sort();
  const firstEventAt = firstDates[0] ?? row.refund.firstEventAt ?? row.refund.latestPostedAt ?? null;
  const customerReturns = row.customerReturns.map(item => customerReturnLink(item, row.orderId));
  const returnedToSeller = returnedToSellerLink(row.returnedToSeller, row.orderId);
  const financialEligibility = row.financialEligibility ?? orderFinancialEligibility(row.order);
  return { storeId: row.storeId, orderId: row.orderId, order: row.order ? { orderId: row.orderId,
    displayStatus: row.displayStatus, fulfillmentMode: row.fulfillmentMode } : null,
    products: row.products, fulfillmentMode: row.fulfillmentMode, displayStatus: row.displayStatus,
    financialEligibility,
    refund: { ...row.refund, netByCurrency: row.refund.source === 'financial-transactions' ? row.refund.byCurrency : [],
      reportedByCurrency: row.refund.source === 'return-report' ? row.refund.byCurrency : [],
      byCurrency: row.refund.source === 'return-report' ? row.refund.byCurrency.map(item => ({ currency:item.currency,totalCents:null })) : absoluteRefund(row.refund.byCurrency), firstEventAt,
      lastEventAt: row.refund.latestPostedAt },
    payment: { types, byCurrency: sumCurrency(credits), credits, lastCreditAt: credits.map(item => item.postedAt).filter(Boolean).sort().at(-1) ?? null },
    financialCaseIds: row.refundCaseIds,
    returnLinks: { customerReturns, returnedToSeller: returnedToSeller ? [returnedToSeller] : [] },
    returnSignals: buildReturnSignals({ customerReturns, returnedToSeller }),
    safeTDueAt: financialEligibility.included && row.refund.dateKnown && firstEventAt ? new Date(Date.parse(firstEventAt) + 50 * 86400000).toISOString() : null };
}
function evidence(source) {
  return { refund: source.refund.byCurrency, firstRefundDate: source.refund.firstEventAt, refundDate: source.refund.lastEventAt, allocation: source.refund.allocation,
    payment: source.payment.byCurrency, creditIds: source.payment.credits.map(item => item.eventId).sort() };
}
function increases(before, after) {
  const previous = new Map(before.map(row => [row.currency, cents(row.totalCents)]));
  return after.some(row => cents(row.totalCents) !== null && cents(row.totalCents) > (previous.get(row.currency) ?? 0n));
}

/** Explicit local sync only. It never modifies source finances or legacy reviews. */
export function syncRefundManagement({ db, rows, creditIndex = new Map(), financialCaseIndex = new Map(), storeIds, now = new Date() }) {
  ensureRefundManagementSchema(db);
  const timestamp = managementInstant(now), definitions = refundManagementStatuses(db);
  const newStatus = definitions.find(item => item.semanticRole === 'new' && item.active)?.code
    ?? definitions.find(item => item.active && !item.automatic && item.semanticRole !== 'concluded')?.code ?? null;
  const analysis = definitions.find(item => item.semanticRole === 'analysis' && item.active)?.code ?? newStatus;
  const granted = definitions.find(item => item.semanticRole === 'safe_t_granted' && item.active)?.code;
  const result = { created: 0, updated: 0, reopened: 0, missing: 0 };
  const incoming = new Set();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const item of rows) {
      if (!storeIds.includes(item.storeId)) throw managementError('INVALID_MANAGEMENT');
      const identity = key(item.storeId, item.orderId); if (incoming.has(identity)) continue; incoming.add(identity);
      const source = sourceFor(item, creditIndex, financialCaseIndex), fingerprint = hash(evidence(source));
      const grantedEvidence = granted && source.financialEligibility.included ? safeTGrantedEvidence(source.payment.credits) : null;
      const grantedStatus = grantedEvidence ? granted : null;
      const previous = db.prepare('SELECT * FROM refund_management WHERE store_id=? AND order_id=?').get(item.storeId, item.orderId);
      if (!previous) {
        const managementId = `management-${hash([item.storeId, item.orderId])}`;
        const legacy = (source.financialCaseIds ?? []).map(caseId => db.prepare("SELECT status FROM financial_case_reviews WHERE store_id=? AND kind='refunds' AND case_id=?").get(item.storeId, caseId)?.status).filter(Boolean);
        const safeLegacy = legacy.length === 1 && definitions.find(status => status.code === legacy[0] && status.active && !status.automatic);
        const status = grantedStatus ?? safeLegacy?.code ?? newStatus;
        db.prepare(`INSERT INTO refund_management(store_id,order_id,management_id,source_json,source_fingerprint,status,workflow_state,version,created_at,updated_at,safe_t_status_evidence)
          VALUES(?,?,?,?,?,?,'active',0,?,?,?)`).run(item.storeId, item.orderId, managementId, JSON.stringify(source), fingerprint, status, timestamp, timestamp, grantedEvidence);
        result.created++; continue;
      }
      const old = JSON.parse(previous.source_json), material = previous.source_fingerprint !== fingerprint;
      const reopen = source.financialEligibility.included && previous.workflow_state === 'finalized' && (increases(old.refund.byCurrency, source.refund.byCurrency)
        || old.refund.firstEventAt !== source.refund.firstEventAt || old.refund.lastEventAt !== source.refund.lastEventAt
        || increases(old.payment.byCurrency, source.payment.byCurrency));
      const status = grantedEvidence && grantedEvidence !== previous.safe_t_status_evidence ? grantedStatus : (reopen ? analysis : previous.status);
      const statusChanged = status !== previous.status;
      const version = previous.version + Number(material || statusChanged);
      db.prepare(`UPDATE refund_management SET source_json=?,source_fingerprint=?,source_missing=0,status=?,workflow_state=?,
        finalized_at=?,finalization_reason=?,version=?,updated_at=?,safe_t_status_evidence=? WHERE store_id=? AND order_id=?`)
        .run(JSON.stringify(source), fingerprint, status, reopen ? 'active' : previous.workflow_state,
          reopen ? null : previous.finalized_at, reopen ? null : previous.finalization_reason, version,
          material || statusChanged ? timestamp : previous.updated_at, grantedEvidence ?? previous.safe_t_status_evidence, item.storeId, item.orderId);
      if (material || statusChanged) {
        managementHistory(db, { storeId: item.storeId, managementId: previous.management_id, version,
          type: reopen ? 'automatic-reopen' : statusChanged && grantedStatus ? 'automatic-safe-t-granted' : 'financial-update', now: timestamp,
          changes: { previous: evidence(old), current: evidence(source), previousFinalizationReason: previous.finalization_reason,
            ...(statusChanged ? { previousStatus: previous.status, status, ...(grantedStatus ? { statusReason: 'released-safe-t-credit' } : {}) } : {}) } });
        result.updated++; if (reopen) result.reopened++;
      }
    }
    for (const storeId of storeIds) for (const row of db.prepare('SELECT order_id,source_missing FROM refund_management WHERE store_id=?').all(storeId)) {
      if (!incoming.has(key(storeId, row.order_id)) && !row.source_missing) {
        db.prepare('UPDATE refund_management SET source_missing=1 WHERE store_id=? AND order_id=?').run(storeId, row.order_id); result.missing++;
      }
    }
    db.exec('COMMIT'); return result;
  } catch (failure) { db.exec('ROLLBACK'); throw failure; }
}

export function presentManagement(db, row) {
  const source = JSON.parse(row.source_json), definition = statusDefinition(db,row.status);
  const role = db.prepare('SELECT semantic_role FROM refund_management_status_roles WHERE status_code=?').get(row.status)?.semantic_role;
  const deadlinePolicy = role === 'awaiting_proactive_dba_refund' ? PROACTIVE_DBA_REFUND_POLICY
    : role === 'awaiting_proactive_refund' ? PROACTIVE_REFUND_POLICY
      : role === 'awaiting_fba_refund' ? FBA_REFUND_POLICY
        : role === 'awaiting_customer_return' ? CUSTOMER_RETURN_WAIT_POLICY : DEADLINE_POLICY;
  const refundDate = Date.parse(source.refund.firstEventAt);
  const safeTDueAt = source.financialEligibility?.included !== false && source.refund.dateKnown && Number.isFinite(refundDate)
    ? new Date(refundDate + deadlinePolicy.days * 86400000).toISOString() : null;
  return { ...source, safeTDueAt, managementId: row.management_id, sourceMissing: Boolean(row.source_missing), deadlinePolicy,
    payment: { ...source.payment, ...refundPaymentState(source, JSON.parse(row.confirmed_json)), confirmedAt: row.confirmed_at },
    management: { status: row.status, label: definition?.label ?? row.status ?? 'Sem status', color: definition?.color ?? 'neutral',
      latestNote: db.prepare('SELECT note FROM refund_management_notes WHERE store_id=? AND management_id=? ORDER BY version DESC LIMIT 1').get(row.store_id,row.management_id)?.note ?? '',
      workflowState: row.workflow_state, shortNote: row.short_note, caseId: row.case_id, ...safeTClaimMetadata(db, row),
      returnTracking: row.return_tracking, version: row.version, updatedAt: row.updated_at, finalizedAt: row.finalized_at, finalizationReason: row.finalization_reason } };
}
export function refundManagementDetail(db, storeId, managementId) {
  managementIdentity(storeId, managementId);
  const row = readManagementRow(db, storeId, managementId); if (!row) return null;
  const item = presentManagement(db, row);
  return { ...item, reviewStatuses: refundManagementStatuses(db).filter(status => status.active && !status.automatic),
    history: db.prepare('SELECT version,event_type AS type,changes_json,changed_at AS changedAt FROM refund_management_history WHERE store_id=? AND management_id=? ORDER BY version').all(storeId, managementId)
      .map(({ changes_json, ...entry }) => ({ ...entry, changes: JSON.parse(changes_json) })),
    notes: db.prepare('SELECT version,note,created_at AS createdAt FROM refund_management_notes WHERE store_id=? AND management_id=? ORDER BY version').all(storeId, managementId).map(entry => ({ ...entry })),
    legacyReviews: (item.financialCaseIds ?? []).flatMap(caseId => {
      const review = db.prepare("SELECT status,notes,version,updated_at AS updatedAt FROM financial_case_reviews WHERE store_id=? AND kind='refunds' AND case_id=?").get(storeId, caseId);
      return review ? [{ caseId, review: { ...review }, history: db.prepare("SELECT version,previous_status AS previousStatus,status,previous_notes AS previousNotes,notes,changed_at AS changedAt FROM financial_case_review_history WHERE store_id=? AND kind='refunds' AND case_id=? ORDER BY version").all(storeId, caseId).map(value => ({ ...value })) }] : [];
    }) };
}

function filtersChecked(filters) {
  const permitted = ['storeId','from','to','query','mode','status','orderStatus','workflow','returnFilter','payment','deadline','sort','direction','limit','offset'];
  if (Object.keys(filters).some(key => !permitted.includes(key))) throw managementError('INVALID_PARAMETERS');
  let orderStatuses = null;
  if (filters.orderStatus !== undefined) {
    if (typeof filters.orderStatus !== 'string' || filters.orderStatus.length > 2549) throw managementError('INVALID_PARAMETERS');
    const values = filters.orderStatus.split(',');
    if (values.length > 50 || values.some(code => !/^[A-Za-z_]{1,50}$/.test(code))) throw managementError('INVALID_PARAMETERS');
    const selected = new Set(values.map(code => code.toUpperCase()));
    if (selected.size !== values.length || selected.has('ALL') && selected.size !== 1) throw managementError('INVALID_PARAMETERS');
    if (!selected.has('ALL')) orderStatuses = selected;
  }
  const option = (key, fallback, choices) => { const value = filters[key] ?? fallback; if (!choices.includes(value)) throw managementError('INVALID_PARAMETERS'); return value; };
  const boundary = (value, end) => {
    if (value === undefined) return null;
    if (typeof value !== 'string') throw managementError('INVALID_PARAMETERS');
    const day = /^\d{4}-\d{2}-\d{2}$/.test(value), parsed = Date.parse(day ? `${value}T00:00:00-03:00` : value);
    if (!Number.isFinite(parsed) || day && new Date(parsed).toISOString().slice(0,10) !== value) throw managementError('INVALID_PARAMETERS');
    return new Date(parsed + (day && end ? 86400000 : 0)).toISOString();
  };
  const from = boundary(filters.from, false), to = boundary(filters.to, true);
  if (from && to && from >= to || filters.storeId !== undefined && !validStoreSelection(filters.storeId)
    || filters.query !== undefined && (typeof filters.query !== 'string' || filters.query.length > 200)
    || filters.status !== undefined && (typeof filters.status !== 'string' || !/^[a-z][a-z0-9_]{0,49}$/.test(filters.status))) throw managementError('INVALID_PARAMETERS');
  const limit = Number(filters.limit ?? 100), offset = Number(filters.offset ?? 0);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw managementError('INVALID_PARAMETERS');
  return { ...filters, from, to, limit, offset, orderStatuses, query: clean(filters.query), mode: option('mode','all',['all','FBA','DBA','MFN','unknown']),
    workflow: option('workflow','active',['all','active','finalized']), returnFilter: option('returnFilter','all',['all','withReturn','withoutReturn']),
    payment: option('payment','all',['all','pending','paid','unpaid','variance']), deadline: option('deadline','all',['all','upcoming','overdue']),
    sort: option('sort',filters.deadline === 'upcoming' ? 'safeTDate' : 'refundDate',['refundDate','safeTDate']),
    direction: option('direction',filters.deadline === 'upcoming' ? 'asc' : 'desc',['asc','desc']), status: filters.status ?? 'all' };
}
export function refundManagementView(db, filters = {}, now = new Date()) {
  const f = filtersChecked(filters), timestamp = managementInstant(now), definitions = refundManagementStatuses(db);
  const today = localDay(timestamp), overdue = row => Boolean(row.safeTDueAt && localDay(row.safeTDueAt) < today);
  const selectedDefinition = definitions.find(item => item.code === f.status);
  let rows = db.prepare('SELECT * FROM refund_management WHERE (? IS NULL OR store_id IN (SELECT value FROM json_each(?)))')
    .all(...storeArgs(f.storeId)).map(row => presentManagement(db, row));
  if (!['all','none'].includes(f.status) && !selectedDefinition && !rows.some(row => row.management.status === f.status)) throw managementError('INVALID_PARAMETERS');
  for (const row of rows) if (row.management.status && !definitions.some(item => item.code === row.management.status)) {
    definitions.push({ code:row.management.status,label:row.management.label,color:row.management.color,active:false,automatic:false });
  }
  rows = rows.filter(row => (!f.from && !f.to || row.refund.firstEventAt && (!f.from || row.refund.firstEventAt >= f.from) && (!f.to || row.refund.firstEventAt < f.to))
    && (f.mode === 'all' || row.fulfillmentMode === f.mode)
    && (!f.query || clean([row.orderId,row.management.caseId,row.management.safeTId,row.management.shortNote,row.management.returnTracking,
      ...db.prepare('SELECT note FROM refund_management_notes WHERE store_id=? AND management_id=?').all(row.storeId,row.managementId).map(item => item.note),
      ...row.products.flatMap(item => [item.sku,item.asin,item.title])].join(' ')).includes(f.query))
    && (f.returnFilter === 'all' || Boolean(row.returnLinks.customerReturns.length || row.returnLinks.returnedToSeller.length) === (f.returnFilter === 'withReturn'))
    && (f.payment === 'all' || row.financialEligibility?.included !== false && (f.payment === 'pending' && row.payment.confirmationRequired
      || f.payment === 'paid' && row.payment.byCurrency.some(value => cents(value.totalCents) > 0n) && !row.payment.confirmationRequired
      || f.payment === 'unpaid' && !row.payment.byCurrency.some(value => cents(value.totalCents) > 0n)
      || f.payment === 'variance' && row.payment.variance.requiresAcknowledgement))
    && (f.deadline === 'all' || row.safeTDueAt && (f.deadline === 'overdue' ? overdue(row) : !overdue(row))));
  const statusMatch = (row, code) => code === 'all' || code === 'none' && row.management.status === null
    || row.financialEligibility?.included !== false && definitions.find(item => item.code === code)?.semanticRole === 'safe_t_received' && row.payment.types.some(type => type.code === 'safe_t')
    || row.financialEligibility?.included !== false && definitions.find(item => item.code === code)?.semanticRole === 'easy_ship_received' && row.payment.types.some(type => type.code === 'easy_ship')
    || row.management.status === code;
  const orderStatusCounts = new Map();
  for (const row of rows.filter(row => statusMatch(row, f.status) && (f.workflow === 'all' || row.management.workflowState === f.workflow))) {
    const { code, label } = row.displayStatus ?? ORDER_STATUS_CATALOG.UNKNOWN;
    const option = orderStatusCounts.get(code) ?? { code, label, count: 0 };
    option.count++; orderStatusCounts.set(code, option);
  }
  const orderStatusOptions = [...orderStatusCounts.values()].sort((a, b) => a.code === 'UNKNOWN' ? 1 : b.code === 'UNKNOWN' ? -1 : a.label.localeCompare(b.label, 'pt-BR'));
  rows = rows.filter(row => f.orderStatuses === null || f.orderStatuses.has(String(row.displayStatus?.code ?? 'UNKNOWN').toUpperCase()));
  const byStatus = rows.filter(row => statusMatch(row, f.status));
  const workflowCounts = { all: byStatus.length, active: byStatus.filter(row => row.management.workflowState === 'active').length,
    finalized: byStatus.filter(row => row.management.workflowState === 'finalized').length };
  const byWorkflow = rows.filter(row => f.workflow === 'all' || row.management.workflowState === f.workflow);
  const statusOptions = [{ code: 'none', label: 'Sem status', color: 'neutral' }, ...definitions]
    .map(item => ({ code: item.code, label: item.label, color: item.color, automatic: item.automatic ?? false, count: byWorkflow.filter(row => statusMatch(row, item.code)).length }));
  const selected = byStatus.filter(row => f.workflow === 'all' || row.management.workflowState === f.workflow)
    .sort((a,b) => {
      const left = f.sort === 'safeTDate' ? a.safeTDueAt : a.refund.firstEventAt;
      const right = f.sort === 'safeTDate' ? b.safeTDueAt : b.refund.firstEventAt;
      return left === null && right !== null ? 1 : right === null && left !== null ? -1
        : (f.direction === 'asc' ? 1 : -1) * String(left ?? '').localeCompare(String(right ?? '')) || a.managementId.localeCompare(b.managementId);
    });
  const active = selected.filter(row => row.management.workflowState === 'active');
  const financialActive = active.filter(row => row.financialEligibility?.included !== false);
  return { items: selected.slice(f.offset, f.offset + f.limit), total: selected.length, offset: f.offset, limit: f.limit,
    hasMore: f.offset + f.limit < selected.length, statusOptions, orderStatusOptions, reviewStatuses: definitions.filter(item => item.active && !item.automatic),
    summary: { workflowCounts, activeCount: active.length, activeRefundByCurrency: sumCurrency(financialActive.flatMap(row => row.refund.byCurrency)),
      excludedPendingCaseCount: selected.filter(row => row.financialEligibility?.included === false).length,
      paymentAlertCount: financialActive.filter(row => row.payment.confirmationRequired).length,
      paymentDetectedByCurrency: sumCurrency(financialActive.flatMap(row => row.payment.newByCurrency)),
      overdueSafeTCount: financialActive.filter(row => overdue(row)
        && !row.payment.byCurrency.some(item => cents(item.totalCents) > 0n)).length },
    deadlinePolicy: DEADLINE_POLICY, dateBasis: 'refund-original-event' };
}
