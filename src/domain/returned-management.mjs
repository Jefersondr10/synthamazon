import { storeArgs } from './store-filter.mjs';
import { ensureLocalReviewSchema, getLocalReview } from './local-reviews.mjs';
import { validateReviewStatus, refundManagementStatuses, safeTGrantedEvidence } from './review-statuses.mjs';

const fail = code => Object.assign(new Error(code), { code });
const initialized = new WeakSet();
export function ensureReturnedManagementSchema(db) {
  if (initialized.has(db)) return;
  ensureLocalReviewSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS returned_management (
    store_id TEXT NOT NULL,order_id TEXT NOT NULL,workflow TEXT NOT NULL,
    case_id TEXT NOT NULL,finalized_at TEXT,PRIMARY KEY(store_id,order_id));
    CREATE TABLE IF NOT EXISTS returned_management_history (
    store_id TEXT NOT NULL,order_id TEXT NOT NULL,version INTEGER NOT NULL,
    action TEXT NOT NULL,changes_json TEXT NOT NULL,changed_at TEXT NOT NULL,
    PRIMARY KEY(store_id,order_id,version));`);
  if (!db.prepare('PRAGMA table_info(returned_management)').all().some(column => column.name === 'safe_t_status_evidence')) {
    db.exec('ALTER TABLE returned_management ADD COLUMN safe_t_status_evidence TEXT');
  }
  initialized.add(db);
}

export function returnedManagementIndex(db, storeId) {
  ensureReturnedManagementSchema(db);
  return new Map(db.prepare(`SELECT store_id,order_id,workflow,case_id AS caseId,finalized_at AS finalizedAt FROM returned_management
    WHERE (? IS NULL OR store_id IN (SELECT value FROM json_each(?)))`).all(...storeArgs(storeId)).map(row=>[JSON.stringify([row.store_id,row.order_id]),row]));
}

export function returnedManagement(db, storeId, orderId, review, snapshot = undefined) {
  ensureReturnedManagementSchema(db);
  const saved = snapshot === undefined ? db.prepare('SELECT workflow,case_id AS caseId,finalized_at AS finalizedAt FROM returned_management WHERE store_id=? AND order_id=?').get(storeId, orderId) : snapshot;
  // Preserve the intent of legacy reviews explicitly marked as resolved.
  return { ...review, workflowState: saved?.workflow ?? (review.closesCase ? 'finalized' : 'active'),
    caseId: saved?.caseId ?? '', finalizedAt: saved ? saved.finalizedAt : review.closesCase ? review.updatedAt : null };
}

export function validateReturnedAction(input) {
  const fields = ['action', 'items', 'status', 'notes', 'note', 'caseId'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))
    || !['edit', 'finalize', 'reopen'].includes(input.action) || !Array.isArray(input.items) || !input.items.length || input.items.length > 100) throw fail('INVALID_REVIEW');
  const seen = new Set();
  for (const item of input.items) {
    if (!item || typeof item !== 'object' || Object.keys(item).some(key => !['storeId','orderId','expectedVersion'].includes(key))
      || typeof item.storeId !== 'string' || item.storeId === 'all' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(item.storeId)
      || typeof item.orderId !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(item.orderId)
      || !Number.isSafeInteger(item.expectedVersion) || item.expectedVersion < 0 || item.expectedVersion >= Number.MAX_SAFE_INTEGER) throw fail('INVALID_REVIEW');
    const key = JSON.stringify([item.storeId, item.orderId]);
    if (seen.has(key)) throw fail('INVALID_REVIEW');
    seen.add(key);
  }
  for (const field of ['status', 'notes', 'note', 'caseId']) {
    if (!Object.hasOwn(input, field)) continue;
    const max = field === 'caseId' ? 30 : field === 'status' ? 50 : 2000;
    if (typeof input[field] !== 'string' || input[field].length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input[field])) throw fail('INVALID_REVIEW');
  }
  if (Object.hasOwn(input, 'caseId') && !/^\d{0,30}$/.test(input.caseId)
    || input.items.length > 1 && ['caseId', 'notes'].some(field => Object.hasOwn(input, field))
    || Object.hasOwn(input, 'note') && Object.hasOwn(input, 'notes')
    || Object.hasOwn(input, 'status') && !/^[a-z][a-z0-9_]{0,49}$/.test(input.status)
    || input.action === 'reopen' && fields.slice(2).some(field => Object.hasOwn(input, field))) throw fail('INVALID_REVIEW');
  if (input.action === 'finalize' && !input.status) throw fail('FINALIZATION_STATUS_REQUIRED');
  return input;
}

/** One transaction and one shared review version for the entire selection. */
export function saveReturnedManagement(db, input, now = new Date(), { automaticSafeT = false, safeTEvidence = null } = {}) {
  validateReturnedAction(input);
  ensureReturnedManagementSchema(db);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw fail('INVALID_REVIEW');
  const at = now.toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const rows = input.items.map(item => {
      const identity = { menu: 'returns', storeId: item.storeId, entityId: item.orderId };
      const previous = returnedManagement(db, item.storeId, item.orderId, getLocalReview(db, identity));
      if (previous.version !== item.expectedVersion) throw fail('REVIEW_CONFLICT');
      if (input.action === 'finalize' && previous.workflowState !== 'active' || input.action === 'reopen' && previous.workflowState !== 'finalized') throw fail('WORKFLOW_CONFLICT');
      const status = input.status ?? previous.status;
      validateReviewStatus(db, 'returns', status, { previousStatus: previous.status });
      const notes = input.notes ?? (input.note?.trim() ? [previous.notes, input.note.trim()].filter(Boolean).join('\n\n') : previous.notes);
      if (notes.length > 2000) throw fail('INVALID_REVIEW');
      return { item, previous, next: { status, notes, caseId: input.caseId ?? previous.caseId,
        workflowState: input.action === 'finalize' ? 'finalized' : input.action === 'reopen' ? 'active' : previous.workflowState,
        finalizedAt: input.action === 'finalize' ? at : input.action === 'reopen' ? null : previous.finalizedAt } };
    });
    for (const { item, previous, next } of rows) {
      const version = previous.version + 1;
      db.prepare(`INSERT INTO local_reviews(menu,store_id,entity_id,status,notes,version,updated_at) VALUES('returns',?,?,?,?,?,?)
        ON CONFLICT(menu,store_id,entity_id) DO UPDATE SET status=excluded.status,notes=excluded.notes,version=excluded.version,updated_at=excluded.updated_at`)
        .run(item.storeId,item.orderId,next.status,next.notes,version,at);
      db.prepare('INSERT INTO local_review_history VALUES(?,?,?,?,?,?,?,?,?)')
        .run('returns',item.storeId,item.orderId,version,previous.status,next.status,previous.notes,next.notes,at);
      db.prepare(`INSERT INTO returned_management(store_id,order_id,workflow,case_id,finalized_at) VALUES(?,?,?,?,?) ON CONFLICT(store_id,order_id)
        DO UPDATE SET workflow=excluded.workflow,case_id=excluded.case_id,finalized_at=excluded.finalized_at`)
        .run(item.storeId,item.orderId,next.workflowState,next.caseId,next.finalizedAt);
      if (automaticSafeT) db.prepare('UPDATE returned_management SET safe_t_status_evidence=? WHERE store_id=? AND order_id=?').run(safeTEvidence,item.storeId,item.orderId);
      db.prepare('INSERT INTO returned_management_history VALUES(?,?,?,?,?,?)')
        .run(item.storeId,item.orderId,version,automaticSafeT ? 'automatic-safe-t-granted' : input.action,JSON.stringify({ before: previous, after: next }),at);
    }
    db.exec('COMMIT');
    return { updated: rows.length };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

/** Uses only the released, unambiguously linked credits from reimbursementIndex. */
export function syncReturnedSafeTGranted(db, rows, now = new Date()) {
  ensureReturnedManagementSchema(db);
  const status = refundManagementStatuses(db).find(item => item.semanticRole === 'safe_t_granted' && item.active && item.menus.includes('returns'));
  if (!status) return;
  for (const row of rows) {
    const evidence = row.financialEligibility?.included === false ? null : safeTGrantedEvidence(row.reimbursement?.credits);
    if (!evidence || db.prepare('SELECT safe_t_status_evidence FROM returned_management WHERE store_id=? AND order_id=?').get(row.storeId,row.orderId)?.safe_t_status_evidence === evidence) continue;
    const current = getLocalReview(db, { menu: 'returns', storeId: row.storeId, entityId: row.orderId });
    saveReturnedManagement(db, { action: 'edit', items: [{ storeId: row.storeId, orderId: row.orderId, expectedVersion: current.version }], status: status.code },
      now instanceof Date ? now : new Date(now), { automaticSafeT: true, safeTEvidence: evidence });
  }
}
