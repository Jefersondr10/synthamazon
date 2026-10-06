import { randomUUID } from 'node:crypto';

export const REVIEW_MENUS = Object.freeze([
  { code: 'orders', label: 'Pedidos' }, { code: 'refunds', label: 'Reembolsos' },
  { code: 'charges', label: 'Cobranças' }, { code: 'customer-returns', label: 'Gerenciar Devoluções' },
  { code: 'returns', label: 'Devolvido ao vendedor' },
  { code: 'refund-management', label: 'Gerenciar reembolsos' },
].map(Object.freeze));
const MENU_CODES = new Set(REVIEW_MENUS.map(menu => menu.code));
const COLORS = new Set(['neutral', 'blue', 'amber', 'good', 'red']);
const CODE = /^[a-z][a-z0-9_]{0,49}$/;
const initialized = new WeakSet();
const SEEDS = [
  ['pending', 'Novo', 'neutral', false], ['in_review', 'Em análise', 'blue', false],
  ['request_safe_t', 'Solicitar SAFE-T', 'amber', false], ['waiting_amazon', 'Aguardando Amazon', 'amber', false],
  ['resolved', 'Resolvido', 'good', true],
];
const REFUND_MANAGEMENT_MENU = 'refund-management';
const REFUND_MANAGEMENT_SEEDS = [
  ['new', 'rm_new', 'Novo', 'amber', false],
  ['analysis', 'rm_analysis', 'Em análise', 'blue', false],
  ['request_safe_t', 'rm_request_safe_t', 'Solicitar SAFE-T', '#8b5cf6', false],
  ['safe_t_received', 'rm_safe_t_received', 'SAFE-T RECEBIDO', '#059669', true],
  ['easy_ship_received', 'rm_easy_ship_received', 'EASY-SHIP RECEBIDO', '#2563eb', true],
  ['concluded', 'rm_concluded', 'Concluído', 'good', false],
  ['safe_t_granted', 'rm_safe_t_granted', 'SAFE-T CONCEDIDO', 'good', false],
  ['safe_t_investigation', 'rm_safe_t_investigation', 'SAFE-T Sob Investigação', '#8b5e3c', false],
  ['safe_t_denied', 'rm_safe_t_denied', 'SAFE-T Negado', '#b54153', false],
  ['awaiting_proactive_refund', 'rm_proactive_refund', 'Aguardando reembolso proativo', '#7c3aed', false],
  ['awaiting_proactive_dba_refund', 'rm_proactive_dba_refund', 'Aguardando reembolso DBA (50 dias)', '#0f766e', false],
  ['awaiting_fba_refund', 'rm_fba_refund', 'Aguardando reembolso FBA (45 dias)', '#2563eb', false],
  ['awaiting_customer_return', 'rm_customer_return_wait', 'Devolução de cliente · SAFE-T 60 dias', '#b7791f', false],
  ['return_received', 'rm_return_received', 'Devolução Recebida', 'blue', false],
];
const failure = code => Object.assign(new Error(code), { code });
const labelKey = label => label.toLocaleLowerCase('pt-BR');

export function normalizeReviewStatusColor(value) {
  if (typeof value !== 'string') return null;
  if (COLORS.has(value)) return value;
  return value.length === 7 && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
}

function instant(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    || hour > 23 || minute > 59 || second > 59 || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}
function definition(row) {
  return row ? { code: row.code, label: row.label, color: row.color, menus: JSON.parse(row.menus_json),
    active: Boolean(row.active), closesCase: Boolean(row.closes_case), version: row.version, updatedAt: row.updated_at,
    ...(row.automatic ? { automatic: true, readOnly: true } : {}) } : null;
}

