import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureReviewStatusSchema, reviewStatusSettings, saveReviewStatus, statusDefinition,
  availableReviewStatuses, validateReviewStatus, refundManagementStatuses } from '../src/domain/review-statuses.mjs';

const NOW = '2026-09-25T12:00:00.000Z';
function fixture(t) { const db = new DatabaseSync(':memory:'); t.after(() => db.close()); return db; }
const input = (extra = {}) => ({ label: 'Verificar documento', color: 'blue', menus: ['refunds'],
  active: true, closesCase: false, expectedVersion: 0, now: NOW, ...extra });
const update = (db, value, extra) => saveReviewStatus(db, { ...value, expectedVersion: value.version, now: NOW, ...extra });

test('schema seeds the shared menus and original statuses without resetting later edits', t => {
  const db = fixture(t), settings = reviewStatusSettings(db);
  assert.deepEqual(settings.menus.map(menu => menu.code), ['orders', 'refunds', 'charges', 'customer-returns', 'returns', 'refund-management']);
  assert.deepEqual(settings.items.slice(0, 5).map(item => item.code), ['pending', 'in_review', 'request_safe_t', 'waiting_amazon', 'resolved']);
  assert.ok(settings.items.every(item => item.version === 1 && item.active));
  assert.equal(statusDefinition(db, 'resolved').closesCase, true);
  assert.deepEqual(statusDefinition(db, 'request_safe_t').menus, ['refunds', 'customer-returns', 'returns', 'refund-management']);
  assert.equal(availableReviewStatuses(db, 'orders').length, 4);
  assert.equal(availableReviewStatuses(db, 'refunds').length, 5);
  const changed = update(db, statusDefinition(db, 'in_review'), { label: 'Conferência interna', color: 'red', active: false, menus: [] });
  ensureReviewStatusSchema(db); ensureReviewStatusSchema(db);
  assert.deepEqual(statusDefinition(db, 'in_review'), changed);
  assert.equal(reviewStatusSettings(db).items.length, 16);
});

test('custom codes are stable, unique, bounded and menu order is canonical', t => {
  const db = fixture(t);
  const saved = saveReviewStatus(db, input({ label: '  Revisão concluída  ', color: 'good', menus: ['returns', 'orders'], closesCase: true }));
  assert.match(saved.code, /^custom_[a-f0-9]{32}$/);
  assert.equal(saved.label, 'Revisão concluída');
  assert.deepEqual(saved.menus, ['orders', 'returns']);
  assert.equal(saved.version, 1);
  assert.equal(saved.updatedAt, NOW);
  assert.equal(saved.closesCase, true);
  const unchanged = update(db, saved, { menus: ['returns', 'orders'], now: '2026-09-26T12:00:00Z' });
  assert.deepEqual(unchanged, saved);
  const second = saveReviewStatus(db, input());
  assert.notEqual(second.code, saved.code);
  assert.equal(statusDefinition(db, 'not_known'), null);
  assert.equal(statusDefinition(db, {}), null);
});

test('invalid definitions cannot enter the global catalog', t => {
  const db = fixture(t); ensureReviewStatusSchema(db);
  for (const extra of [{ label: '' }, { label: '  ' }, { label: 'x'.repeat(61) }, { label: 'bad\nlabel' },
    { label: '\tTrimmed control' }, { label: 'bad\u0000value' }, { color: '#12345g' }, { color: null },
    { menus: [] }, { menus: ['unknown'] }, { menus: ['refunds', 'refunds'] }, { menus: 'refunds' },
    { active: 1 }, { closesCase: 'false' }, { expectedVersion: undefined }, { expectedVersion: 1 },
    { expectedVersion: -1 }, { code: null }, { code: '../path' }, { code: 'custom_missing' },
    { now: '2026-02-30T12:00:00Z' }]) {
    assert.throws(() => saveReviewStatus(db, input(extra)), { code: 'INVALID_STATUS' });
  }
  assert.equal(reviewStatusSettings(db).items.length, 16);
  const disabled = saveReviewStatus(db, input({ active: false, menus: [] }));
  assert.deepEqual(disabled.menus, []);
});

