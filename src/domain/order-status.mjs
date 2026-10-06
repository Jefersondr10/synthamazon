// Official Orders 2026-01-01 fulfillment/package enums; detailedStatus is open.
// https://github.com/amzn/selling-partner-api-models/blob/main/models/orders-api-model/orders_2026-01-01.json
const definitions = {
  UNKNOWN: ['Não informado', 'neutral'],
  PENDING_AVAILABILITY: ['Pagamento pendente (pré-venda)', 'amber'],
  PENDING: ['Pagamento pendente', 'amber'],
  UNSHIPPED: ['Envio pendente', 'amber'],
  PARTIALLY_SHIPPED: ['Parcialmente enviado', 'blue'],
  SHIPPED: ['Enviado', 'blue'],
  CANCELLED: ['Cancelado', 'red'],
  UNFULFILLABLE: ['Não atendível', 'red'],
  PACKAGE_CANCELLED: ['Envio cancelado', 'red'],
  PACKAGE_PENDING: ['Envio pendente', 'amber'],
  IN_TRANSIT: ['Em trânsito', 'blue'],
  DELIVERED: ['Entregue', 'good'],
  PARTIALLY_DELIVERED: ['Entrega parcial', 'blue'],
  UNDELIVERABLE: ['Entrega não realizada', 'red'],
  PENDING_SCHEDULE: ['Aguardando agendamento', 'amber'],
  PENDING_PICK_UP: ['Aguardando coleta', 'amber'],
  PENDING_DROP_OFF: ['Aguardando postagem', 'amber'],
  LABEL_CANCELLED: ['Etiqueta cancelada', 'red'],
  PICKED_UP: ['Coleta realizada', 'blue'],
  DROPPED_OFF: ['Postado na transportadora', 'blue'],
  AT_ORIGIN_FC: ['No centro de origem', 'blue'],
  AT_DESTINATION_FC: ['No centro de destino', 'blue'],
  REJECTED_BY_BUYER: ['Recusado pelo comprador', 'red'],
  RETURNING_TO_SELLER: ['Devolvendo ao vendedor', 'amber'],
  RETURNED_TO_SELLER: ['Devolvido ao vendedor', 'amber'],
  LOST: ['Extraviado', 'red'],
  OUT_FOR_DELIVERY: ['Saiu para entrega', 'blue'],
  DAMAGED: ['Danificado', 'red'],
  MULTIPLE_PACKAGE_STATUSES: ['Situações diferentes nos pacotes', 'amber'],
};

export const ORDER_STATUS_CATALOG = Object.freeze(Object.fromEntries(
  Object.entries(definitions).map(([code, [label, tone]]) => [code, Object.freeze({ code, label, tone })]),
));

function statusCode(value) {
  const valueText = typeof value === 'string' ? value.trim() : '';
  if (!valueText) return null;
  const upper = valueText.toUpperCase();
  if (upper === 'CANCELED') return 'CANCELLED';
  return Object.hasOwn(ORDER_STATUS_CATALOG, upper) ? upper : valueText;
}

function descriptor(code, source, partial = false, description) {
  const known = ORDER_STATUS_CATALOG[code];
  return { ...(known ?? { code, label: code, tone: 'neutral' }), source, partial,
    ...(description ? { description } : !known ? { description: 'Status informado pela Amazon, ainda sem tradução.' } : {}) };
}

function packageCode(pkg) {
  const detail = statusCode(pkg?.detailedStatus);
  const general = statusCode(pkg?.status);
  const code = detail ?? general ?? 'UNKNOWN';
  return code === 'CANCELLED' ? 'PACKAGE_CANCELLED' : ['PENDING','PENDING_AVAILABILITY'].includes(code) ? 'PACKAGE_PENDING' : code;
}

function packageDescriptions(codes) {
  const groups = new Map();
  for (const code of codes) groups.set(code, (groups.get(code) ?? 0) + 1);
  return [...groups].map(([code, count]) => `${ORDER_STATUS_CATALOG[code]?.label ?? code}: ${count} de ${codes.length} pacotes`).join('; ');
}

