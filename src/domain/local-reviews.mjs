import { ensureReviewStatusSchema, statusDefinition, validateReviewStatus, reviewStatusSettings } from './review-statuses.mjs';

const MENUS = new Set(['orders', 'customer-returns', 'returns']);
const failure = code => Object.assign(new Error(code), { code });
function identity({ menu, storeId, entityId } = {}) {
  if (!MENUS.has(menu) || typeof storeId !== 'string' || storeId === 'all' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(storeId)
    || typeof entityId !== 'string' || !(menu === 'customer-returns' ? /^return-[a-f0-9]{64}$/ : /^[A-Za-z0-9-]{1,80}$/).test(entityId)) throw failure('INVALID_REVIEW');
}
function timestamp(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    || hour > 23 || minute > 59 || second > 59 || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

/** Manual work only. No writes, foreign keys or cascades to imported evidence. */
export function ensureLocalReviewSchema(db) {
  ensureReviewStatusSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS local_reviews (
    menu TEXT NOT NULL,store_id TEXT NOT NULL,entity_id TEXT NOT NULL,status TEXT NOT NULL,
    notes TEXT NOT NULL,version INTEGER NOT NULL,updated_at TEXT NOT NULL,
    PRIMARY KEY(menu,store_id,entity_id));
    CREATE TABLE IF NOT EXISTS local_review_history (
    menu TEXT NOT NULL,store_id TEXT NOT NULL,entity_id TEXT NOT NULL,version INTEGER NOT NULL,
    previous_status TEXT NOT NULL,status TEXT NOT NULL,previous_notes TEXT NOT NULL,notes TEXT NOT NULL,changed_at TEXT NOT NULL,
    PRIMARY KEY(menu,store_id,entity_id,version));`);
}
function current(db, { menu, storeId, entityId }) {
  const row = db.prepare('SELECT status,notes,version,updated_at AS updatedAt FROM local_reviews WHERE menu=? AND store_id=? AND entity_id=?').get(menu, storeId, entityId);
  return presentReview(row, statusDefinition(db, row?.status ?? 'pending'));
}
function presentReview(row, definition) {
  const review = row ?? { status: 'pending', notes: '', version: 0, updatedAt: null };
  return { status: review.status, label: definition?.label ?? review.status, color: definition?.color ?? 'neutral',
    closesCase: definition?.closesCase === true, notes: review.notes, version: review.version, updatedAt: review.updatedAt };
}

export function getLocalReview(db, input) {
  identity(input); ensureLocalReviewSchema(db);
  return current(db, input);
}

/** Batch list reads without repeating schema/catalog lookups for every row. */
export function getLocalReviews(db, inputs) {
  inputs.forEach(identity);
  ensureLocalReviewSchema(db);
  const definitions = new Map(reviewStatusSettings(db).items.map(item => [item.code, item]));
  const scopes = new Map(), reviews = new Map();
  for (const { menu, storeId } of inputs) scopes.set(JSON.stringify([menu, storeId]), { menu, storeId });
  const read = db.prepare('SELECT entity_id,status,notes,version,updated_at AS updatedAt FROM local_reviews WHERE menu=? AND store_id=?');
  for (const { menu, storeId } of scopes.values()) {
    for (const row of read.all(menu, storeId)) reviews.set(JSON.stringify([menu, storeId, row.entity_id]), row);
  }
  return inputs.map(({ menu, storeId, entityId }) => {
    const row = reviews.get(JSON.stringify([menu, storeId, entityId]));
    return presentReview(row, definitions.get(row?.status ?? 'pending'));
  });
}

export function getLocalReviewHistory(db, input) {
  identity(input); ensureLocalReviewSchema(db);
  return db.prepare(`SELECT version,previous_status AS previousStatus,status,previous_notes AS previousNotes,notes,changed_at AS changedAt
    FROM local_review_history WHERE menu=? AND store_id=? AND entity_id=? ORDER BY version`).all(input.menu, input.storeId, input.entityId).map(row => ({ ...row }));
}

/** Caller checks entity existence. A stale editor cannot overwrite a newer edit. */
export function saveLocalReview(db, input = {}) {
  identity(input);
  const { menu, storeId, entityId, status, notes, expectedVersion, now = new Date() } = input;
  const at = timestamp(now);
  if (typeof status !== 'string' || typeof notes !== 'string' || notes.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(notes)
    || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || expectedVersion === Number.MAX_SAFE_INTEGER || !at) throw failure('INVALID_REVIEW');
  ensureLocalReviewSchema(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    const previous = current(db, input);
    if (previous.version !== expectedVersion) throw failure('REVIEW_CONFLICT');
    try { validateReviewStatus(db, menu, status, { previousStatus: previous.status }); }
    catch (error) { if (error?.code === 'INVALID_STATUS') throw failure('INVALID_REVIEW'); throw error; }
    if (previous.status === status && previous.notes === notes) { db.exec('COMMIT'); return previous; }
    const version = previous.version + 1;
    db.prepare(`INSERT INTO local_reviews VALUES(?,?,?,?,?,?,?) ON CONFLICT(menu,store_id,entity_id)
      DO UPDATE SET status=excluded.status,notes=excluded.notes,version=excluded.version,updated_at=excluded.updated_at`)
      .run(menu, storeId, entityId, status, notes, version, at);
    db.prepare('INSERT INTO local_review_history VALUES(?,?,?,?,?,?,?,?,?)')
      .run(menu, storeId, entityId, version, previous.status, status, previous.notes, notes, at);
    const saved = current(db, input);
    db.exec('COMMIT');
    return saved;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