test('optimistic conflicts and duplicate labels leave prior configuration unchanged', t => {
  const db = fixture(t), first = saveReviewStatus(db, input());
  const edited = update(db, first, { label: 'Aguardar documento', color: 'amber' });
  assert.equal(edited.version, 2);
  assert.throws(() => update(db, first, { label: 'Edição desatualizada' }), { code: 'STATUS_CONFLICT' });
  assert.throws(() => saveReviewStatus(db, input({ label: ' AGUARDAR DOCUMENTO ' })), { code: 'DUPLICATE_STATUS' });
  assert.throws(() => update(db, edited, { label: 'Resolvido' }), { code: 'DUPLICATE_STATUS' });
  assert.deepEqual(statusDefinition(db, first.code), edited);
  assert.equal(reviewStatusSettings(db).items.length, 17);
  assert.equal(update(db, edited, { label: 'Documento recebido' }).version, 3);
});

test('inactive and unassigned statuses remain valid only when preserving an existing status', t => {
  const db = fixture(t), first = saveReviewStatus(db, input());
  assert.equal(validateReviewStatus(db, 'refunds', first.code).code, first.code);
  assert.throws(() => validateReviewStatus(db, 'orders', first.code), { code: 'INVALID_STATUS' });
  const unassigned = update(db, first, { menus: ['orders'] });
  assert.throws(() => validateReviewStatus(db, 'refunds', first.code, { previousStatus: 'pending' }), { code: 'INVALID_STATUS' });
  assert.deepEqual(validateReviewStatus(db, 'refunds', first.code, { previousStatus: first.code }), unassigned);
  const disabled = update(db, unassigned, { active: false, menus: [] });
  assert.deepEqual(validateReviewStatus(db, 'refunds', first.code, { previousStatus: first.code }), disabled);
  assert.ok(!availableReviewStatuses(db, 'refunds').some(item => item.code === first.code));
  assert.throws(() => validateReviewStatus(db, 'refunds', first.code), { code: 'INVALID_STATUS' });
  assert.throws(() => validateReviewStatus(db, 'refunds', 'custom_absent', { previousStatus: 'custom_absent' }), { code: 'INVALID_STATUS' });
  assert.throws(() => availableReviewStatuses(db, 'unknown'), { code: 'INVALID_STATUS' });
});

test('the catalog limit includes seeded and disabled statuses and remains editable at capacity', t => {
  const db = fixture(t);
  const seededCount = reviewStatusSettings(db).items.length;
  for (let index = 0; index < 100 - seededCount; index++) saveReviewStatus(db, input({ label: `Status ${index}`, active: false, menus: [] }));
  assert.equal(reviewStatusSettings(db).items.length, 100);
  assert.throws(() => saveReviewStatus(db, input()), { code: 'INVALID_STATUS' });
  const pending = statusDefinition(db, 'pending');
  const updated = update(db, pending, { label: 'Pendente de análise' });
  assert.equal(updated.version, 2);
  assert.equal(reviewStatusSettings(db).items.length, 100);
});

test('schema initialization inside a rolled back transaction is not cached as committed', t => {
  const db = fixture(t);
  db.exec('BEGIN');
  ensureReviewStatusSchema(db);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM review_status_catalog').get().n, 16);
  db.exec('ROLLBACK');
  assert.equal(reviewStatusSettings(db).items.length, 16);
  const custom = saveReviewStatus(db, input());
  assert.equal(statusDefinition(db, custom.code).label, custom.label);
});

test('HEX colors round-trip in lowercase and casing alone does not change version or timestamp', t => {
  const db = fixture(t), original = reviewStatusSettings(db).items;
  const saved = saveReviewStatus(db, input({ color: '#A1B2Cf' }));
  assert.equal(saved.color, '#a1b2cf');
  assert.equal(db.prepare('SELECT color FROM review_status_catalog WHERE code=?').get(saved.code).color, '#a1b2cf');
  assert.equal(statusDefinition(db, saved.code).color, '#a1b2cf');
  assert.equal(reviewStatusSettings(db).items.find(item => item.code === saved.code).color, '#a1b2cf');
  assert.deepEqual(update(db, saved, { color: '#A1B2CF', now: '2026-09-26T12:00:00Z' }), saved);
  const changed = update(db, saved, { color: '#000000' });
  assert.equal(changed.version, 2);
  assert.equal(changed.color, '#000000');
  assert.deepEqual(reviewStatusSettings(db).items.slice(0, original.length), original, 'Existing palette tokens must not be migrated');
  for (const color of ['neutral', 'blue', 'amber', 'good', 'red']) {
    const legacy = saveReviewStatus(db, input({ label: `Compatibility ${color}`, color }));
    assert.equal(statusDefinition(db, legacy.code).color, color);
  }
});

