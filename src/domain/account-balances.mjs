import { normalizeFinancialEventGroups, normalizeTransactions } from './normalize.mjs';

export function ensureAccountBalanceSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS account_balances (
    store_id TEXT PRIMARY KEY, observed_at TEXT, groups_json TEXT,
    attempted_at TEXT NOT NULL, error_code TEXT
  )`);
  const columns = new Set(db.prepare('PRAGMA table_info(account_balances)').all().map(row => row.name));
  for (const name of ['deferred_json','deferred_from','deferred_to']) if (!columns.has(name)) db.exec(`ALTER TABLE account_balances ADD COLUMN ${name} TEXT`);
}

/** Publish only after all pages finish. A failed refresh preserves the last good snapshot. */
export async function collectAccountBalance({ db, client, config, now = () => new Date(), signal }) {
  ensureAccountBalanceSchema(db);
  const attemptedAt = now().toISOString();
  try {
    const groups = new Map();
    let pages = 0;
    for await (const page of client.listFinancialEventGroups()) {
      if (signal?.aborted) throw Object.assign(new Error(), { code: 'ABORTED' });
      pages++;
      for (const group of normalizeFinancialEventGroups(page.rawBody, { storeId: config.storeId, observedAt: attemptedAt })) {
        const previous = groups.get(group.groupId);
        if (previous && JSON.stringify(previous) !== JSON.stringify(group)) throw Object.assign(new Error(), { code: 'INVALID_RESPONSE' });
        groups.set(group.groupId, group);
      }
    }
    if (!pages || signal?.aborted) throw Object.assign(new Error(), { code: 'INVALID_RESPONSE' });
    // Open financial groups omit funds still deferred. Fetch a fresh DEFERRED
    // snapshot instead of summing stale deferred entries in the local ledger.
    const deferred = new Map(), before = Date.parse(attemptedAt) - 300000;
    const from = config.historyStart ?? new Date(before - 180 * 86400000).toISOString();
    if (!Number.isFinite(Date.parse(from)) || Date.parse(from) >= before || typeof client.listTransactions !== 'function') {
      throw Object.assign(new Error(), { code: 'INVALID_RESPONSE' });
    }
    for (let start = Date.parse(from); start < before;) {
      const end = Math.min(before, start + 180 * 86400000);
      let transactionPages = 0;
      for await (const page of client.listTransactions({ postedAfter: new Date(start).toISOString(), postedBefore: new Date(end).toISOString(),
        transactionStatus: 'DEFERRED', ...(config.marketplaceId ? { marketplaceId: config.marketplaceId } : {}) })) {
        if (signal?.aborted) throw Object.assign(new Error(), { code: 'ABORTED' });
        transactionPages++;
        for (const transaction of normalizeTransactions(page.rawBody, { storeId: config.storeId, observedAt: attemptedAt })) {
          if (transaction.status !== 'DEFERRED' || transaction.marketplaceId && config.marketplaceId && transaction.marketplaceId !== config.marketplaceId) {
            throw Object.assign(new Error(), { code: 'INVALID_RESPONSE' });
          }
          const item = { transactionId: transaction.transactionId, totalCents: transaction.totalCents, currency: transaction.currency };
          const previous = deferred.get(item.transactionId);
          if (previous && JSON.stringify(previous) !== JSON.stringify(item)) throw Object.assign(new Error(), { code: 'INVALID_RESPONSE' });
          deferred.set(item.transactionId, item);
        }
      }
      if (!transactionPages) throw Object.assign(new Error(), { code: 'INVALID_RESPONSE' });
      start = end;
    }
    if (signal?.aborted) throw Object.assign(new Error(), { code: 'ABORTED' });
    const observedAt = now().toISOString();
    db.prepare(`INSERT INTO account_balances(store_id,observed_at,groups_json,attempted_at,error_code,deferred_json,deferred_from,deferred_to) VALUES(?,?,?,?,NULL,?,?,?)
      ON CONFLICT(store_id) DO UPDATE SET observed_at=excluded.observed_at, groups_json=excluded.groups_json,
      attempted_at=excluded.attempted_at, error_code=NULL,deferred_json=excluded.deferred_json,deferred_from=excluded.deferred_from,deferred_to=excluded.deferred_to
      WHERE julianday(excluded.attempted_at)>=julianday(account_balances.attempted_at)`)
      .run(config.storeId, observedAt, JSON.stringify([...groups.values()]), attemptedAt, JSON.stringify([...deferred.values()]), from, new Date(before).toISOString());
    return { groups: groups.size, deferredTransactions: deferred.size, observedAt };
  } catch (error) {
    const code = ['HTTP_ERROR', 'RATE_LIMITED', 'TIMEOUT', 'NETWORK_ERROR', 'PAGINATION_LIMIT', 'PAGINATION_CYCLE', 'INVALID_RESPONSE', 'INVALID_SNAPSHOT', 'ABORTED'].includes(error?.code) ? error.code : 'BALANCE_COLLECTION_FAILED';
    db.prepare(`INSERT INTO account_balances(store_id,observed_at,groups_json,attempted_at,error_code) VALUES(?,NULL,NULL,?,?)
      ON CONFLICT(store_id) DO UPDATE SET attempted_at=excluded.attempted_at,error_code=excluded.error_code
      WHERE julianday(excluded.attempted_at)>=julianday(account_balances.attempted_at)`).run(config.storeId, attemptedAt, code);
    throw Object.assign(new Error(code), { code, ...(Number.isInteger(error?.status) ? { status: error.status } : {}) });
  }
}

export function accountBalanceView(db, storeIds, now = Date.now()) {
  const byCurrency = new Map();
  const stores = storeIds.map(storeId => {
    const row = db.prepare('SELECT * FROM account_balances WHERE store_id=?').get(storeId);
    if (!row?.observed_at) return { storeId, state: 'missing', observedAt: null, openGroups: 0, missingAmounts: 0 };
    const open = JSON.parse(row.groups_json).filter(group => group.status === 'Open');
    const deferred = row.deferred_json === null ? null : JSON.parse(row.deferred_json);
    let missingAmounts = 0;
    for (const [items, field] of [[open, 'openCents'], [deferred ?? [], 'deferredCents']]) for (const group of items) {
      if (!/^-?\d+$/.test(group.totalCents ?? '') || !/^[A-Z]{3}$/.test(group.currency ?? '')) { missingAmounts++; continue; }
      const values = byCurrency.get(group.currency) ?? { openCents: 0n, deferredCents: 0n };
      values[field] += BigInt(group.totalCents); byCurrency.set(group.currency, values);
    }
    return { storeId, observedAt: row.observed_at, openGroups: open.length, missingAmounts,
      deferredTransactions: deferred?.length ?? null, deferredFrom: row.deferred_from, deferredTo: row.deferred_to,
      state: deferred === null || missingAmounts ? 'incomplete' : row.error_code || now - Date.parse(row.observed_at) > 2 * 3600000 ? 'stale' : 'complete' };
  });
  const incomplete = !stores.length || stores.some(store => ['missing','incomplete'].includes(store.state) || store.missingAmounts);
  return { state: incomplete ? 'incomplete' : stores.some(store => store.state === 'stale') ? 'stale' : 'complete',
    stores, byCurrency: [...byCurrency].map(([currency, values]) => ({ currency, totalCents: (values.openCents + values.deferredCents).toString(),
      openCents: values.openCents.toString(), deferredCents: values.deferredCents.toString() })),
    openGroups: stores.reduce((sum, row) => sum + row.openGroups, 0), dateBasis: 'current-open-groups-and-deferred-transactions' };
}
