import test from 'node:test';
import assert from 'node:assert/strict';
import { decorateOrderStatus, ORDER_STATUS_CATALOG } from '../src/domain/order-status.mjs';

const pkg = (status, detailedStatus, items) => ({ status, detailedStatus, ...(items ? { items } : {}) });
const display = order => decorateOrderStatus(order).displayStatus;

test('detailed tracking states describe shipped orders without inventing financial status', () => {
  assert.equal(display({ status: 'SHIPPED', packages: [pkg('SHIPPED', 'PICKED_UP')] }).label, 'Coleta realizada');
  assert.equal(display({ status: 'SHIPPED', packages: [pkg('IN_TRANSIT', 'OUT_FOR_DELIVERY')] }).code, 'OUT_FOR_DELIVERY');
  const returned = display({ status: 'SHIPPED', packages: [pkg('DELIVERED', 'RETURNED_TO_SELLER')] });
  assert.equal(returned.code, 'RETURNED_TO_SELLER');
  assert.equal(returned.label, 'Devolvido ao vendedor');
  assert.equal(returned.source, 'tracking');
  assert.equal(returned.partial, false);
});

test('explicit order cancellation overrides old package progress and accepts the legacy spelling', () => {
  for (const status of ['CANCELLED', 'CANCELED', 'cancelled']) {
    const result = display({ status, packages: [pkg('DELIVERED', 'RETURNED_TO_SELLER')] });
    assert.equal(result.code, 'CANCELLED');
    assert.equal(result.label, 'Cancelado');
    assert.equal(result.source, 'order');
    assert.equal(result.partial, false);
  }
});

test('pending, unshipped and unfulfillable order states survive contradictory package status', () => {
  for (const status of ['PENDING_AVAILABILITY', 'PENDING', 'UNSHIPPED', 'UNFULFILLABLE']) {
    const result = display({ status, packages: [pkg('DELIVERED', 'DELIVERED')] });
    assert.equal(result.code, status);
    assert.equal(result.source, 'order');
    assert.match(result.description, /Situação do pedido preservada/);
  }
  assert.equal(display({ status: 'UNSHIPPED' }).label, 'Envio pendente');
  assert.equal(display({ status: 'PENDING' }).label, 'Pagamento pendente');
  assert.equal(display({ status: 'Pending' }).label, 'Pagamento pendente');
  assert.equal(display({ status: 'PENDING_AVAILABILITY' }).label, 'Pagamento pendente (pré-venda)');
  const packageOnly = display({ packages: [pkg('PENDING', null)] });
  assert.equal(packageOnly.code, 'PACKAGE_PENDING');
  assert.equal(packageOnly.label, 'Envio pendente');
  assert.equal(packageOnly.source, 'tracking');
});

test('partial shipment never becomes a wholly delivered order from one known package', () => {
  const delivered = display({ status: 'PARTIALLY_SHIPPED', packages: [pkg('DELIVERED', 'DELIVERED')] });
  assert.equal(delivered.code, 'PARTIALLY_SHIPPED');
  assert.equal(delivered.partial, true);
  assert.match(delivered.description, /permanece parcialmente enviado/);
  const returned = display({ status: 'PARTIALLY_SHIPPED', packages: [pkg('DELIVERED', 'RETURNED_TO_SELLER')] });
  assert.equal(returned.code, 'RETURNED_TO_SELLER');
  assert.equal(returned.partial, true);
  assert.match(returned.description, /não confirma a devolução de todo/);
});

test('one returned package gives a stable return code with an explicit partial qualifier', () => {
  const result = display({ status: 'SHIPPED', packages: [pkg('DELIVERED', 'RETURNED_TO_SELLER'), pkg('IN_TRANSIT', 'AT_DESTINATION_FC')] });
  assert.equal(result.code, 'RETURNED_TO_SELLER');
  assert.equal(result.label, ORDER_STATUS_CATALOG.RETURNED_TO_SELLER.label);
  assert.equal(result.partial, true);
  assert.match(result.description, /1 de 2 pacotes/);
  assert.match(result.description, /não confirma/);
});

test('different or missing package states do not imply that every package was delivered', () => {
  for (const second of [pkg('IN_TRANSIT', 'PICKED_UP'), pkg(null, null)]) {
    const result = display({ status: 'SHIPPED', packages: [pkg('DELIVERED', 'DELIVERED'), second] });
    assert.equal(result.code, 'MULTIPLE_PACKAGE_STATUSES');
    assert.equal(result.partial, true);
    assert.match(result.description, /Entregue: 1 de 2/);
  }
  const allDelivered = display({ status: 'SHIPPED', packages: [pkg('DELIVERED', null), pkg('DELIVERED', 'DELIVERED')] });
  assert.equal(allDelivered.code, 'DELIVERED');
  assert.equal(allDelivered.partial, false);
});

test('explicit item mappings identify a partial delivery without using missing or zero quantities as status', () => {
  const base = { status: 'SHIPPED', items: [{ orderItemId: 'item-a', quantityOrdered: 2 }], packages: [pkg('DELIVERED', 'DELIVERED', [{ orderItemId: 'item-a', quantity: 1 }])] };
  assert.equal(display(base).code, 'PARTIALLY_DELIVERED');
  assert.equal(display(base).partial, true);
  assert.equal(display({ ...base, items: [{ orderItemId: 'item-a', quantityOrdered: 0 }] }).code, 'DELIVERED');
  assert.equal(display({ items: [{ quantityOrdered: 0 }], grandTotalCents: '0' }).code, 'UNKNOWN');
});

test('package cancellation is not order cancellation', () => {
  const result = display({ status: 'SHIPPED', packages: [pkg('CANCELLED', null)] });
  assert.equal(result.code, 'PACKAGE_CANCELLED');
  assert.equal(result.label, 'Envio cancelado');
  assert.equal(result.source, 'tracking');
});

test('missing data stays unknown and new API values remain original rather than fabricated translations', () => {
  assert.deepEqual(display({ packages: [pkg(null, null)] }), { code: 'UNKNOWN', label: 'Não informado', tone: 'neutral', source: 'none', partial: false });
  const future = display({ status: 'FUTURE_FULFILLMENT_STATE' });
  assert.equal(future.code, 'FUTURE_FULFILLMENT_STATE');
  assert.equal(future.label, 'FUTURE_FULFILLMENT_STATE');
  assert.equal(future.source, 'order');
  const tracking = display({ status: 'SHIPPED', packages: [pkg('IN_TRANSIT', 'FUTURE_TRACKING_STATE')] });
  assert.equal(tracking.code, 'FUTURE_TRACKING_STATE');
  assert.equal(tracking.label, 'FUTURE_TRACKING_STATE');
});

test('decorating a frozen order preserves raw status, packages and exact finances', () => {
  const financial = Object.freeze({ totalCents: '900719925474099313', currency: 'BRL', paid: null });
  const packages = Object.freeze([Object.freeze(pkg('SHIPPED', 'PICKED_UP'))]);
  const input = Object.freeze({ orderId: 'example', status: 'SHIPPED', financial, packages });
  const result = decorateOrderStatus(input);
  assert.notEqual(result, input);
  assert.equal(result.status, 'SHIPPED');
  assert.equal(result.financial, financial);
  assert.equal(result.packages, packages);
  assert.equal(result.financial.totalCents, '900719925474099313');
  assert.equal(Object.hasOwn(input, 'displayStatus'), false);
  assert.equal(result.displayStatus.code, 'PICKED_UP');
});