// Quantities are used only when every mapping needed to establish incomplete
// package coverage is explicit. Zero/missing quantities never imply a status.
function hasIncompleteItemCoverage(order, packages) {
  if (!Array.isArray(order.items) || !order.items.length || !packages.length) return false;
  const expected = new Map();
  for (const item of order.items) {
    if (!item.orderItemId || !Number.isSafeInteger(item.quantityOrdered) || item.quantityOrdered <= 0) return false;
    expected.set(item.orderItemId, (expected.get(item.orderItemId) ?? 0n) + BigInt(item.quantityOrdered));
  }
  const shipped = new Map();
  for (const pkg of packages) {
    if (!Array.isArray(pkg?.items) || !pkg.items.length) return false;
    for (const item of pkg.items) {
      if (!item.orderItemId || !Number.isSafeInteger(item.quantity) || item.quantity <= 0 || !expected.has(item.orderItemId)) return false;
      shipped.set(item.orderItemId, (shipped.get(item.orderItemId) ?? 0n) + BigInt(item.quantity));
    }
  }
  return [...expected].some(([id, quantity]) => (shipped.get(id) ?? 0n) < quantity);
}

/** Add a display-only status; all source fields and financial objects survive. */
export function decorateOrderStatus(order) {
  if (!order || typeof order !== 'object' || Array.isArray(order)) throw new TypeError('Pedido inválido.');
  const raw = statusCode(order.status);
  const packages = Array.isArray(order.packages) ? order.packages : [];
  const codes = packages.map(packageCode);
  const knownCodes = codes.filter(code => code !== 'UNKNOWN');
  const finish = displayStatus => ({ ...order, displayStatus });

  if (raw === 'CANCELLED') return finish(descriptor(raw, 'order'));
  // These are explicit order-level states. A leftover package status cannot
  // override them or turn an unshipped/pending order into a completed one.
  if (['PENDING_AVAILABILITY', 'PENDING', 'UNSHIPPED', 'UNFULFILLABLE'].includes(raw)) {
    const trackingInfo = knownCodes.some(code => code !== raw) ? `Rastreio informado: ${packageDescriptions(codes)}. Situação do pedido preservada.` : undefined;
    return finish(descriptor(raw, 'order', false, trackingInfo));
  }

  const returned = codes.filter(code => code === 'RETURNED_TO_SELLER').length;
  const incompleteItems = hasIncompleteItemCoverage(order, packages);
  if (returned) {
    const partial = returned < packages.length || raw === 'PARTIALLY_SHIPPED' || incompleteItems;
    const description = `${returned} de ${packages.length} pacotes com devolução observada${partial ? '; não confirma a devolução de todo o pedido.' : '.'}`;
    return finish(descriptor('RETURNED_TO_SELLER', 'tracking', partial, description));
  }

  if (raw === 'PARTIALLY_SHIPPED') {
    return finish(descriptor(raw, 'order', true, knownCodes.length
      ? `Rastreio dos pacotes disponíveis: ${packageDescriptions(codes)}. O pedido permanece parcialmente enviado.`
      : 'O pedido foi informado como parcialmente enviado.'));
  }
  if (!knownCodes.length) return finish(raw ? descriptor(raw, 'order') : descriptor('UNKNOWN', 'none'));

  const distinct = new Set(codes);
  if (distinct.size > 1) return finish(descriptor('MULTIPLE_PACKAGE_STATUSES', 'tracking', true, `${packageDescriptions(codes)}.`));
  const code = knownCodes[0];
  if (code === 'DELIVERED' && incompleteItems) {
    return finish(descriptor('PARTIALLY_DELIVERED', 'tracking', true, 'Os pacotes entregues informados cobrem apenas parte das quantidades do pedido.'));
  }
  return finish(descriptor(code, 'tracking', incompleteItems,
    incompleteItems ? 'Os pacotes informados cobrem apenas parte das quantidades do pedido.' : undefined));
}
