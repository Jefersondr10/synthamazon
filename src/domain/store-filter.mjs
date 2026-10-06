import { parseStoreSelection } from '../../public/store-selection.js';
export { parseStoreSelection, canonicalStoreSelection, matchesStoreSelection } from '../../public/store-selection.js';
// For SQL: (? IS NULL OR store_id IN (SELECT value FROM json_each(?))).
// Values are bound parameters; no identifiers from the user enter SQL.
export function storeArgs(value) {
  const ids = parseStoreSelection(value), encoded = ids ? JSON.stringify(ids) : null;
  return [encoded, encoded];
}
