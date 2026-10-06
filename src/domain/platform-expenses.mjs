const STORAGE = new Set(['StorageBillingFee', 'FBAStorageFee']);
const ADS = new Set(['AdvertisingFee']);
const cents = value => typeof value === 'string' && /^-?\d{1,2048}$/.test(value) ? BigInt(value) : null;
const currency = value => typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null;

// A matching parent already includes its children. Never add those twice.
function matchingNodes(nodes, kinds) {
  return (Array.isArray(nodes) ? nodes : []).flatMap(node => kinds.has(node?.kind)
    ? [node] : matchingNodes(node?.children, kinds));
}

function nodeTotals(nodes, transactionCurrency) {
  const result = new Map();
  for (const node of nodes) {
    const nodeCurrency = currency(node.currency);
    const selectedCurrency = nodeCurrency ?? transactionCurrency;
    const value = cents(node.amountCents);
    const row = result.get(selectedCurrency) ?? { total: 0n, unknown: false };
    if (value === null || !nodeCurrency || transactionCurrency && nodeCurrency !== transactionCurrency) row.unknown = true;
    else row.total += value;
    result.set(selectedCurrency, row);
  }
  return result;
}

export function categoryFromNodes(transaction, kinds) {
  const root = matchingNodes(transaction.breakdowns, kinds);
  const itemNodes = (Array.isArray(transaction.items) ? transaction.items : [])
    .flatMap(item => matchingNodes(item?.breakdowns, kinds));
  if (!root.length && !itemNodes.length) return null;
  const parentCurrency = currency(transaction.currency);
  const rootTotals = nodeTotals(root, parentCurrency);
  const itemTotals = nodeTotals(itemNodes, parentCurrency);
  if (!root.length) return itemTotals;
  if (!itemNodes.length) return rootTotals;

  // Root and item breakdowns are alternate representations of the same cost.
  const keys = new Set([...rootTotals.keys(), ...itemTotals.keys()]);
  const consistent = [...keys].every(key => {
    const a = rootTotals.get(key), b = itemTotals.get(key);
    return a && b && !a.unknown && !b.unknown && a.total === b.total;
  });
  return consistent ? rootTotals : new Map([...keys].map(key => [key, { total: 0n, unknown: true }]));
}

function adsFromTransaction(transaction) {
  if (transaction.type !== 'ProductAdsPayment') return categoryFromNodes(transaction, ADS);
  const code = currency(transaction.currency), value = cents(transaction.totalCents);
  return new Map([[code, { total: value ?? 0n, unknown: value === null || code === null }]]);
}

/** Input is already deduplicated and scoped by posting date by the repository. */
export function platformExpenses(transactionsEffective) {
  if (!Array.isArray(transactionsEffective)) throw new TypeError('Expected effective transactions.');
  const totals = new Map();
  const counts = { fbaStorage: 0, ads: 0 };
  const add = (category, amounts) => {
    if (amounts === null) return;
    counts[category]++;
    for (const [code, amount] of amounts) {
      const row = totals.get(code) ?? { currency: code, fbaStorageCents: 0n, adsCents: 0n,
        unknownStorageCount: 0, unknownAdsCount: 0 };
      const valueKey = category === 'fbaStorage' ? 'fbaStorageCents' : 'adsCents';
      const unknownKey = category === 'fbaStorage' ? 'unknownStorageCount' : 'unknownAdsCount';
      if (amount.unknown) row[unknownKey]++;
      else row[valueKey] += amount.total;
      totals.set(code, row);
    }
  };
  for (const transaction of transactionsEffective) {
    if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)) throw new TypeError('Invalid effective transaction.');
    add('fbaStorage', categoryFromNodes(transaction, STORAGE));
    add('ads', adsFromTransaction(transaction));
  }
  const byCurrency = [...totals.values()]
    .sort((a, b) => a.currency === null ? 1 : b.currency === null ? -1 : a.currency.localeCompare(b.currency))
    .map(row => ({ ...row,
      fbaStorageCents: row.unknownStorageCount ? null : row.fbaStorageCents.toString(),
      adsCents: row.unknownAdsCount ? null : row.adsCents.toString(),
    }));
  return { byCurrency, counts, dateBasis: 'posted' };
}
