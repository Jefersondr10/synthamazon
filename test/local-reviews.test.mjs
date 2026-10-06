import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ensureLocalReviewSchema, getLocalReview, getLocalReviews, getLocalReviewHistory, saveLocalReview } from '../src/domain/local-reviews.mjs';
import { availableReviewStatuses, statusDefinition, saveReviewStatus } from '../src/domain/review-statuses.mjs';

const at = '2026-09-25T12:00:00.000Z';
const input = { menu: 'orders', storeId: 'store-a', entityId: '701-1111111-2222222' };
function fixture(t) { const db = new DatabaseSync(':memory:'); ensureLocalReviewSchema(db); t.after(() => db.close()); return db; }
const save = (db, extra = {}) => saveLocalReview(db, { ...input, status: 'pending', notes: 'Conferir.', expectedVersion: 0, now: at, ...extra });

test('default review uses catalogue metadata without creating an audit or manual record', t => {
  const db = fixture(t), definition = statusDefinition(db, 'pending');
  assert.deepEqual(getLocalReview(db, input), { status: 'pending', label: definition.label, color: definition.color, closesCase: definition.closesCase, notes: '', version: 0, updatedAt: null });
  assert.deepEqual(getLocalReviewHistory(db, input), []);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM local_reviews').get().total, 0);
  assert.equal(save(db, { notes: '' }).version, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM local_reviews').get().total, 0);
});

test('batched reviews retain menu/store isolation, defaults and edited catalogue definitions', t => {
  const db = fixture(t);
  const ids = [input, { ...input, menu: 'returns' }, { ...input, storeId: 'store-b' }, { ...input, entityId: 'new-order' }];
  ids.slice(0, 3).forEach((id, n) => saveLocalReview(db, { ...id, status: 'in_review', notes: `Nota ${n}`, expectedVersion: 0 }));
  const before = db.prepare('SELECT total_changes() AS n').get().n;
  assert.deepEqual(getLocalReviews(db, ids), ids.map(id => getLocalReview(db, id)));
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before);
  const definition = statusDefinition(db, 'in_review');
  saveReviewStatus(db, { ...definition, label: 'Revisar pedido', active: false, expectedVersion: definition.version });
  assert.deepEqual(getLocalReviews(db, ids), ids.map(id => getLocalReview(db, id)));
  assert.throws(() => getLocalReviews(db, [{ ...input, storeId: 'all' }]), { code: 'INVALID_REVIEW' });
});

test('manual review and chronological audit are isolated by menu, store and entity', t => {
  const db = fixture(t);
  const identities = [input, { ...input, menu: 'returns' }, { ...input, storeId: 'store-b' }, { ...input, entityId: '701-1111111-2222223' },
    { ...input, menu: 'customer-returns', entityId: 'return-' + 'a'.repeat(64) }];
  identities.forEach((id, index) => saveLocalReview(db, { ...id, status: 'pending', notes: `Nota ${index}.`, expectedVersion: 0, now: at }));
  identities.forEach((id, index) => { assert.equal(getLocalReview(db, id).notes, `Nota ${index}.`); assert.equal(getLocalReviewHistory(db, id).length, 1); });
  const next = save(db, { expectedVersion: 1, notes: 'Segunda nota\nCom detalhe.', now: '2026-09-25T13:00:00Z' });
  assert.equal(next.version, 2);
  assert.deepEqual(getLocalReviewHistory(db, input), [
    { version: 1, previousStatus: 'pending', status: 'pending', previousNotes: '', notes: 'Nota 0.', changedAt: at },
    { version: 2, previousStatus: 'pending', status: 'pending', previousNotes: 'Nota 0.', notes: 'Segunda nota\nCom detalhe.', changedAt: '2026-09-25T13:00:00.000Z' },
  ]);
  assert.equal(getLocalReview(db, identities[1]).version, 1);
});

test('status metadata comes from the catalogue and an unchanged edit creates no audit/version', t => {
  const db = fixture(t), choice = availableReviewStatuses(db, 'orders').find(status => status.code !== 'pending');
  assert.ok(choice, 'The operational catalogue includes a review choice');
  const first = save(db, { status: choice.code });
  assert.equal(first.label, choice.label); assert.equal(first.color, choice.color); assert.equal(first.closesCase, choice.closesCase);
  assert.deepEqual(save(db, { status: choice.code, expectedVersion: 1, now: '2026-09-26T12:00:00Z' }), first);
  assert.equal(getLocalReviewHistory(db, input).length, 1);
  assert.throws(() => save(db, { status: choice.code, expectedVersion: 0 }), { code: 'REVIEW_CONFLICT' });
});

