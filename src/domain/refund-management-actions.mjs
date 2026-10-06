import { refundManagementStatuses, statusDefinition as lookupStatus } from './review-statuses.mjs';
import { managementError, managementIdentity, managementInstant, readManagementRow, presentManagement,
  managementHistory, refundManagementDetail, cents } from './refund-management.mjs';

const own = (value, key) => Object.hasOwn(value, key);
const fields = ['status','shortNote','note','caseId','safeTId','returnTracking'];
const finalizationReasons = ['safe_t_received','manual_refund','return_received','other'];
const prohibited = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
function checkedText(input, name, max) {
  if (!own(input, name)) return;
  if (typeof input[name] !== 'string' || input[name].length > max || prohibited.test(input[name])) throw managementError('INVALID_MANAGEMENT');
  input[name] = input[name].trim();
}
export function validateManagementAction(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw managementError('INVALID_MANAGEMENT');
  const input = { ...raw };
  if (!['edit','bulk-edit','finalize','reopen'].includes(input.action)) throw managementError('INVALID_MANAGEMENT');
  const permitted = ['action','items',...(input.action === 'reopen' ? ['status'] : fields),
    ...(input.action === 'finalize' ? ['unpaidReason','acknowledgePaymentVariance'] : [])];
  if (Object.keys(input).some(key => !permitted.includes(key)) || !Array.isArray(input.items) || input.items.length < 1 || input.items.length > 100
    || input.action === 'edit' && input.items.length !== 1) throw managementError('INVALID_MANAGEMENT');
  if (input.action !== 'edit' && ['caseId','safeTId','returnTracking'].some(key => own(input, key))) throw managementError('INVALID_MANAGEMENT');
  const seen = new Set();
  for (const item of input.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['storeId','managementId','expectedVersion'].includes(key))
      || !Number.isSafeInteger(item.expectedVersion) || item.expectedVersion < 0) throw managementError('INVALID_MANAGEMENT');
    managementIdentity(item.storeId, item.managementId);
    const identity = JSON.stringify([item.storeId,item.managementId]);
    if (seen.has(identity)) throw managementError('INVALID_MANAGEMENT'); seen.add(identity);
  }
  if (own(input,'status') && input.status !== null && (typeof input.status !== 'string' || !/^[a-z][a-z0-9_]{0,49}$/.test(input.status))) throw managementError('INVALID_MANAGEMENT');
  checkedText(input,'shortNote',500); checkedText(input,'note',2000); checkedText(input,'caseId',100);
  checkedText(input,'safeTId',100); checkedText(input,'returnTracking',500);
  if (own(input,'caseId')) {
    input.caseId = input.caseId.replace(/\D/g,'');
    if (input.caseId.length > 30) throw managementError('INVALID_MANAGEMENT');
  }
  if (['edit','bulk-edit'].includes(input.action) && !fields.some(key => own(input,key))) throw managementError('INVALID_MANAGEMENT');
  if (input.action === 'finalize' && (typeof input.status !== 'string' || typeof input.acknowledgePaymentVariance !== 'boolean'
    || input.unpaidReason !== undefined && input.unpaidReason !== null && !finalizationReasons.includes(input.unpaidReason))) throw managementError('INVALID_MANAGEMENT');
  return input;
}