test('color validation rejects CSS, malformed HEX and non-string values before persistence', t => {
  const db = fixture(t); ensureReviewStatusSchema(db);
  for (const color of ['#abc', '#12345678', '#12345g', '#123456\n', ' #123456', '#123456 ',
    '#123456;background:url(https://invalid.test)', 'rgb(10,20,30)', 'var(--color)', '</style><script>alert(1)</script>',
    'expression(alert(1))', null, 123456, [], {}, new String('#123456')]) {
    assert.throws(() => saveReviewStatus(db, input({ color })), { code: 'INVALID_STATUS' });
  }
  assert.equal(reviewStatusSettings(db).items.length, 16);
});

test('refund management exposes twelve manual statuses and two protected payment indicators with stable roles', t => {
  const db = fixture(t), items = refundManagementStatuses(db);
  assert.deepEqual(items.map(item => [item.semanticRole, item.label]), [
    ['new', 'Novo'], ['analysis', 'Em análise'], ['request_safe_t', 'Solicitar SAFE-T'],
    ['safe_t_received', 'SAFE-T RECEBIDO'], ['easy_ship_received', 'EASY-SHIP RECEBIDO'],
    ['concluded', 'Concluído'], ['safe_t_granted', 'SAFE-T CONCEDIDO'],
    ['safe_t_investigation', 'SAFE-T Sob Investigação'], ['safe_t_denied', 'SAFE-T Negado'], ['awaiting_proactive_refund', 'Aguardando reembolso proativo'],
    ['awaiting_proactive_dba_refund', 'Aguardando reembolso DBA (50 dias)'],
    ['awaiting_fba_refund', 'Aguardando reembolso FBA (45 dias)'], ['awaiting_customer_return', 'Devolução de cliente · SAFE-T 60 dias'], ['return_received', 'Devolução Recebida'],
  ]);
  assert.ok(items.every(item => /^[a-z][a-z0-9_]{0,49}$/.test(item.code)));
  assert.equal(availableReviewStatuses(db, 'refund-management').length, 12);
  assert.ok(availableReviewStatuses(db, 'refund-management').every(item => !item.automatic));
  assert.ok(!items.some(item => item.code === 'waiting_amazon' || item.code === 'resolved'));
  for (const item of items.filter(item => item.automatic)) {
    assert.equal(item.readOnly, true);
    const before = statusDefinition(db, item.code);
    assert.throws(() => update(db, item, { label: `${item.label} alterado` }), { code: 'INVALID_STATUS' });
    assert.throws(() => update(db, item, { active: false, menus: [] }), { code: 'INVALID_STATUS' });
    assert.throws(() => validateReviewStatus(db, 'refund-management', item.code), { code: 'INVALID_STATUS' });
    assert.deepEqual(statusDefinition(db, item.code), before);
  }
  const concluded = items.find(item => item.semanticRole === 'concluded');
  const changed = update(db, concluded, { label: 'Conferência encerrada', color: '#123456', closesCase: true });
  assert.equal(refundManagementStatuses(db).find(item => item.code === changed.code).semanticRole, 'concluded');
  const custom = saveReviewStatus(db, input({ menus: ['refund-management'] }));
  assert.equal(refundManagementStatuses(db).find(item => item.code === custom.code).semanticRole, null);
  assert.equal(refundManagementStatuses(db).find(item => item.code === custom.code).automatic, false);
});

