// Read filters can contain one store, a canonical comma-separated set, or all.
// Mutations and entity identities always retain a single real store ID.
export function parseStoreSelection(value) {
  if (value === undefined || value === null || value === 'all') return null;
  if (typeof value !== 'string') throw new TypeError('Invalid store selection.');
  const ids = value.split(',');
  if (!ids.length || ids.length > 50 || ids.some(id => id === 'all' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id))
    || new Set(ids).size !== ids.length) throw new TypeError('Invalid store selection.');
  return ids.sort();
}
export const canonicalStoreSelection = value => parseStoreSelection(value)?.join(',') || 'all';
export const isMultipleStores = value => value === 'all' || (parseStoreSelection(value)?.length || 0) > 1;
export const matchesStoreSelection = (value, id) => !value || parseStoreSelection(value)?.includes(id) !== false;
export function restoreStoreSelection(value, allowed) {
  try {
    const ids = parseStoreSelection(value);
    if (!value || !allowed.length || ids?.some(id => !allowed.includes(id))) return null;
    return !ids || ids.length === allowed.length ? allowed.length === 1 ? allowed[0] : 'all' : ids.join(',');
  } catch { return null; }
}

// A global last-import timestamp must not appear to belong to a selected store.
export function selectedCollectionTimes(coverage, selection, stores = []) {
  const ids = parseStoreSelection(selection) || stores.map(store => store.storeId);
  const latest = new Map();
  for (const row of coverage || []) {
    if (!ids.includes(row.storeId) || row.status !== 'api-pages-complete' || !Number.isFinite(Date.parse(row.observedAt))) continue;
    if (!latest.has(row.storeId) || Date.parse(row.observedAt) > Date.parse(latest.get(row.storeId))) latest.set(row.storeId, row.observedAt);
  }
  const times = [...latest.values()].sort((a, b) => Date.parse(a) - Date.parse(b));
  return { from: times[0] || null, to: times.at(-1) || null, count: ids.length, missing: ids.length - times.length };
}
