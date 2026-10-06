import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ensureFinancialCaseSchema } from '../src/domain/financial-cases.mjs';
import { refundManagementStatuses, statusDefinition, saveReviewStatus } from '../src/domain/review-statuses.mjs';
import { ensureRefundManagementSchema, syncRefundManagement, refundManagementView,
  refundManagementDetail, refundPaymentState } from '../src/domain/refund-management.mjs';
import { mutateRefundManagement } from '../src/domain/refund-management-actions.mjs';
import { ORDER_STATUS_CATALOG, decorateOrderStatus } from '../src/domain/order-status.mjs';
import { refundNotesMarkup, safeTLinksMarkup, caseLinkMarkup, createRefundManagementState, renderRefundManagement, refundManagementParams, refundPeriodRange } from '../public/refund-management.js';

const at = day => `2026-09-${String(day).padStart(2, '0')}T12:00:00.000Z`;
test('refund periods use Brasília dates, inclusive days and calendar month boundaries', () => {
  const now = new Date('2026-10-01T02:30:00Z'); // Still September 30 in Brasília.
  assert.deepEqual(refundPeriodRange('today', now), { from: '2026-09-30', to: '2026-09-30' });
  assert.deepEqual(refundPeriodRange('yesterday', now), { from: '2026-09-29', to: '2026-09-29' });
  assert.deepEqual(refundPeriodRange('7', now), { from: '2026-09-24', to: '2026-09-30' });
  assert.deepEqual(refundPeriodRange('30', now), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(refundPeriodRange('month', now), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(refundPeriodRange('month', new Date('2026-10-01T03:00:00Z')), { from: '2026-10-01', to: '2026-10-01' });
  assert.deepEqual(refundPeriodRange('previousMonth', new Date('2024-03-01T12:00:00Z')), { from: '2024-02-01', to: '2024-02-29' });
  assert.deepEqual(refundPeriodRange('previousMonth', new Date('2026-01-01T12:00:00Z')), { from: '2025-12-01', to: '2025-12-31' });
  assert.deepEqual(refundPeriodRange('all', now), { from: '', to: '' });
  assert.throws(() => refundPeriodRange('invalid', now), TypeError);
});
test('refund date selection combines filters and clears selected rows only when the scope changes', () => {
  const state = createRefundManagementState();
  const all = refundManagementParams(state, 'store-a,store-b');
  assert.equal(all.has('from'), false); assert.equal(all.has('to'), false);
  Object.assign(state, { period: 'custom', from: '2026-09-02', to: '2026-09-03', query: 'sku', payment: 'pending' });
  state.selection.set('row', {});
  const filtered = refundManagementParams(state, 'store-a,store-b');
  assert.equal(filtered.get('from'), '2026-09-02'); assert.equal(filtered.get('to'), '2026-09-03');
  assert.equal(filtered.get('payment'), 'pending'); assert.equal(filtered.get('query'), 'sku');
  assert.equal(state.selection.size, 0);
  state.selection.set('row', {}); refundManagementParams(state, 'store-a,store-b');
  assert.equal(state.selection.size, 1);
  state.to = '2026-09-04'; refundManagementParams(state, 'store-a,store-b');
  assert.equal(state.selection.size, 0);
});
test('SAFE-T links display manual pending claims and deduplicate automatic IDs without inventing missing claims', () => {
  assert.equal(safeTLinksMarkup({}, { inline: true }), '');
  assert.equal(safeTLinksMarkup({}), '—');
  const manual = safeTLinksMarkup({ safeTId: '12345-12345-1234567', safeTIdSource: 'manual' }, { inline: true });
  assert.match(manual, /class="rm-safe-t-links"/);
  assert.match(manual, /href="https:\/\/sellercentral.amazon.com.br\/safet-claims\/claim\/12345-12345-1234567"/);
  assert.match(manual, /Informado no acompanhamento/);
  assert.match(manual, /target="_blank" rel="noopener noreferrer"/);
  assert.doesNotMatch(manual, /data-rm-edit|data-rm-order|RECEBIDO|CONCEDIDO/);
  const automatic = safeTLinksMarkup({ safeTId: ' claim-a, claim-b, claim-a, ', safeTIdSource: 'amazon-finances' });
  assert.equal((automatic.match(/<a /g) || []).length, 2);
  assert.match(automatic, /Identificado nos lançamentos da Amazon/);
  const request = safeTLinksMarkup({ safeTId: 'pending-claim', safeTIdSource: 'amazon-return-report' }, { inline: true });
  assert.match(request, /Solicitação identificada no relatório da Amazon/);
  assert.match(request, /safet-claims\/claim\/pending-claim/);
  assert.doesNotMatch(request, /RECEBIDO|CONCEDIDO/);
  assert.match(safeTLinksMarkup({ safeTId: 'claim-b', safeTIdSource: 'amazon-reports-and-finances' }), /Identificado nos relatórios e lançamentos da Amazon/);
  const hostile = safeTLinksMarkup({ safeTId: '"><img src=x onerror=alert(1)>/a?b=c' });
  assert.doesNotMatch(hostile, /<img|href="javascript:/);
  assert.match(hostile, /%22%3E%3Cimg/);
  assert.match(hostile, /&quot;&gt;&lt;img/);
});
function row(orderId, extra = {}) {
  return { storeId: 'store-a', orderId, order: { orderId }, fulfillmentMode: 'DBA',
    displayStatus: { code: 'RETURNED_TO_SELLER', label: 'Devolvido ao vendedor', source: 'tracking', partial: false },
    products: [{ sku: 'SKU  TEST', asin: 'ASIN-TEST', title: 'Produto de teste', quantityOrdered: 1 }],
    refund: { source: 'financial-transactions', byCurrency: [{ currency: 'BRL', totalCents: '-10000' }],
      latestPostedAt: at(1), count: 1, dateKnown: true, allocation: 'order' },
    refundCaseIds: [], customerReturns: [], returnedToSeller: null, ...extra };
}
const credit = (eventId, totalCents = '10000', extra = {}) => ({
  eventId, type: 'safe_t', label: 'SAFE-T', totalCents, currency: 'BRL', postedAt: at(5), ...extra,
});
const identity = item => ({ storeId: item.storeId, managementId: item.managementId, expectedVersion: item.management.version });

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  ensureFinancialCaseSchema(db); ensureRefundManagementSchema(db);
  t.after(() => db.close());
  const roles = Object.fromEntries(refundManagementStatuses(db).map(item => [item.semanticRole, item.code]));
  const list = filters => refundManagementView(db, { workflow: 'all', ...filters }, at(20));
  const find = (orderId, storeId = 'store-a') => list({ storeId }).items.find(item => item.orderId === orderId);
  const detail = (orderId, storeId = 'store-a') => { const item = find(orderId, storeId); return refundManagementDetail(db, storeId, item.managementId); };
  const sync = (rows, entries = [], now = at(10), storeIds = ['store-a', 'store-b']) => syncRefundManagement({
    db, rows, creditIndex: new Map(entries.map(([storeId, orderId, credits]) => [JSON.stringify([storeId, orderId]), credits])), storeIds, now,
  });
  const mutate = (input, now = at(15)) => mutateRefundManagement({ db, input, now });
  const snapshot = () => Object.fromEntries(['refund_management', 'refund_management_history', 'refund_management_notes',
    'financial_case_reviews', 'financial_case_review_history'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  return { db, roles, list, find, detail, sync, mutate, snapshot };
}

test('order details can save, revise and clear only the case ID, with version and store isolation', t => {
  const { sync, find, detail, mutate, snapshot } = fixture(t);
  sync([row('same-order'), row('same-order', { storeId: 'store-b' })]);
  mutate({ action: 'edit', items: [identity(find('same-order'))], safeTId: '12345-12345-1234567', shortNote: 'Manter anotação', note: 'Histórico preservado' });
  const before = detail('same-order'), other = detail('same-order', 'store-b');
  const saved = mutate({ action: 'edit', items: [identity(before)], caseId: '00123456789' }).items[0];
  assert.equal(saved.management.caseId, '00123456789');
  for (const field of ['status', 'workflowState', 'shortNote', 'safeTId', 'returnTracking', 'finalizedAt', 'confirmedAt']) assert.deepEqual(saved.management[field], before.management[field]);
  for (const field of ['notes', 'payment', 'refund']) assert.deepEqual(saved[field], before[field]);
  assert.deepEqual(detail('same-order', 'store-b'), other);
  const afterSave = snapshot();
  assert.throws(() => mutate({ action: 'edit', items: [identity(before)], caseId: '999' }), { code: 'REVIEW_CONFLICT' });
  assert.deepEqual(snapshot(), afterSave);
  const revised = mutate({ action: 'edit', items: [identity(saved)], caseId: '987654321' }).items[0];
  assert.equal(revised.management.caseId, '987654321');
  const cleared = mutate({ action: 'edit', items: [identity(revised)], caseId: '' }).items[0];
  assert.equal(cleared.management.caseId, '');
  assert.equal(cleared.management.safeTId, before.management.safeTId);
});

test('case ID is linked below SAFE-T in the order column even when the separate case column is hidden', () => {
  const state = createRefundManagementState(); state.visibleColumns = ['order'];
  const html = renderRefundManagement({ items: [{ ...row('700-0000000-0000001'), managementId: 'managed-order', management: { caseId: '00123456789', safeTId: '12345-12345-1234567' } }] }, state, { icon: () => '' });
  const order = html.indexOf('class="rm-order-identity"'), safeT = html.indexOf('class="rm-safe-t-links"', order), caseId = html.indexOf('class="rm-case-link"', order);
  assert.ok(order > 0 && safeT > order && caseId > safeT);
  assert.match(html, /caseID=00123456789/);
  assert.doesNotMatch(html, /<th>ID Caso<\/th>/);
  assert.equal(caseLinkMarkup({}, { inline: true }), '');
  assert.equal(caseLinkMarkup({}), '—');
  const hostile = caseLinkMarkup({ caseId: '"><img src=x onerror=alert(1)>' }, { inline: true });
  assert.doesNotMatch(hostile, /<img|href="javascript:/);
  assert.match(hostile, /&quot;&gt;&lt;img/);
  assert.match(hostile, /target="_blank" rel="noopener noreferrer"/);
});

test('note reader preserves long text, line breaks, legacy notes and newest-first history without executing markup', () => {
  const longNote = '<img src=x onerror=alert(1)>\n' + 'Texto longo & completo. '.repeat(80) + 'FIM DA OBSERVAÇÃO';
  const item = { management: { shortNote: 'Anotação <script>alert(1)</script>\nSegunda linha' },
    notes: [{ note: 'Primeira observação', createdAt: at(1) }, { note: longNote, createdAt: at(2) }],
    legacyReviews: [{ review: { notes: 'Histórico anterior <original>', updatedAt: at(1) } }] };
  const before = JSON.stringify(item);
  const html = refundNotesMarkup(item, { date: value => value }, 'observation');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /\nSegunda linha/);
  assert.match(html, /FIM DA OBSERVAÇÃO/);
  assert.match(html, /Histórico anterior &lt;original&gt;/);
  assert.ok(html.indexOf('FIM DA OBSERVAÇÃO') < html.indexOf('Primeira observação'));
  assert.ok(html.indexOf('<h3>Observações registradas') < html.indexOf('<h3>Anotação'));
  assert.doesNotMatch(html, /<(?:input|textarea|form|script|img)\b/);
  assert.equal(JSON.stringify(item), before);
  const empty = refundNotesMarkup({}, { date: value => value });
  assert.match(empty, /Nenhuma anotação registrada/);
  assert.match(empty, /Nenhuma observação registrada/);
});

test('bulk SAFE-T denial changes the analysis status while preserving finances and the active workflow', t => {
  const { roles, sync, find, detail, mutate } = fixture(t);
  const sources = [row('a'), row('b')]; sync(sources);
  const before = detail('a');
  mutate({ action: 'bulk-edit', items: ['a', 'b'].map(id => identity(find(id))), status: roles.safe_t_denied, note: 'Aguardar análise do recurso.' });
  sync(sources);
  for (const id of ['a', 'b']) {
    assert.equal(find(id).management.status, roles.safe_t_denied);
    assert.equal(find(id).management.workflowState, 'active');
  }
  assert.deepEqual(detail('a').refund, before.refund);
  assert.deepEqual(detail('a').payment, before.payment);
  assert.equal(detail('a').notes[0].note, 'Aguardar análise do recurso.');
});

test('proactive refunds use 60 days from original refund date immediately, including bulk edits and renamed statuses', t => {
  const { db, roles, sync, find, detail, mutate } = fixture(t);
  const a = row('a'); a.refund.firstEventAt = at(1); a.refund.latestPostedAt = at(12);
  const b = row('b'), otherStore = row('a', { storeId: 'store-b' });
  sync([a, b, otherStore]);
  const before = detail('a');
  const sourceBefore = db.prepare('SELECT source_json FROM refund_management WHERE store_id=? AND order_id=?').get('store-a', 'a').source_json;
  assert.equal(before.safeTDueAt, '2026-10-21T12:00:00.000Z');
  mutate({ action: 'bulk-edit', items: [identity(find('a')), identity(find('b'))], status: roles.awaiting_proactive_refund });
  for (const id of ['a', 'b']) {
    assert.equal(find(id).safeTDueAt, '2026-10-31T12:00:00.000Z');
    assert.equal(find(id).deadlinePolicy.days, 60);
    assert.equal(find(id).deadlinePolicy.kind, 'proactive-refund');
    assert.equal(find(id).management.color, '#7c3aed');
    assert.equal(find(id).management.workflowState, 'active');
  }
  assert.equal(find('a', 'store-b').safeTDueAt, '2026-10-21T12:00:00.000Z');
  assert.deepEqual(detail('a').refund, before.refund);
  assert.deepEqual(detail('a').payment, before.payment);
  assert.equal(db.prepare('SELECT source_json FROM refund_management WHERE store_id=? AND order_id=?').get('store-a', 'a').source_json, sourceBefore);
  const status = statusDefinition(db, roles.awaiting_proactive_refund);
  saveReviewStatus(db, { ...status, label: 'Aguardando crédito proativo', expectedVersion: status.version });
  sync([a, b, otherStore]);
  assert.equal(find('a').safeTDueAt, '2026-10-31T12:00:00.000Z', 'Stable role survives renamed label and sync');
  mutate({ action: 'edit', items: [identity(find('a'))], status: roles.analysis });
  assert.equal(find('a').safeTDueAt, before.safeTDueAt);
  assert.equal(find('a').deadlinePolicy.days, 50);
  sync([a, b, otherStore], [['store-a', 'b', [credit('proactive-credit')]]]);
  assert.equal(find('b').management.status, roles.safe_t_granted);
  assert.equal(find('b').deadlinePolicy.kind, 'internal-reference');
});

test('proactive reference drives sorting, deadline filters and overdue counts without fabricating missing dates', t => {
  const { db, roles, sync, find, mutate } = fixture(t);
  const unknown = row('unknown'); unknown.refund.latestPostedAt = null; unknown.refund.dateKnown = false;
  const incomplete = row('incomplete'); incomplete.refund.dateKnown = false;
  const pending = row('pending', { order: { orderId: 'pending', status: 'PENDING' }, displayStatus: ORDER_STATUS_CATALOG.PENDING });
  sync([row('normal'), row('proactive'), unknown, incomplete, pending]);
  mutate({ action: 'bulk-edit', items: ['proactive', 'unknown', 'incomplete', 'pending'].map(id => identity(find(id))), status: roles.awaiting_proactive_refund });
  for (const id of ['unknown', 'incomplete', 'pending']) assert.equal(find(id).safeTDueAt, null);
  const view = filters => refundManagementView(db, { workflow: 'active', sort: 'safeTDate', direction: 'asc', ...filters }, '2026-10-25T12:00:00.000Z');
  assert.deepEqual(view().items.slice(0, 2).map(item => item.orderId), ['normal', 'proactive']);
  assert.deepEqual(view({ deadline: 'overdue' }).items.map(item => item.orderId), ['normal']);
  assert.deepEqual(view({ deadline: 'upcoming' }).items.map(item => item.orderId), ['proactive']);
  assert.equal(view().summary.overdueSafeTCount, 1);
});

test('DBA proactive status is separate from the 60-day status and bulk edits calculate 50 days without changing refund evidence', t => {
  const { db, roles, sync, find, detail, mutate } = fixture(t);
  const sample = row('sample'); sample.refund.firstEventAt = at(18); sample.refund.latestPostedAt = at(25);
  const second = row('second', { refund: { ...sample.refund } });
  const otherStore = row('sample', { storeId: 'store-b', refund: { ...sample.refund } });
  sync([sample, second, otherStore]);
  const before = detail('sample');
  mutate({ action: 'bulk-edit', items: [identity(find('sample')), identity(find('second'))], status: roles.awaiting_proactive_dba_refund });
  for (const id of ['sample', 'second']) {
    assert.equal(find(id).management.label, 'Aguardando reembolso DBA (50 dias)');
    assert.equal(find(id).management.color, '#0f766e');
    assert.equal(find(id).management.workflowState, 'active');
    assert.equal(find(id).safeTDueAt, '2026-11-07T12:00:00.000Z');
    assert.equal(find(id).deadlinePolicy.kind, 'proactive-dba-refund');
    assert.equal(find(id).deadlinePolicy.days, 50);
    assert.match(find(id).deadlinePolicy.label, /SAFE-T encerrado/);
  }
  assert.equal(find('sample', 'store-b').management.status, roles.new);
  assert.deepEqual(detail('sample').refund, before.refund);
  assert.deepEqual(detail('sample').payment, before.payment);
  assert.deepEqual(detail('sample').notes, before.notes);
  const status = statusDefinition(db, roles.awaiting_proactive_dba_refund);
  saveReviewStatus(db, { ...status, label: 'DBA aguardando crédito', expectedVersion: status.version });
  sync([sample, second, otherStore]);
  assert.equal(find('sample').deadlinePolicy.kind, 'proactive-dba-refund', 'Renaming and synchronizing preserve the status role');
  mutate({ action: 'edit', items: [identity(find('second'))], status: roles.awaiting_proactive_refund });
  assert.equal(find('second').safeTDueAt, '2026-11-17T12:00:00.000Z');
  mutate({ action: 'edit', items: [identity(find('second'))], status: roles.awaiting_proactive_dba_refund });
  assert.equal(find('second').safeTDueAt, '2026-11-07T12:00:00.000Z');
  sync([sample, second, otherStore], [['store-a', 'sample', [credit('new-safe-t-credit')]]]);
  assert.equal(find('sample').management.status, roles.safe_t_granted);
  assert.equal(find('sample').deadlinePolicy.kind, 'internal-reference');
});

test('50-day DBA and 60-day proactive queues filter separately and missing refund dates stay unknown', t => {
  const { db, roles, sync, find, mutate } = fixture(t);
  const sources = ['dba', 'proactive', 'unknown', 'pending'].map(id => row(id));
  for (const source of sources) source.refund.latestPostedAt = at(18);
  sources[2].refund.dateKnown = false;
  sources[3].order.status = 'PENDING'; sources[3].displayStatus = ORDER_STATUS_CATALOG.PENDING;
  sync(sources);
  mutate({ action: 'bulk-edit', items: ['dba', 'unknown', 'pending'].map(id => identity(find(id))), status: roles.awaiting_proactive_dba_refund });
  mutate({ action: 'edit', items: [identity(find('proactive'))], status: roles.awaiting_proactive_refund });
  const view = filters => refundManagementView(db, { workflow: 'active', ...filters }, '2026-11-10T12:00:00.000Z');
  assert.equal(find('unknown').safeTDueAt, null);
  assert.equal(find('pending').safeTDueAt, null);
  assert.deepEqual(view({ deadline: 'overdue' }).items.map(item => item.orderId), ['dba']);
  assert.deepEqual(view({ deadline: 'upcoming' }).items.map(item => item.orderId), ['proactive']);
  assert.equal(view().statusOptions.find(item => item.code === roles.awaiting_proactive_dba_refund).count, 3);
  assert.equal(view({ status: roles.awaiting_proactive_dba_refund }).total, 3);
  assert.equal(view({ status: roles.awaiting_proactive_refund }).total, 1);
});

test('FBA waiting status uses 45 days from original refund in single and bulk edits, without changing money or other stores', t => {
  const { db, roles, sync, find, detail, mutate } = fixture(t);
  const sources = ['a', 'b'].map(id => row(id, { fulfillmentMode: 'FBA' }));
  for (const source of sources) { source.refund.firstEventAt = at(18); source.refund.latestPostedAt = at(25); }
  sources.push({ ...sources[0], storeId: 'store-b' });
  sync(sources);
  const before = detail('a');
  assert.ok(before.reviewStatuses.some(status => status.code === roles.awaiting_fba_refund));
  mutate({ action: 'bulk-edit', items: ['a', 'b'].map(id => identity(find(id))), status: roles.awaiting_fba_refund });
  for (const id of ['a', 'b']) {
    const item = find(id);
    assert.equal(item.management.label, 'Aguardando reembolso FBA (45 dias)');
    assert.equal(item.management.color, '#2563eb');
    assert.equal(item.management.workflowState, 'active');
    assert.equal(item.safeTDueAt, '2026-11-02T12:00:00.000Z');
    assert.equal(item.deadlinePolicy.kind, 'fba-refund');
    assert.equal(item.deadlinePolicy.days, 45);
  }
  assert.equal(find('a', 'store-b').management.status, roles.new);
  assert.deepEqual(detail('a').refund, before.refund);
  assert.deepEqual(detail('a').payment, before.payment);
  assert.deepEqual(detail('a').notes, before.notes);
  const status = statusDefinition(db, roles.awaiting_fba_refund);
  saveReviewStatus(db, { ...status, label: 'FBA aguardando crédito', expectedVersion: status.version });
  sync(sources);
  assert.equal(find('a').safeTDueAt, '2026-11-02T12:00:00.000Z');
  mutate({ action: 'edit', items: [identity(find('b'))], status: roles.awaiting_proactive_refund });
  assert.equal(find('b').safeTDueAt, '2026-11-17T12:00:00.000Z');
  mutate({ action: 'edit', items: [identity(find('b'))], status: roles.awaiting_fba_refund });
  assert.equal(find('b').safeTDueAt, '2026-11-02T12:00:00.000Z');
});

test('FBA 45-day deadline drives filters and sorting; unknown dates and pending orders remain undated', t => {
  const { db, roles, sync, find, mutate } = fixture(t);
  const sources = ['fba', 'dba', 'unknown', 'pending'].map(id => row(id));
  for (const source of sources) source.refund.latestPostedAt = at(18);
  sources[0].fulfillmentMode = 'FBA'; sources[2].refund.dateKnown = false;
  sources[3].order.status = 'PENDING'; sources[3].displayStatus = ORDER_STATUS_CATALOG.PENDING;
  sync(sources);
  mutate({ action: 'bulk-edit', items: ['fba', 'unknown', 'pending'].map(id => identity(find(id))), status: roles.awaiting_fba_refund });
  mutate({ action: 'edit', items: [identity(find('dba'))], status: roles.awaiting_proactive_dba_refund });
  const view = filters => refundManagementView(db, { workflow: 'active', sort: 'safeTDate', direction: 'asc', ...filters }, '2026-11-04T12:00:00.000Z');
  assert.equal(find('unknown').safeTDueAt, null);
  assert.equal(find('pending').safeTDueAt, null);
  assert.deepEqual(view().items.slice(0, 2).map(item => item.orderId), ['fba', 'dba']);
  assert.deepEqual(view({ deadline: 'overdue' }).items.map(item => item.orderId), ['fba']);
  assert.deepEqual(view({ deadline: 'upcoming' }).items.map(item => item.orderId), ['dba']);
  assert.equal(view().summary.overdueSafeTCount, 1);
  assert.equal(view({ status: roles.awaiting_fba_refund }).total, 3);
  assert.equal(view({ status: roles.awaiting_proactive_dba_refund }).total, 1);
});

test('management starts active, isolates stores, and never overwrites existing financial reviews', t => {
  const { db, roles, sync, find, detail, snapshot } = fixture(t);
  db.prepare('INSERT INTO financial_case_reviews VALUES(?,?,?,?,?,?,?)')
    .run('store-a', 'refunds', 'legacy-case', roles.analysis, 'Análise anterior preservada.', 3, at(3));
  const before = snapshot();
  const a = row('same', { refundCaseIds: ['legacy-case'] }), b = row('same', { storeId: 'store-b' });
  assert.deepEqual(sync([a, b]), { created: 2, updated: 0, reopened: 0, missing: 0 });
  assert.notEqual(find('same').managementId, find('same', 'store-b').managementId);
  assert.equal(find('same').management.status, roles.analysis);
  assert.equal(find('same').management.workflowState, 'active');
  assert.equal(find('same', 'store-b').management.status, roles.new);
  assert.equal(detail('same').legacyReviews[0].review.notes, 'Análise anterior preservada.');
  assert.deepEqual(snapshot().financial_case_reviews, before.financial_case_reviews);
  assert.deepEqual(snapshot().financial_case_review_history, before.financial_case_review_history);
  assert.deepEqual(sync([a, b]), { created: 0, updated: 0, reopened: 0, missing: 0 });
  assert.equal(detail('same').history.length, 0);
  assert.equal(refundManagementDetail(db, 'store-b', find('same').managementId), null);
});

test('pending order payments suppress financial alerts and confirmation without removing credit evidence or manual management', t => {
  const { roles, sync, find, detail, mutate, list } = fixture(t);
  const pending = row('pending', { order:{orderId:'pending',status:'PENDING'}, displayStatus:ORDER_STATUS_CATALOG.PENDING });
  sync([pending],[['store-a','pending',[credit('credit-a','18000')]]]);
  const source=find('pending');
  assert.equal(source.financialEligibility.included,false);
  assert.equal(source.payment.byCurrency[0].totalCents,'18000','Original evidence remains available for audit');
  assert.equal(source.payment.confirmationRequired,false);assert.deepEqual(source.payment.newByCurrency,[]);
  assert.equal(source.payment.variance.requiresAcknowledgement,false);assert.deepEqual(source.payment.variance.byCurrency,[]);
  assert.equal(source.safeTDueAt,null);
  assert.deepEqual(list().summary.activeRefundByCurrency,[]);assert.deepEqual(list().summary.paymentDetectedByCurrency,[]);
  assert.equal(list().summary.activeCount,1);assert.equal(list().summary.paymentAlertCount,0);assert.equal(list().summary.excludedPendingCaseCount,1);
  assert.equal(list({payment:'pending'}).total,0);assert.equal(list({payment:'paid'}).total,0);
  assert.equal(list({status:roles.safe_t_received}).total,0);
  assert.throws(()=>mutate({action:'finalize',items:[identity(source)],status:roles.concluded,acknowledgePaymentVariance:false}),{code:'FINALIZATION_REASON_REQUIRED'});
  mutate({action:'finalize',items:[identity(source)],status:roles.concluded,unpaidReason:'other',acknowledgePaymentVariance:false,note:'Finalização apenas operacional.'});
  const finalized=detail('pending');
  assert.equal(finalized.management.finalizationReason,'other');assert.deepEqual(finalized.payment.confirmedByCurrency,[]);
  assert.equal(finalized.payment.confirmedAt,null);assert.equal(finalized.notes[0].note,'Finalização apenas operacional.');
  assert.equal(sync([pending],[['store-a','pending',[credit('credit-a','18000'),credit('credit-b','1000')]]],at(22)).reopened,0);
  assert.equal(find('pending').management.workflowState,'finalized');assert.equal(find('pending').payment.confirmationRequired,false);
});

test('automatic return signals update without reopening a finalized case or modifying its manual and financial history', t => {
  const { roles, sync, find, detail, mutate, snapshot } = fixture(t);
  const source = row('a'), anotherStore = row('a', { storeId: 'store-b' });
  sync([source, anotherStore]);
  mutate({ action: 'edit', items: [identity(find('a'))], note: 'Revisão manual preservada.', returnTracking: 'MANUAL-TRACK' });
  mutate({ action: 'finalize', items: [identity(find('a'))], status: roles.concluded, unpaidReason: 'return_received', acknowledgePaymentVariance: false });
  const before = detail('a'), beforeTables = snapshot();
  assert.equal(before.returnSignals.returnedToSeller.historical, false, 'Manual finalization is not automatic return evidence');
  const operational = { ...source, customerReturns: [{ returnId: 'request-a', returnStatus: 'Approved',
    reportType: 'GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE', requestedAt: '2026-09-01', receivedAt: null, observedAt: at(21) }],
    returnedToSeller: { detectedAt: at(18), statusObservedAt: at(21), currentReturnedPackageCount: 1,
      returnedPackageCount: 2, packageCount: 2, partialReturn: false, returnStatusChanged: true } };
  assert.deepEqual(sync([operational, anotherStore], [], at(22)), { created: 0, updated: 0, reopened: 0, missing: 0 });
  const after = detail('a');
  assert.deepEqual(after.management, before.management);
  assert.deepEqual(after.refund, before.refund);
  assert.deepEqual(after.payment, before.payment);
  assert.deepEqual(after.history, before.history);
  assert.deepEqual(after.notes, before.notes);
  assert.equal(after.returnSignals.returnedToSeller.current, true);
  assert.equal(after.returnSignals.returnedToSeller.partial, true);
  assert.equal(after.returnSignals.unknownCustomerReturns[0].returnStatus, 'Approved');
  assert.equal(after.returnSignals.openCustomerReturns.length, 0);
  assert.equal(after.returnLinks.customerReturns[0].observedAt, at(21));
  assert.equal(after.returnLinks.customerReturns[0].reportType, 'GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE');
  assert.equal(find('a', 'store-b').returnSignals.returnedToSeller.historical, false);
  assert.equal(find('a', 'store-b').returnSignals.unknownCustomerReturns.length, 0);
  const updatedTables = snapshot();
  for (const table of Object.keys(beforeTables).filter(table => table !== 'refund_management')) assert.deepEqual(updatedTables[table], beforeTables[table]);
});

test('operational status OR filtering and facets precede pagination while respecting manual status and the full queue scope', t => {
  const { roles, sync, find, list, mutate, snapshot } = fixture(t);
  const automatic = (orderId, code, extra = {}) => row(orderId, { displayStatus: ORDER_STATUS_CATALOG[code], ...extra });
  sync([automatic('returned', 'RETURNED_TO_SELLER'), automatic('lost', 'LOST'), automatic('unknown', 'UNKNOWN'),
    automatic('cancelled', 'CANCELLED', { displayStatus: decorateOrderStatus({ status: 'CANCELLED', packages: [{ detailedStatus: 'RETURNED_TO_SELLER' }] }).displayStatus }),
    automatic('finalized', 'RETURNED_TO_SELLER'), automatic('other-store', 'RETURNED_TO_SELLER', { storeId: 'store-b' }),
    automatic('other-mode', 'RETURNED_TO_SELLER', { fulfillmentMode: 'FBA' }),
    automatic('other-query', 'RETURNED_TO_SELLER', { products: [{ sku: 'UNRELATED' }] }),
    automatic('other-date', 'RETURNED_TO_SELLER', { refund: { ...row('x').refund, latestPostedAt: at(20) } })]);
  const editable = list().items.filter(item => !['cancelled','finalized'].includes(item.orderId)).map(identity);
  mutate({ action: 'bulk-edit', items: editable, status: roles.analysis });
  mutate({ action: 'finalize', items: [identity(find('finalized'))], status: roles.analysis, unpaidReason: 'other', acknowledgePaymentVariance: false });
  const before = snapshot();
  const filters = { storeId: 'store-a', from: '2026-09-01', to: '2026-09-05', query: 'sku test', mode: 'DBA',
    workflow: 'active', status: roles.analysis, orderStatus: 'returned_to_seller,LOST', limit: 1, offset: 1 };
  const result = list(filters);
  assert.equal(result.total, 2); assert.equal(result.items.length, 1); assert.equal(result.hasMore, false);
  assert.equal(result.summary.activeRefundByCurrency[0].totalCents, '20000');
  assert.deepEqual(result.summary.workflowCounts, { all: 3, active: 2, finalized: 1 });
  assert.deepEqual(result.orderStatusOptions, [
    { code: 'RETURNED_TO_SELLER', label: 'Devolvido ao vendedor', count: 1 },
    { code: 'LOST', label: 'Extraviado', count: 1 }, { code: 'UNKNOWN', label: 'Não informado', count: 1 },
  ]);
  const allStates = list({ ...filters, orderStatus: 'all', limit: 100, offset: 0 });
  assert.equal(allStates.total, 3);
  assert.deepEqual(allStates.orderStatusOptions, result.orderStatusOptions);
  assert.equal(list({ ...filters, orderStatus: 'UNKNOWN', offset: 0 }).items[0].orderId, 'unknown');
  const cancelled = list({ ...filters, status: 'all', orderStatus: 'CANCELLED', offset: 0 });
  assert.equal(cancelled.total, 1);
  assert.equal(cancelled.items[0].orderId, 'cancelled');
  assert.equal(cancelled.items[0].management.status, roles.new, 'Automatic status does not select or change manual status');
  assert.equal(cancelled.items[0].displayStatus.label, 'Cancelado');
  assert.equal(list({ ...filters, workflow: 'all', offset: 0 }).orderStatusOptions.find(item => item.code === 'RETURNED_TO_SELLER').count, 2);
  assert.deepEqual(snapshot(), before, 'Read filters do not synchronize or mutate evidence and reviews');
});

test('operational status selection validates CSV independently from the single manual status', t => {
  const { sync, list, snapshot } = fixture(t); sync([row('a')]);
  const before = snapshot();
  for (const orderStatus of [null, {}, [], '', 'LOST,', ',LOST', 'LOST, LOST', 'LOST,lost', 'all,LOST',
    'LOST/NEW', 'A'.repeat(51), Array.from({ length: 51 }, (_, index) => `S${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + index % 26)}`).join(',')]) {
    assert.throws(() => list({ orderStatus }), { code: 'INVALID_PARAMETERS' });
  }
  assert.throws(() => list({ status: 'pending,in_review', orderStatus: 'LOST' }), { code: 'INVALID_PARAMETERS' });
  assert.equal(list({ orderStatus: 'future_status' }).total, 0);
  assert.deepEqual(list({ orderStatus: 'ALL' }).items, list().items);
  assert.deepEqual(snapshot(), before);
});

test('editing a concluding status does not finalize; notes append, blank bulk fields preserve short notes, and automatic badges cannot be assigned', t => {
  const { roles, sync, find, detail, mutate, snapshot, list } = fixture(t);
  sync([row('a'), row('b')], [['store-a', 'a', [credit('safe-t-a')]]]);
  mutate({ action: 'edit', items: [identity(find('a'))], status: roles.concluded,
    shortNote: 'Resumo original', note: 'Primeira observação', caseId: '123456789', safeTId: '12345-12345-1234567', returnTracking: 'TRACK-TEST' });
  assert.equal(find('a').management.workflowState, 'active');
  assert.equal(find('a').payment.confirmationRequired, true);
  assert.equal(find('a').management.finalizedAt, null);
  assert.equal(find('a').management.caseId, '123456789');
  mutate({ action: 'bulk-edit', items: [identity(find('a')), identity(find('b'))], status: roles.analysis,
    shortNote: '', note: 'Observação em massa' });
  assert.equal(find('a').management.shortNote, 'Resumo original');
  assert.deepEqual(detail('a').notes.map(item => item.note), ['Primeira observação', 'Observação em massa']);
  assert.deepEqual(detail('b').notes.map(item => item.note), ['Observação em massa']);
  assert.equal(detail('a').history.length, 2);
  const before = snapshot();
  for (const status of [roles.safe_t_received, roles.easy_ship_received]) {
    assert.throws(() => mutate({ action: 'edit', items: [identity(find('a'))], status }), { code: 'INVALID_MANAGEMENT' });
  }
  assert.deepEqual(snapshot(), before);
  assert.equal(list({ status: roles.safe_t_received }).total, 1);
  assert.equal(find('a').management.status, roles.analysis);
  mutate({ action: 'edit', items: [identity(find('a'))], status: null });
  assert.equal(list({ status: 'none' }).total, 1);
  const unchanged = snapshot();
  assert.equal(mutate({ action: 'edit', items: [identity(find('a'))], status: null }).changed, 0);
  assert.deepEqual(snapshot(), unchanged);
});

test('mixed finalization requires a valid status and unpaid reason for the whole selection, then confirms each item correctly', t => {
  const { roles, sync, find, detail, mutate, snapshot } = fixture(t);
  sync([row('paid'), row('unpaid')], [['store-a', 'paid', [credit('paid-credit')]]]);
  const input = { action: 'finalize', items: [identity(find('paid')), identity(find('unpaid'))],
    status: roles.concluded, acknowledgePaymentVariance: false };
  let before = snapshot();
  assert.throws(() => mutate(input), { code: 'FINALIZATION_REASON_REQUIRED' });
  assert.deepEqual(snapshot(), before);
  assert.throws(() => mutate({ ...input, status: roles.safe_t_received, unpaidReason: 'other' }), { code: 'INVALID_MANAGEMENT' });
  assert.deepEqual(snapshot(), before);
  mutate({ action: 'edit', items: [identity(find('unpaid'))], note: 'Outro editor alterou esta linha.' });
  before = snapshot();
  assert.throws(() => mutate({ ...input, unpaidReason: 'other' }), { code: 'REVIEW_CONFLICT' });
  assert.deepEqual(snapshot(), before);
  const saved = mutate({ ...input, items: [identity(find('paid')), identity(find('unpaid'))],
    unpaidReason: 'return_received', shortNote: 'Decisão registrada', note: 'Conferência final' });
  assert.equal(saved.changed, 2);
  assert.equal(saved.confirmedPayments, 1);
  assert.equal(find('paid').management.finalizationReason, 'amazon_payment');
  assert.equal(find('unpaid').management.finalizationReason, 'return_received');
  assert.deepEqual(find('paid').payment.confirmedByCurrency, [{ currency: 'BRL', totalCents: '10000' }]);
  assert.deepEqual(find('unpaid').payment.confirmedByCurrency, []);
  assert.equal(find('paid').payment.confirmationRequired, false);
  assert.equal(find('paid').management.workflowState, 'finalized');
  assert.deepEqual(detail('unpaid').notes.map(item => item.note), ['Outro editor alterou esta linha.', 'Conferência final']);
  assert.throws(() => mutate({ ...input, items: [identity(find('paid'))], status: roles.analysis }), { code: 'WORKFLOW_CONFLICT' });
});

test('SAFE-T received can finalize a mixed bulk selection as a manual reason without inventing financial credits', t => {
  const { roles, sync, find, detail, mutate, list } = fixture(t);
  sync([row('paid'), row('manual-a'), row('manual-b')], [['store-a', 'paid', [credit('paid-credit')]]]);
  const manualIds = ['manual-a', 'manual-b'];
  mutate({ action: 'bulk-edit', items: manualIds.map(id => identity(find(id))), status: roles.safe_t_granted });
  const before = manualIds.map(id => detail(id));
  const result = mutate({ action: 'finalize', items: ['paid', ...manualIds].map(id => identity(find(id))),
    status: roles.safe_t_granted, unpaidReason: 'safe_t_received', acknowledgePaymentVariance: false });
  assert.equal(result.changed, 3);
  assert.equal(result.confirmedPayments, 1);
  assert.equal(find('paid').management.finalizationReason, 'amazon_payment');
  for (const previous of before) {
    const current = detail(previous.orderId);
    assert.equal(current.management.workflowState, 'finalized');
    assert.equal(current.management.status, roles.safe_t_granted);
    assert.equal(current.management.finalizationReason, 'safe_t_received');
    assert.deepEqual(current.payment, previous.payment);
    assert.deepEqual(current.refund, previous.refund);
    assert.equal(current.history.at(-1).changes.finalizationReason.current, 'safe_t_received');
  }
  assert.equal(list({ workflow: 'active' }).total, 0);
  assert.equal(list({ workflow: 'finalized' }).total, 3);
});

test('financial changes invalidate an open finalization and rollback includes every history and note write', t => {
  const { db, roles, sync, find, mutate, snapshot } = fixture(t);
  const original = [row('a'), row('b')];
  sync(original);
  const stale = identity(find('a'));
  sync([row('a', { refund: { ...original[0].refund, byCurrency: [{ currency: 'BRL', totalCents: '-11000' }] } }), original[1]], [], at(12));
  let before = snapshot();
  assert.throws(() => mutate({ action: 'finalize', items: [stale], status: roles.concluded,
    unpaidReason: 'other', acknowledgePaymentVariance: false }), { code: 'REVIEW_CONFLICT' });
  assert.deepEqual(snapshot(), before);
  const failing = find('b').managementId;
  db.exec(`CREATE TRIGGER reject_second_audit BEFORE INSERT ON refund_management_history
    WHEN NEW.management_id='${failing}' BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END;`);
  before = snapshot();
  assert.throws(() => mutate({ action: 'bulk-edit', items: [identity(find('a')), identity(find('b'))],
    status: roles.analysis, note: 'Nenhuma anotação deve persistir.' }), /fixture audit failure/);
  assert.deepEqual(snapshot(), before);
  assert.equal(db.isTransaction, false);
});

test('manual reopening preserves confirmed credits and notes; new money reopens once while an identical reimport does not', t => {
  const { roles, sync, find, detail, mutate, snapshot } = fixture(t);
  const source = row('a'), entries = [['store-a', 'a', [credit('original')]]];
  sync([source], entries);
  mutate({ action: 'finalize', items: [identity(find('a'))], status: roles.concluded,
    acknowledgePaymentVariance: false, note: 'Pagamento conferido.' });
  const confirmed = find('a').payment.confirmedByCurrency;
  mutate({ action: 'reopen', items: [identity(find('a'))] });
  assert.equal(find('a').management.workflowState, 'active');
  assert.equal(find('a').management.status, roles.analysis);
  assert.equal(find('a').management.finalizationReason, null);
  assert.deepEqual(find('a').payment.confirmedByCurrency, confirmed);
  assert.equal(find('a').payment.confirmationRequired, false);
  assert.equal(detail('a').notes[0].note, 'Pagamento conferido.');
  assert.throws(() => mutate({ action: 'finalize', items: [identity(find('a'))], status: roles.concluded,
    acknowledgePaymentVariance: false }), { code: 'FINALIZATION_REASON_REQUIRED' });
  mutate({ action: 'finalize', items: [identity(find('a'))], status: roles.concluded,
    unpaidReason: 'other', acknowledgePaymentVariance: false });
  const before = snapshot();
  assert.deepEqual(sync([source], entries, at(16)), { created: 0, updated: 0, reopened: 0, missing: 0 });
  assert.deepEqual(snapshot(), before);
  const newCredit = [['store-a', 'a', [credit('original'), credit('additional', '2000', { postedAt: at(17) })]]];
  assert.equal(sync([source], newCredit, at(18)).reopened, 1);
  assert.deepEqual(find('a').payment.newByCurrency, [{ currency: 'BRL', totalCents: '2000' }]);
  assert.deepEqual(find('a').payment.confirmedByCurrency, confirmed);
  assert.equal(find('a').management.status, roles.safe_t_granted);
  assert.equal(detail('a').history.at(-1).type, 'automatic-reopen');
  assert.equal(detail('a').history.at(-1).changes.previousFinalizationReason, 'other');
  const reopened = snapshot();
  assert.equal(sync([source], newCredit, at(19)).reopened, 0);
  assert.deepEqual(snapshot(), reopened);
});

test('SAFE-T grants are assigned from linked positive credits once, preserve manual work, and exclude Easy Ship and pending payment', t => {
  const { roles, sync, find, detail, mutate, list } = fixture(t);
  const rows = [row('safe'), row('easy'), row('pending', { order:{orderId:'pending',status:'PENDING'} }), row('safe', {storeId:'store-b'})];
  sync(rows);
  mutate({action:'edit',items:[identity(find('safe'))],status:roles.analysis,caseId:'12345',shortNote:'Conferir mercadoria',note:'Histórico preservado.'});
  const credits = [['store-a','safe',[credit('safe')]],['store-a','easy',[credit('easy','10000',{type:'easy_ship'})]],['store-a','pending',[credit('pending')]]];
  sync(rows, credits);
  const granted = find('safe');
  assert.equal(granted.management.status,roles.safe_t_granted);
  assert.equal(granted.management.label,'SAFE-T CONCEDIDO');
  assert.equal(granted.management.workflowState,'active');
  assert.equal(granted.management.caseId,'12345');
  assert.equal(granted.management.shortNote,'Conferir mercadoria');
  assert.equal(detail('safe').notes[0].note,'Histórico preservado.');
  assert.equal(granted.payment.confirmationRequired,true);
  assert.notEqual(find('easy').management.status,roles.safe_t_granted);
  assert.notEqual(find('pending').management.status,roles.safe_t_granted);
  assert.notEqual(find('safe','store-b').management.status,roles.safe_t_granted);
  assert.equal(list({storeId:'store-a',status:roles.safe_t_granted}).total,1);
  assert.equal(sync(rows,credits).updated,0);
  mutate({action:'edit',items:[identity(find('safe'))],status:roles.analysis});
  assert.equal(sync(rows,credits).updated,0);
  assert.equal(find('safe').management.status,roles.analysis,'An explicit later decision is preserved for the same evidence');
});

test('variance thresholds use exact BigInt cents, keep currencies separate and never treat missing debit as zero', () => {
  const state = (debit, paid, allocation = 'order') => refundPaymentState({
    refund: { byCurrency: [{ currency: 'BRL', totalCents: debit }], allocation },
    payment: { byCurrency: [{ currency: 'BRL', totalCents: paid }] },
  });
  assert.equal(state('10000', '8000').variance.byCurrency[0].kind, 'much_lower');
  assert.equal(state('10000', '12000').variance.byCurrency[0].kind, 'much_higher');
  assert.equal(state('10000', '8001').variance.byCurrency[0].kind, 'within_range');
  assert.equal(state('10000', '11999').variance.byCurrency[0].kind, 'within_range');
  assert.equal(state('9995', '7996').variance.byCurrency[0].kind, 'within_range');
  assert.equal(state('90071992547409930000', '72057594037927944000').variance.byCurrency[0].kind, 'much_lower');
  assert.equal(state('90071992547409930000', '72057594037927944001').variance.byCurrency[0].kind, 'within_range');
  const unknown = state(null, '10000');
  assert.equal(unknown.variance.byCurrency[0].kind, 'uncomparable');
  assert.equal(unknown.variance.byCurrency[0].differenceCents, null);
  assert.equal(unknown.variance.requiresAcknowledgement, true);
  assert.equal(state('10000', '10000', 'multiple-orders-unallocated').variance.byCurrency[0].kind, 'uncomparable');
  const separate = refundPaymentState({ refund: { allocation: 'order', byCurrency: [{ currency: 'BRL', totalCents: '10000' }] },
    payment: { byCurrency: [{ currency: 'USD', totalCents: '200' }] } }, [{ currency: 'BRL', totalCents: '50000' }]);
  assert.deepEqual(separate.newByCurrency, [{ currency: 'USD', totalCents: '200' }]);
  assert.equal(separate.variance.byCurrency[0].kind, 'uncomparable');
  assert.equal(separate.variance.byCurrency[0].differenceCents, null);
});

test('an increased refund debit or corrected first refund date reopens a finalized case only once', t => {
  const { roles, sync, find, detail, mutate } = fixture(t);
  const debit = row('debit'), dated = row('dated', { refund: { ...row('dated').refund, firstEventAt: at(3), latestPostedAt: at(8) } });
  sync([debit, dated]);
  mutate({ action: 'finalize', items: [identity(find('debit')), identity(find('dated'))], status: roles.concluded,
    unpaidReason: 'manual_refund', acknowledgePaymentVariance: false, note: 'Conferência anterior' });
  const versions = [find('debit').management.version, find('dated').management.version];
  const revised = [row('debit', { refund: { ...debit.refund, byCurrency: [{ currency: 'BRL', totalCents: '-12000' }] } }),
    row('dated', { refund: { ...dated.refund, firstEventAt: at(1) } })];
  assert.equal(sync(revised, [], at(18)).reopened, 2);
  for (const [index, orderId] of ['debit', 'dated'].entries()) {
    assert.equal(find(orderId).management.workflowState, 'active');
    assert.equal(find(orderId).management.version, versions[index] + 1);
    assert.equal(detail(orderId).history.at(-1).type, 'automatic-reopen');
    assert.equal(detail(orderId).notes[0].note, 'Conferência anterior');
  }
  assert.equal(find('dated').safeTDueAt, '2026-10-21T12:00:00.000Z');
  assert.equal(sync(revised, [], at(19)).reopened, 0);
});

test('unknown refund amount and original date remain unknown and require acknowledgement when money is confirmed', t => {
  const { roles, sync, find, mutate, list, snapshot } = fixture(t);
  const unknown = row('unknown', { refund: { source: 'return-report', byCurrency: [{ currency: 'BRL', totalCents: null }],
    latestPostedAt: null, count: null, dateKnown: false, allocation: 'reported-not-reconciled' } });
  sync([unknown], [['store-a', 'unknown', [credit('known-payment')]]]);
  assert.equal(find('unknown').refund.byCurrency[0].totalCents, null);
  assert.equal(find('unknown').safeTDueAt, null);
  assert.equal(find('unknown').refund.lastEventAt, null);
  assert.equal(list({ from: '2026-09-01', to: '2026-09-30' }).total, 0);
  assert.equal(list({ deadline: 'upcoming' }).total, 0);
  assert.equal(list({ deadline: 'overdue' }).total, 0);
  const before = snapshot();
  const input = { action: 'finalize', items: [identity(find('unknown'))], status: roles.concluded, acknowledgePaymentVariance: false };
  assert.throws(() => mutate(input), { code: 'PAYMENT_VARIANCE_REQUIRED' });
  assert.deepEqual(snapshot(), before);
  assert.equal(mutate({ ...input, acknowledgePaymentVariance: true }).confirmedPayments, 1);
  assert.equal(find('unknown').refund.byCurrency[0].totalCents, null);
});

test('a positive refund amount in a return report cannot be treated as a known zero seller debit', t => {
  const { sync, find } = fixture(t);
  const report = row('report-only', { refund: { source: 'return-report',
    byCurrency: [{ currency: 'BRL', totalCents: '5000' }], latestPostedAt: null,
    count: null, dateKnown: false, allocation: 'reported-not-reconciled' } });
  const financialCredit = row('financial-credit', { refund: { ...row('financial-credit').refund,
    byCurrency: [{ currency: 'BRL', totalCents: '5000' }] } });
  sync([report, financialCredit]);
  assert.equal(find('report-only').refund.byCurrency[0].totalCents, null);
  assert.equal(find('report-only').safeTDueAt, null);
  assert.equal(find('financial-credit').refund.byCurrency[0].totalCents, '0');
  assert.equal(find('financial-credit').refund.netByCurrency[0].totalCents, '5000');
});

test('filters and facets precede pagination, future deadlines are not limited to seven days and confirmed payments stay distinct', t => {
  const { roles, sync, find, mutate, list } = fixture(t);
  sync([row('paid'), row('unpaid'), row('other', { storeId: 'store-b' })], [['store-a', 'paid', [credit('paid')]]]);
  mutate({ action: 'edit', items: [identity(find('paid'))], status: roles.analysis });
  const page = list({ storeId: 'store-a', query: 'sku test', limit: 1 });
  assert.equal(page.total, 2);
  assert.equal(page.items.length, 1);
  assert.equal(page.hasMore, true);
  assert.equal(page.summary.activeCount, 2);
  assert.equal(page.summary.paymentAlertCount, 1);
  assert.equal(page.statusOptions.find(item => item.code === roles.safe_t_received).count, 1);
  assert.equal(list({ storeId: 'store-a', status: roles.analysis }).statusOptions.find(item => item.code === roles.new).count, 1);
  assert.equal(list({ storeId: 'store-a', deadline: 'upcoming' }).total, 2);
  assert.equal(list({ storeId: 'store-a', payment: 'pending' }).total, 1);
  assert.equal(list({ storeId: 'store-a', payment: 'paid' }).total, 0);
  mutate({ action: 'finalize', items: [identity(find('paid'))], status: roles.concluded, acknowledgePaymentVariance: false });
  assert.equal(list({ storeId: 'store-a', payment: 'paid' }).total, 1);
  assert.equal(list({ storeId: 'store-a', payment: 'pending' }).total, 0);
  assert.equal(list({ storeId: 'store-a', workflow: 'active' }).total, 1);
});

test('malformed or duplicate bulk selection and foreign identities cannot mutate management rows', t => {
  const { roles, sync, find, mutate, snapshot } = fixture(t);
  sync([row('a'), row('a', { storeId: 'store-b' })]);
  const first = identity(find('a')), before = snapshot();
  for (const items of [[first, first], [{ ...first, expectedVersion: -1 }], [{ ...first, expectedVersion: undefined }],
    Array.from({ length: 101 }, () => first)]) {
    assert.throws(() => mutate({ action: 'bulk-edit', items, status: roles.analysis }), { code: 'INVALID_MANAGEMENT' });
    assert.deepEqual(snapshot(), before);
  }
  assert.throws(() => mutate({ action: 'bulk-edit', items: [first, { ...first, storeId: 'store-b' }],
    status: roles.analysis }), { code: 'CASE_NOT_FOUND' });
  assert.deepEqual(snapshot(), before);
});

test('date sorting precedes pagination, overdue uses São Paulo calendar days, and search includes tracking and older notes', t => {
  const { db, sync, find, mutate } = fixture(t);
  const first = row('first'), second = row('second', { refund: { ...row('second').refund, latestPostedAt: at(2) } });
  const undated = row('undated', { refund: { ...row('undated').refund, latestPostedAt: null, dateKnown: false } });
  sync([second, undated, first]);
  mutate({ action: 'edit', items: [identity(find('first'))], returnTracking: 'TRACK-EXCLUSIVE', note: 'Antiga evidência específica' });
  mutate({ action: 'edit', items: [identity(find('first'))], note: 'Observação mais recente' });
  const view = (filters = {}, now = '2026-10-22T02:59:59.000Z') => refundManagementView(db, { storeId: 'store-a', ...filters }, now);
  assert.deepEqual(view({ sort: 'refundDate', direction: 'asc' }).items.map(item => item.orderId), ['first', 'second', 'undated']);
  assert.deepEqual(view({ sort: 'safeTDate', direction: 'desc' }).items.map(item => item.orderId), ['second', 'first', 'undated']);
  const page = view({ sort: 'safeTDate', direction: 'desc', limit: 1, offset: 1 });
  assert.equal(page.total, 3);
  assert.equal(page.items[0].orderId, 'first');
  assert.equal(view({ deadline: 'overdue' }).total, 0, 'October 21 in São Paulo remains today even after midnight UTC');
  assert.deepEqual(view({ deadline: 'upcoming' }).items.map(item => item.orderId), ['first', 'second']);
  const nextDay = view({ deadline: 'overdue' }, '2026-10-22T03:00:00.000Z');
  assert.deepEqual(nextDay.items.map(item => item.orderId), ['first']);
  assert.equal(nextDay.summary.overdueSafeTCount, 1);
  assert.equal(view({ query: 'track-exclusive' }).items[0].orderId, 'first');
  assert.equal(view({ query: 'antiga evidência' }).items[0].orderId, 'first');
  assert.equal(view({ query: 'antiga evidência', storeId: 'store-b' }).total, 0);
});

test('customer did not return: dedicated 60-day status works in bulk, stays active and preserves unknown dates and store boundaries', t => {
  const { db, roles, sync, find, detail, mutate, list } = fixture(t);
  const sources = ['a','b','unknown'].map(id => row(id));
  for (const source of sources) { source.refund.firstEventAt=at(18); source.refund.latestPostedAt=at(25); }
  sources[2].refund.dateKnown=false;sources.push({...sources[0],storeId:'store-b'});sync(sources);
  const before=detail('a');
  mutate({action:'bulk-edit',items:['a','b','unknown'].map(id=>identity(find(id))),status:roles.awaiting_customer_return});
  assert.equal(find('a').management.label,'Devolução de cliente · SAFE-T 60 dias');
  assert.equal(find('a').management.color,'#b7791f');assert.equal(find('a').management.workflowState,'active');
  assert.equal(find('a').safeTDueAt,'2026-11-17T12:00:00.000Z');assert.equal(find('b').deadlinePolicy.kind,'customer-return-wait');
  assert.equal(find('unknown').safeTDueAt,null);assert.equal(find('a','store-b').management.status,roles.new);
  assert.equal(list({status:roles.awaiting_customer_return}).total,3);
  assert.deepEqual(detail('a').refund,before.refund);assert.deepEqual(detail('a').payment,before.payment);
  const status=statusDefinition(db,roles.awaiting_customer_return);
  saveReviewStatus(db,{...status,label:'Cliente sem devolução',expectedVersion:status.version});sync(sources);
  assert.equal(find('a').deadlinePolicy.days,60);
  mutate({action:'edit',items:[identity(find('b'))],status:roles.analysis});
  assert.equal(find('b').safeTDueAt,'2026-11-07T12:00:00.000Z');
});