test('migration reuses existing labels and preserves other menus, colors, inactive state and review history', t => {
  const db = fixture(t);
  db.exec(`CREATE TABLE review_status_catalog (
    code TEXT PRIMARY KEY,label TEXT NOT NULL,label_key TEXT NOT NULL UNIQUE,color TEXT NOT NULL,
    menus_json TEXT NOT NULL,active INTEGER NOT NULL,closes_case INTEGER NOT NULL,
    version INTEGER NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE legacy_reviews(status_code TEXT,notes TEXT);
    CREATE TABLE legacy_history(status_code TEXT,notes TEXT);`);
  const insert = db.prepare('INSERT INTO review_status_catalog VALUES(?,?,?,?,?,?,?,?,?)');
  const oldMenus = ['orders', 'refunds', 'charges', 'customer-returns', 'returns'];
  for (const [code, label, color] of [['pending', 'Aguardando conferência', '#998877'], ['in_review', 'Em análise', 'red'],
    ['request_safe_t', 'Solicitar SAFE-T', 'blue'], ['waiting_amazon', 'Aguardando Amazon', 'neutral'], ['resolved', 'Resolvido', 'good']]) {
    insert.run(code, label, label.toLocaleLowerCase('pt-BR'), color, JSON.stringify(oldMenus), 1, code === 'resolved' ? 1 : 0, 7, NOW);
  }
  insert.run('custom_existing', 'Novo', 'novo', '#abcdef', JSON.stringify(['charges']), 0, 1, 12, NOW);
  db.exec("INSERT INTO legacy_reviews VALUES('custom_existing','Nota anterior'); INSERT INTO legacy_history VALUES('custom_existing','Histórico anterior')");
  const before = db.prepare('SELECT * FROM review_status_catalog ORDER BY rowid').all();
  const reviews = db.prepare('SELECT * FROM legacy_reviews').all(), history = db.prepare('SELECT * FROM legacy_history').all();
  const items = refundManagementStatuses(db);
  assert.equal(items.find(item => item.semanticRole === 'new').code, 'custom_existing');
  assert.equal(items.find(item => item.semanticRole === 'new').active, false);
  for (const row of before) {
    const current = statusDefinition(db, row.code);
    assert.equal(current.label, row.label);
    assert.equal(current.color, row.color);
    assert.equal(current.active, Boolean(row.active));
    assert.equal(current.closesCase, Boolean(row.closes_case));
    assert.deepEqual(current.menus.filter(menu => menu !== 'refund-management'), JSON.parse(row.menus_json));
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM review_status_catalog WHERE label_key='novo'").get().n, 1);
  assert.deepEqual(db.prepare('SELECT * FROM legacy_reviews').all(), reviews);
  assert.deepEqual(db.prepare('SELECT * FROM legacy_history').all(), history);
  assert.equal(items.some(item => item.code === 'pending'), false, 'A renamed seed must not gain the wrong semantic role');
});

test('role mapping survives restart and does not restore renamed, disabled or unassigned manual statuses', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'synth-status-roles-'));
  const filename = path.join(root, 'fixture.sqlite');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let db = new DatabaseSync(filename);
  const first = refundManagementStatuses(db).find(item => item.semanticRole === 'return_received');
  const changed = update(db, first, { label: 'Produto conferido', active: false, menus: [] });
  db.close();
  db = new DatabaseSync(filename);
  try {
    const items = refundManagementStatuses(db);
    assert.equal(items.some(item => item.code === changed.code), false);
    assert.deepEqual(statusDefinition(db, changed.code), changed);
    assert.equal(db.prepare('SELECT semantic_role FROM refund_management_status_roles WHERE status_code=?').get(changed.code).semantic_role, 'return_received');
    assert.equal(reviewStatusSettings(db).items.length, 16);
    const restored = update(db, changed, { active: true, menus: ['refund-management'] });
    assert.equal(refundManagementStatuses(db).find(item => item.code === restored.code).semanticRole, 'return_received');
  } finally { db.close(); }
});


