const MFN_REPORT = 'GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE';
const FBA_REPORT = 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA';
const normalized = value => typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('pt-BR') : '';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Operational allowlist only: a linked report is not proof that a request is open. */
export function customerReturnLink(row, orderId = row.orderId) {
  return { returnId: row.returnId, orderId,
    returnStatus: row.returnStatus ?? null, reportType: row.reportType ?? null,
    requestedAt: row.returnRequestedAt ?? row.requestedAt ?? null,
    receivedAt: row.returnReceivedAt ?? row.receivedAt ?? null, observedAt: row.observedAt ?? null,
    dateBasis: row.reportType === FBA_REPORT ? 'received' : row.reportType === MFN_REPORT ? 'requested' : row.dateBasis ?? null };
}

/** The source row is returnsView's automatic package history, not a manual review. */
export function returnedToSellerLink(row, orderId = row?.orderId) {
  if (!row) return null;
  return { orderId, detectedAt: row.detectedAt ?? null, statusObservedAt: row.statusObservedAt ?? null,
    returnStatusChanged: row.returnStatusChanged === true,
    currentReturnedPackageCount: count(row.currentReturnedPackageCount),
    returnedPackageCount: count(row.returnedPackageCount), packageCount: count(row.packageCount),
    partialReturn: row.partialReturn === true };
}

function customerState(row) {
  // This FBA report describes received returns; its disposition/status does not
  // describe an open merchant-fulfilled return request.
  if (row.reportType === FBA_REPORT) return 'received';
  if (row.reportType !== MFN_REPORT) return 'unknown';
  const status = normalized(row.returnStatus);
  if (['open', 'aberto', 'aberta', 'em aberto'].includes(status)) return row.receivedAt ? 'unknown' : 'open';
  if (['closed', 'cancelled', 'canceled', 'fechado', 'fechada', 'encerrado', 'encerrada', 'cancelado', 'cancelada'].includes(status)) return 'closed';
  // Approved/Authorized alone do not establish the current workflow state.
  return 'unknown';
}

/** These signals never determine a financial amount, review status or finalization. */
export function buildReturnSignals({ customerReturns = [], returnedToSeller = null } = {}) {
  const reports = customerReturns.map(row => customerReturnLink(row));
  const returned = returnedToSellerLink(returnedToSeller);
  return { returnedToSeller: {
    current: returned !== null && returned.currentReturnedPackageCount !== null && returned.currentReturnedPackageCount > 0,
    historical: returned !== null, currentStateKnown: returned !== null && returned.currentReturnedPackageCount !== null,
    detectedAt: returned?.detectedAt ?? null, statusObservedAt: returned?.statusObservedAt ?? null,
    currentPackageCount: returned?.currentReturnedPackageCount ?? null,
    historicalPackageCount: returned?.returnedPackageCount ?? null, packageCount: returned?.packageCount ?? null,
    partial: returned?.partialReturn === true || returned?.currentReturnedPackageCount > 0 && returned.currentReturnedPackageCount < returned.packageCount,
    returnStatusChanged: returned?.returnStatusChanged ?? false,
  }, openCustomerReturns: reports.filter(row => customerState(row) === 'open'),
  unknownCustomerReturns: reports.filter(row => customerState(row) === 'unknown') };
}