/** One guarded transaction, with a separate operational workflow and payment confirmation. */
export function mutateRefundManagement({ db, input: raw, now = new Date() }) {
  const input = validateManagementAction(raw), timestamp = managementInstant(now), definitions = refundManagementStatuses(db);
  const definitionFor = code => definitions.find(item => item.code === code);
  const defaultReopen = definitions.find(item => item.active && item.semanticRole === 'analysis')
    ?? definitions.find(item => item.active && item.semanticRole === 'new');
  const status = input.action === 'reopen' && !own(input,'status') ? defaultReopen?.code : input.status;
  const statusDefinition = definitionFor(status) ?? lookupStatus(db,status);
  const statusAvailable = definitions.some(item => item.code === status && item.active && !item.automatic);
  if (status !== undefined && status !== null && (!statusDefinition || statusDefinition.automatic)
    || ['finalize','reopen'].includes(input.action) && !statusAvailable
    || input.action === 'reopen' && statusDefinition?.semanticRole === 'concluded') throw managementError('INVALID_MANAGEMENT');
  const changedItems = []; let changed = 0, confirmedPayments = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const targets = input.items.map(identity => {
      const row = readManagementRow(db, identity.storeId, identity.managementId);
      if (!row) throw managementError('CASE_NOT_FOUND');
      if (row.version !== identity.expectedVersion) throw managementError('REVIEW_CONFLICT');
      if (status !== undefined && status !== null && !statusAvailable && status !== row.status) throw managementError('INVALID_MANAGEMENT');
      const current = presentManagement(db,row);
      if (input.action === 'finalize') {
        if (row.workflow_state !== 'active') throw managementError('WORKFLOW_CONFLICT');
        if (!current.payment.confirmationRequired && !finalizationReasons.includes(input.unpaidReason)) throw managementError('FINALIZATION_REASON_REQUIRED');
        if (current.payment.variance.requiresAcknowledgement && !input.acknowledgePaymentVariance) throw managementError('PAYMENT_VARIANCE_REQUIRED');
      }
      if (input.action === 'reopen' && row.workflow_state !== 'finalized') throw managementError('WORKFLOW_CONFLICT');
      return { identity,row,current };
    });
    for (const { identity,row,current } of targets) {
      const next = { status: status === undefined ? row.status : status,
        shortNote: input.action === 'bulk-edit' && !input.shortNote ? row.short_note : input.shortNote ?? row.short_note,
        caseId: input.caseId ?? row.case_id, safeTId: input.safeTId ?? row.safe_t_id, returnTracking: input.returnTracking ?? row.return_tracking,
        workflowState: row.workflow_state, finalizedAt: row.finalized_at, finalizationReason: row.finalization_reason,
        confirmed: JSON.parse(row.confirmed_json), confirmedAt: row.confirmed_at };
      if (input.action === 'finalize') {
        next.workflowState = 'finalized'; next.finalizedAt = timestamp;
        next.finalizationReason = current.payment.confirmationRequired ? 'amazon_payment' : input.unpaidReason;
        if (current.payment.confirmationRequired) {
          const previous = new Map(next.confirmed.map(item => [item.currency,cents(item.totalCents) ?? 0n]));
          for (const item of current.payment.byCurrency) if (cents(item.totalCents) !== null && cents(item.totalCents) > (previous.get(item.currency) ?? 0n)) previous.set(item.currency,cents(item.totalCents));
          next.confirmed = [...previous].sort(([a],[b]) => a.localeCompare(b)).map(([currency,total]) => ({ currency,totalCents:total.toString() }));
          next.confirmedAt = timestamp; confirmedPayments++;
        }
        if (input.shortNote) next.shortNote = [row.short_note,input.shortNote].filter(Boolean).join('\n────────\n');
      }
      if (input.action === 'reopen') { next.workflowState = 'active'; next.finalizedAt = null; next.finalizationReason = null; }
      const before = { status:row.status,shortNote:row.short_note,caseId:row.case_id,safeTId:row.safe_t_id,returnTracking:row.return_tracking,
        workflowState:row.workflow_state,finalizedAt:row.finalized_at,finalizationReason:row.finalization_reason,
        confirmed:JSON.parse(row.confirmed_json),confirmedAt:row.confirmed_at };
      if (JSON.stringify(before) === JSON.stringify(next) && !input.note) { changedItems.push(identity); continue; }
      const version = row.version + 1;
      db.prepare(`UPDATE refund_management SET status=?,short_note=?,case_id=?,safe_t_id=?,return_tracking=?,workflow_state=?,
        finalized_at=?,finalization_reason=?,confirmed_json=?,confirmed_at=?,version=?,updated_at=? WHERE store_id=? AND management_id=?`)
        .run(next.status,next.shortNote,next.caseId,next.safeTId,next.returnTracking,next.workflowState,next.finalizedAt,
          next.finalizationReason,JSON.stringify(next.confirmed),next.confirmedAt,version,timestamp,identity.storeId,identity.managementId);
      const changes = Object.fromEntries(Object.keys(next).filter(key => JSON.stringify(before[key]) !== JSON.stringify(next[key]))
        .map(key => [key,{previous:before[key],current:next[key]}]));
      managementHistory(db,{...identity,version,type:input.action,changes,now:timestamp,note:input.note});
      changed++; changedItems.push(identity);
    }
    db.exec('COMMIT');
  } catch (failure) { db.exec('ROLLBACK'); throw failure; }
  return { changed,confirmedPayments,items:changedItems.map(item => refundManagementDetail(db,item.storeId,item.managementId)) };
}