test('invalid identities, timestamps, notes and versions cannot create manual data', t => {
  const db = fixture(t);
  const invalid = [{ menu: 'refunds' }, { storeId: 'all' }, { storeId: '../other' }, { entityId: '../order' },
    { menu: 'customer-returns', entityId: input.entityId }, { menu: 'orders', entityId: 'x'.repeat(81) },
    { notes: 'x'.repeat(2001) }, { notes: 'hidden\u0000value' }, { expectedVersion: undefined }, { expectedVersion: -1 },
    { expectedVersion: 0.5 }, { status: 'unknown-status' }, { now: '2026-02-30T00:00:00Z' }, { now: '2026-09-25' }];
  for (const extra of invalid) assert.throws(() => save(db, extra), { code: 'INVALID_REVIEW' });
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM local_reviews').get().total, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM local_review_history').get().total, 0);
});

test('an assigned inactive or unassigned status stays editable but cannot be newly selected', t => {
  const db = fixture(t);
  let definition = saveReviewStatus(db, { label: 'Conferência especial', color: 'neutral', menus: ['orders'], active: true, closesCase: false, expectedVersion: 0, now: at });
  const assigned = save(db, { status: definition.code });
  definition = saveReviewStatus(db, { ...definition, menus: ['returns'], expectedVersion: definition.version, now: at });
  assert.equal(save(db, { status: definition.code, notes: 'Mantido após mudança de menu.', expectedVersion: assigned.version }).version, 2);
  assert.throws(() => save(db, { entityId: 'another-order', status: definition.code }), { code: 'INVALID_REVIEW' });
  definition = saveReviewStatus(db, { ...definition, active: false, menus: [], expectedVersion: definition.version, now: at });
  const inactive = save(db, { status: definition.code, notes: 'Nota preservada em status inativo.', expectedVersion: 2 });
  assert.equal(inactive.status, definition.code); assert.equal(inactive.label, definition.label); assert.equal(inactive.version, 3);
  assert.throws(() => save(db, { menu: 'returns', entityId: 'another-order', status: definition.code }), { code: 'INVALID_REVIEW' });
  assert.equal(save(db, { status: 'pending', expectedVersion: 3 }).version, 4);
  assert.throws(() => save(db, { status: definition.code, expectedVersion: 4 }), { code: 'INVALID_REVIEW' });
  assert.equal(getLocalReview(db, input).status, 'pending'); assert.equal(getLocalReviewHistory(db, input).length, 4);
});

test('an audit write failure rolls back the review and does not touch imported evidence', t => {
  const db = fixture(t);
  db.exec("CREATE TABLE imported_evidence (payload TEXT NOT NULL); INSERT INTO imported_evidence VALUES ('immutable-original');");
  const first = save(db);
  db.exec("CREATE TRIGGER fail_local_audit BEFORE INSERT ON local_review_history BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;");
  assert.throws(() => save(db, { notes: 'Cannot persist.', expectedVersion: 1 }));
  assert.deepEqual(getLocalReview(db, input), first);
  assert.equal(getLocalReviewHistory(db, input).length, 1);
  assert.equal(db.prepare('SELECT payload FROM imported_evidence').get().payload, 'immutable-original');
  db.exec('DROP TRIGGER fail_local_audit');
  assert.equal(save(db, { notes: 'Recovery succeeds.', expectedVersion: 1 }).version, 2);
});

test('separate editors require the current version and saved review survives database reopening', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'synth-local-reviews-')), filename = path.join(directory, 'reviews.sqlite');
  let first = new DatabaseSync(filename), second = new DatabaseSync(filename);
  t.after(async () => { first?.close(); second?.close(); await rm(directory, { recursive: true, force: true }); });
  ensureLocalReviewSchema(first); ensureLocalReviewSchema(second);
  const editorA = getLocalReview(first, input), editorB = getLocalReview(second, input);
  const saved = save(first, { expectedVersion: editorA.version, notes: 'Primeiro editor.' });
  assert.throws(() => save(second, { expectedVersion: editorB.version, notes: 'Edição antiga.' }), { code: 'REVIEW_CONFLICT' });
  second.close(); second = null; first.close(); first = new DatabaseSync(filename);
  assert.deepEqual(getLocalReview(first, input), saved); assert.equal(getLocalReviewHistory(first, input).length, 1);
});