test('SAFE-T Sob Investigação is a manual brown status in all management queues', t => {
  const db = fixture(t);
  const status = statusDefinition(db, 'rm_safe_t_investigation');
  assert.equal(status.label, 'SAFE-T Sob Investigação');
  assert.equal(status.color, '#8b5e3c');
  assert.equal(status.closesCase, false);
  assert.equal(Boolean(status.automatic), false);
  for (const menu of ['refund-management', 'returns', 'customer-returns']) {
    assert.ok(availableReviewStatuses(db, menu).some(item => item.code === status.code));
    assert.doesNotThrow(() => validateReviewStatus(db, menu, status.code));
  }
});

test('SAFE-T Negado is a manual rose status without automatic finalization', t => {
  const db = fixture(t), status = statusDefinition(db, 'rm_safe_t_denied');
  assert.equal(status.label, 'SAFE-T Negado');
  assert.equal(status.color, '#b54153');
  assert.equal(status.closesCase, false);
  assert.equal(Boolean(status.automatic), false);
  for (const menu of ['refund-management', 'returns', 'customer-returns']) {
    assert.ok(availableReviewStatuses(db, menu).some(item => item.code === status.code));
    assert.doesNotThrow(() => validateReviewStatus(db, menu, status.code));
  }
});

test('distinct SAFE-T colors migrate only original defaults once and preserve later customization', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'synth-status-colors-'));
  const filename = path.join(root, 'fixture.sqlite');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let db = new DatabaseSync(filename);
  ensureReviewStatusSchema(db);
  db.exec(`DELETE FROM review_status_migrations WHERE name='distinct-safe-t-colors-v1';
    UPDATE review_status_catalog SET color='red',version=1 WHERE code IN ('rm_proactive_refund','rm_safe_t_denied');
    UPDATE review_status_catalog SET color='#abcdef',version=3 WHERE code='rm_proactive_dba_refund'`);
  const oldDenied = statusDefinition(db, 'rm_safe_t_denied');
  db.close();
  db = new DatabaseSync(filename);
  const migrated = statusDefinition(db, 'rm_proactive_refund');
  assert.equal(migrated.color, '#7c3aed');
  assert.equal(migrated.version, 2);
  assert.equal(statusDefinition(db, 'rm_proactive_dba_refund').color, '#abcdef');
  assert.equal(statusDefinition(db, 'rm_proactive_dba_refund').version, 3);
  const denied = statusDefinition(db, 'rm_safe_t_denied');
  assert.equal(denied.color, '#b54153');
  assert.deepEqual(denied.menus, oldDenied.menus);
  assert.equal(denied.closesCase, oldDenied.closesCase);
  const customized = update(db, migrated, { color: 'red' });
  db.close();
  db = new DatabaseSync(filename);
  try {
    assert.deepEqual(statusDefinition(db, customized.code), customized);
    assert.equal(reviewStatusSettings(db).items.length, 16);
  } finally { db.close(); }
});


test('customer-return label upgrade retains its role, color, code and later customized label',t=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'return-status-')),file=path.join(root,'test.sqlite');
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  let db=new DatabaseSync(file);ensureReviewStatusSchema(db);
  const code=refundManagementStatuses(db).find(row=>row.semanticRole==='awaiting_customer_return').code;
  db.prepare("UPDATE review_status_catalog SET label=?,label_key=?,color='#a56b31',version=3 WHERE code=?").run('Aguardando devolução do cliente (60 dias)','aguardando devolução do cliente (60 dias)',code);
  db.prepare('DELETE FROM review_status_migrations WHERE name=?').run('customer-return-safe-t-label-v1');db.close();
  db=new DatabaseSync(file);ensureReviewStatusSchema(db);
  const upgraded=statusDefinition(db,code);
  assert.equal(upgraded.label,'Devolução de cliente · SAFE-T 60 dias');assert.equal(upgraded.color,'#a56b31');assert.equal(upgraded.version,4);
  assert.equal(refundManagementStatuses(db).find(row=>row.semanticRole==='awaiting_customer_return').code,code);
  saveReviewStatus(db,{...upgraded,label:'Nome escolhido na loja',expectedVersion:upgraded.version});db.close();
  db=new DatabaseSync(file);try {ensureReviewStatusSchema(db);assert.equal(statusDefinition(db,code).label,'Nome escolhido na loja');}finally{db.close();}
});
