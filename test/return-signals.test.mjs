import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReturnSignals } from '../src/domain/return-signals.mjs';

const MFN = 'GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE';
const FBA = 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA';
const at = day => `2026-09-${String(day).padStart(2, '0')}T12:00:00.000Z`;
const report = (returnId, returnStatus, extra = {}) => ({ returnId, orderId: 'order-a', reportType: MFN,
  returnStatus, returnRequestedAt: '2026-09-01', returnReceivedAt: null, observedAt: at(20), ...extra });

test('open requests require explicit merchant return status; authorization and FBA receipt never imply an open request', () => {
  const customerReturns = [report('open', 'Open'), report('localized', '  Em   aberto '),
    report('approved', 'Approved'), report('authorized', 'Authorized'), report('empty', null),
    report('future', 'FutureStatus'), report('conflicting', 'Open', { returnReceivedAt: at(6) }),
    report('closed', 'Closed'), report('cancelled', 'Canceled'), report('fba', null, { reportType: FBA, returnReceivedAt: at(6) }),
    report('fba-open', 'Open', { reportType: FBA }), report('unproven-report', 'Open', { reportType: null })];
  const before = JSON.stringify(customerReturns), result = buildReturnSignals({ customerReturns });
  assert.deepEqual(result.openCustomerReturns.map(item => item.returnId), ['open', 'localized']);
  assert.deepEqual(result.unknownCustomerReturns.map(item => item.returnId), ['approved', 'authorized', 'empty', 'future', 'conflicting', 'unproven-report']);
  assert.deepEqual(result.openCustomerReturns[0], { returnId: 'open', orderId: 'order-a', returnStatus: 'Open', reportType: MFN,
    requestedAt: '2026-09-01', receivedAt: null, observedAt: at(20), dateBasis: 'requested' });
  assert.equal(result.returnedToSeller.current, false);
  assert.equal(result.returnedToSeller.historical, false);
  assert.equal(JSON.stringify(customerReturns), before);
});

test('returned signals preserve current package evidence and historical occurrences independently', () => {
  const returnedToSeller = { orderId: 'order-a', detectedAt: at(4), statusObservedAt: at(20),
    returnedPackageCount: 2, currentReturnedPackageCount: 1, packageCount: 3,
    partialReturn: true, returnStatusChanged: true };
  const partial = buildReturnSignals({ returnedToSeller }).returnedToSeller;
  assert.equal(partial.current, true);
  assert.equal(partial.historical, true);
  assert.equal(partial.currentStateKnown, true);
  assert.equal(partial.currentPackageCount, 1);
  assert.equal(partial.historicalPackageCount, 2);
  assert.equal(partial.packageCount, 3);
  assert.equal(partial.partial, true);
  assert.equal(partial.returnStatusChanged, true);
  assert.equal(partial.statusObservedAt, at(20));
  const past = buildReturnSignals({ returnedToSeller: { ...returnedToSeller, currentReturnedPackageCount: 0 } }).returnedToSeller;
  assert.equal(past.current, false); assert.equal(past.historical, true); assert.equal(past.currentStateKnown, true);
  const incomplete = buildReturnSignals({ returnedToSeller: { detectedAt: at(4), returnStatusChanged: false } }).returnedToSeller;
  assert.equal(incomplete.current, false); assert.equal(incomplete.historical, true); assert.equal(incomplete.currentStateKnown, false);
  assert.equal(incomplete.currentPackageCount, null);
});
