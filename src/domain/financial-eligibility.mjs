const identity = (storeId, id) => JSON.stringify([storeId, id]);
const ids = values => [...new Set((Array.isArray(values) ? values : []).filter(value => typeof value === 'string' && value))];
const pending = new Set(['PENDING', 'PENDING_AVAILABILITY']);
const result = excluded => ({ included: !excluded, reason: excluded ? 'payment-pending' : null });

/** Order authorization state only: shipping waits and deferred finances are different. */
export function orderFinancialEligibility(order) {
  return result(pending.has(typeof order?.status === 'string' ? order.status.trim().toUpperCase() : ''));
}

/** Exclude a whole explicitly linked event; never allocate a mixed-order amount. */
export function transactionFinancialEligibility(transactions, orders) {
  const pendingOrders = new Set(orders.filter(order => !orderFinancialEligibility(order).included)
    .map(order => identity(order.storeId, order.orderId)));
  const parents = new Map();
  const find = key => {
    if (!parents.has(key)) parents.set(key, key);
    let root = key;
    while (parents.get(root) !== root) root = parents.get(root);
    while (parents.get(key) !== key) { const next = parents.get(key); parents.set(key, root); key = next; }
    return root;
  };
  for (const transaction of transactions) {
    const own = identity(transaction.storeId, transaction.transactionId);
    find(own);
    for (const linked of [...ids(transaction.deferredTransactionIds), ...ids(transaction.releaseTransactionIds)]) {
      parents.set(find(identity(transaction.storeId, linked)), find(own));
    }
  }
  const groups = new Map();
  for (const transaction of transactions) {
    const root = find(identity(transaction.storeId, transaction.transactionId)), group = groups.get(root) ?? [];
    group.push(transaction); groups.set(root, group);
  }
  const excludedKeys = new Set(), mixedKeys = new Set();
  for (const group of groups.values()) {
    const linkedOrders = new Set(group.flatMap(transaction => ids(transaction.orderIds).map(id => identity(transaction.storeId, id))));
    if (![...linkedOrders].some(key => pendingOrders.has(key))) continue;
    const mixed = [...linkedOrders].some(key => !pendingOrders.has(key));
    for (const transaction of group) {
      const key = identity(transaction.storeId, transaction.transactionId);
      excludedKeys.add(key); if (mixed) mixedKeys.add(key);
    }
  }
  const included = [], excluded = [];
  for (const transaction of transactions) (excludedKeys.has(identity(transaction.storeId, transaction.transactionId)) ? excluded : included).push(transaction);
  return { included, excluded, excludedKeys, mixedKeys, excludedTransactionCount: excluded.length, mixedOrderTransactionCount: mixedKeys.size };
}