export function ensureReviewStatusSchema(db) {
  if (initialized.has(db)) return;
  // A savepoint keeps migration atomic both on a fresh handle and inside a
  // caller's transaction. Existing labels, colors, usage and history survive.
  db.exec('SAVEPOINT review_status_setup');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS review_status_catalog (
    code TEXT PRIMARY KEY,label TEXT NOT NULL,label_key TEXT NOT NULL UNIQUE,color TEXT NOT NULL,
    menus_json TEXT NOT NULL,active INTEGER NOT NULL,closes_case INTEGER NOT NULL,
    version INTEGER NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS refund_management_status_roles (
      semantic_role TEXT PRIMARY KEY,status_code TEXT NOT NULL UNIQUE,
      automatic INTEGER NOT NULL,
      FOREIGN KEY(status_code) REFERENCES review_status_catalog(code));
    CREATE TABLE IF NOT EXISTS review_status_migrations (name TEXT PRIMARY KEY,applied_at TEXT NOT NULL);`);
    const insert = db.prepare('INSERT OR IGNORE INTO review_status_catalog VALUES(?,?,?,?,?,?,?,?,?)');
    const timestamp = new Date().toISOString();
    for (const [code, label, color, closesCase] of SEEDS) {
      const menus = REVIEW_MENUS.map(menu => menu.code).filter(menu => menu === REFUND_MANAGEMENT_MENU
        ? ['pending', 'in_review', 'request_safe_t'].includes(code)
        : code !== 'request_safe_t' || ['refunds', 'customer-returns', 'returns'].includes(menu));
      insert.run(code, label, labelKey(label), color, JSON.stringify(menus), 1, Number(closesCase), 1, timestamp);
    }
    for (const [role, proposedCode, label, color, automatic] of REFUND_MANAGEMENT_SEEDS) {
      // The persisted role marks this assignment as migrated. Later edits,
      // disabling or removing the menu must not be undone by initialization.
      if (db.prepare('SELECT 1 FROM refund_management_status_roles WHERE semantic_role=?').get(role)) continue;
      let existing = db.prepare('SELECT * FROM review_status_catalog WHERE label_key=?').get(labelKey(label));
      if (!existing) {
        const code = db.prepare('SELECT 1 FROM review_status_catalog WHERE code=?').get(proposedCode)
          ? `custom_${randomUUID().replaceAll('-', '')}` : proposedCode;
        insert.run(code, label, labelKey(label), color, JSON.stringify(['safe_t_investigation', 'safe_t_denied'].includes(role) ? [REFUND_MANAGEMENT_MENU, 'returns', 'customer-returns'] : role === 'safe_t_granted' ? [REFUND_MANAGEMENT_MENU, 'returns'] : [REFUND_MANAGEMENT_MENU]), 1, 0, 1, timestamp);
        existing = db.prepare('SELECT * FROM review_status_catalog WHERE code=?').get(code);
      } else {
        const menus = JSON.parse(existing.menus_json);
        if (!menus.includes(REFUND_MANAGEMENT_MENU)) {
          menus.push(REFUND_MANAGEMENT_MENU);
          db.prepare('UPDATE review_status_catalog SET menus_json=?,version=version+1,updated_at=? WHERE code=?')
            .run(JSON.stringify(menus), timestamp, existing.code);
        }
      }
      db.prepare('INSERT INTO refund_management_status_roles VALUES(?,?,?)').run(role, existing.code, Number(automatic));
    }
    if (!db.prepare('SELECT 1 FROM review_status_migrations WHERE name=?').get('safe-t-granted-returns-v1')) {
      const granted = db.prepare(`SELECT c.* FROM review_status_catalog c JOIN refund_management_status_roles r
        ON r.status_code=c.code WHERE r.semantic_role='safe_t_granted'`).get();
      const menus = [...new Set([...JSON.parse(granted.menus_json), 'refund-management', 'returns'])];
      if (granted.label !== 'SAFE-T CONCEDIDO' || granted.menus_json !== JSON.stringify(menus) || !granted.active || granted.closes_case) {
        db.prepare('UPDATE review_status_catalog SET label=?,label_key=?,menus_json=?,active=1,closes_case=0,version=version+1,updated_at=? WHERE code=?')
          .run('SAFE-T CONCEDIDO', labelKey('SAFE-T CONCEDIDO'), JSON.stringify(menus), timestamp, granted.code);
      }
      db.prepare('INSERT INTO review_status_migrations VALUES(?,?)').run('safe-t-granted-returns-v1', timestamp);
    }
    if (!db.prepare('SELECT 1 FROM review_status_migrations WHERE name=?').get('distinct-safe-t-colors-v1')) {
      // Upgrade only the original red defaults. User-customized definitions and
      // later color edits survive subsequent initialization and collector runs.
      for (const [role, , , color] of REFUND_MANAGEMENT_SEEDS.filter(([role]) =>
        ['safe_t_denied', 'awaiting_proactive_refund', 'awaiting_proactive_dba_refund'].includes(role))) {
        db.prepare(`UPDATE review_status_catalog SET color=?,version=version+1,updated_at=?
          WHERE code=(SELECT status_code FROM refund_management_status_roles WHERE semantic_role=?)
          AND color='red' AND version=1`).run(color, timestamp, role);
      }
      db.prepare('INSERT INTO review_status_migrations VALUES(?,?)').run('distinct-safe-t-colors-v1', timestamp);
    }
    if (!db.prepare('SELECT 1 FROM review_status_migrations WHERE name=?').get('customer-return-safe-t-label-v1')) {
      // Keep the semantic code, assignments, custom colors and all order history.
      // Only the original default label is upgraded; later user edits survive.
      const label='Devolução de cliente · SAFE-T 60 dias';
      if (!db.prepare('SELECT 1 FROM review_status_catalog WHERE label_key=?').get(labelKey(label))) {
        db.prepare(`UPDATE review_status_catalog SET label=?,label_key=?,version=version+1,updated_at=?
          WHERE code=(SELECT status_code FROM refund_management_status_roles WHERE semantic_role='awaiting_customer_return')
          AND label=?`).run(label,labelKey(label),timestamp,'Aguardando devolução do cliente (60 dias)');
      }
      db.prepare('INSERT INTO review_status_migrations VALUES(?,?)').run('customer-return-safe-t-label-v1',timestamp);
    }
    db.exec('RELEASE SAVEPOINT review_status_setup');
  } catch (error) {
    db.exec('ROLLBACK TO SAVEPOINT review_status_setup');
    db.exec('RELEASE SAVEPOINT review_status_setup');
    throw error;
  }
  // Each handle owns one persistent schema. Do not cache setup inside a caller's
  // transaction: its rollback could remove the table or the seeded definitions.
  if (!db.isTransaction) initialized.add(db);
}

/** Input is the released, store/order-linked result of reimbursementIndex. */
export function safeTGrantedEvidence(credits = []) {
  const confirmed = credits.filter(credit => credit.type === 'safe_t' && /^\d+$/.test(credit.totalCents) && BigInt(credit.totalCents) > 0n)
    .map(credit => [credit.eventId, credit.totalCents, credit.currency]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return confirmed.length ? JSON.stringify(confirmed) : null;
}

/** Role identity is independent from configurable labels and closesCase. */
export function refundManagementStatuses(db) {
  const settings = reviewStatusSettings(db);
  const roles = new Map(db.prepare('SELECT * FROM refund_management_status_roles').all().map(row => [row.status_code, row]));
  const order = new Map(REFUND_MANAGEMENT_SEEDS.map(([role], index) => [role, index]));
  return settings.items.filter(item => item.menus.includes(REFUND_MANAGEMENT_MENU)).map(item => ({
    ...item, semanticRole: roles.get(item.code)?.semantic_role ?? null, automatic: Boolean(roles.get(item.code)?.automatic),
  })).sort((a, b) => (order.get(a.semanticRole) ?? 100) - (order.get(b.semanticRole) ?? 100));
}

export function reviewStatusSettings(db) {
  ensureReviewStatusSchema(db);
  return { items: db.prepare(`SELECT c.*,r.automatic FROM review_status_catalog c
      LEFT JOIN refund_management_status_roles r ON r.status_code=c.code ORDER BY c.rowid`).all().map(definition),
    menus: REVIEW_MENUS.map(menu => ({ ...menu })) };
}

export function statusDefinition(db, code) {
  ensureReviewStatusSchema(db);
  if (typeof code !== 'string' || !CODE.test(code)) return null;
  return definition(db.prepare(`SELECT c.*,r.automatic FROM review_status_catalog c
    LEFT JOIN refund_management_status_roles r ON r.status_code=c.code WHERE c.code=?`).get(code));
}

export function availableReviewStatuses(db, menu) {
  if (!MENU_CODES.has(menu)) throw failure('INVALID_STATUS');
  return reviewStatusSettings(db).items.filter(item => item.active && !item.automatic && item.menus.includes(menu));
}

export function validateReviewStatus(db, menu, code, { previousStatus } = {}) {
  if (!MENU_CODES.has(menu)) throw failure('INVALID_STATUS');
  const item = statusDefinition(db, code);
  if (!item || code !== previousStatus && (item.automatic || !item.active || !item.menus.includes(menu))) throw failure('INVALID_STATUS');
  return item;
}

/** Status configuration changes presentation and local workflow only; usage/history keep their codes. */
export function saveReviewStatus(db, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('INVALID_STATUS');
  const { code, menus, active, closesCase, expectedVersion, now = new Date() } = input;
  const color = normalizeReviewStatusColor(input.color);
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  const timestamp = instant(now), creating = code === undefined;
  if ((!creating && (typeof code !== 'string' || !CODE.test(code))) || !label || label.length > 60
    || /[\u0000-\u001f\u007f]/u.test(input.label) || color === null
    || !Array.isArray(menus) || menus.length > REVIEW_MENUS.length || new Set(menus).size !== menus.length
    || menus.some(menu => !MENU_CODES.has(menu)) || typeof active !== 'boolean' || active && menus.length === 0 || typeof closesCase !== 'boolean'
    || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || creating && expectedVersion !== 0 || !timestamp) throw failure('INVALID_STATUS');
  const normalizedMenus = REVIEW_MENUS.map(menu => menu.code).filter(menu => menus.includes(menu));
  ensureReviewStatusSchema(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    const previous = creating ? null : definition(db.prepare('SELECT * FROM review_status_catalog WHERE code=?').get(code));
    if (!creating && !previous) throw failure('INVALID_STATUS');
    if (!creating && db.prepare('SELECT 1 FROM refund_management_status_roles WHERE status_code=? AND automatic=1').get(code)) throw failure('INVALID_STATUS');
    if (previous && previous.version !== expectedVersion) throw failure('STATUS_CONFLICT');
    if (creating && db.prepare('SELECT COUNT(*) AS n FROM review_status_catalog').get().n >= 100) throw failure('INVALID_STATUS');
    const duplicate = db.prepare('SELECT code FROM review_status_catalog WHERE label_key=? AND code<>?').get(labelKey(label), code ?? '');
    if (duplicate) throw failure('DUPLICATE_STATUS');
    if (previous && previous.label === label && previous.color === color && previous.active === active
      && previous.closesCase === closesCase && JSON.stringify(previous.menus) === JSON.stringify(normalizedMenus)) {
      db.exec('COMMIT'); return previous;
    }
    const result = { code: code ?? `custom_${randomUUID().replaceAll('-', '')}`, label, color, menus: normalizedMenus,
      active, closesCase, version: (previous?.version ?? 0) + 1, updatedAt: timestamp };
    db.prepare(`INSERT INTO review_status_catalog VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET
      label=excluded.label,label_key=excluded.label_key,color=excluded.color,menus_json=excluded.menus_json,
      active=excluded.active,closes_case=excluded.closes_case,version=excluded.version,updated_at=excluded.updated_at`)
      .run(result.code, label, labelKey(label), color, JSON.stringify(normalizedMenus), Number(active), Number(closesCase), result.version, timestamp);
    db.exec('COMMIT'); return result;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
