import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const ORDER = /^\d{3}-\d{7}-\d{7}$/;
const STORE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CLAIM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const failure = code => Object.assign(new Error(code), { code });
const fingerprint = credits => createHash('sha256').update(JSON.stringify(credits
  .map(c => [c.eventId, c.postedAt, c.totalCents, c.currency]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))).digest('hex');

export function ensureSafeTClaimsSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS safe_t_claim_queries (
    store_id TEXT NOT NULL, order_id TEXT NOT NULL, credit_fingerprint TEXT NOT NULL,
    checked_at TEXT NOT NULL, claims_json TEXT NOT NULL,
    PRIMARY KEY(store_id, order_id));
    CREATE TABLE IF NOT EXISTS safe_t_report_claims (
      store_id TEXT NOT NULL,order_id TEXT NOT NULL,claim_id TEXT NOT NULL,
      claim_state TEXT,claim_created_at TEXT,report_id TEXT NOT NULL,report_created_at TEXT NOT NULL,
      observed_at TEXT NOT NULL,PRIMARY KEY(store_id,order_id,claim_id));
    CREATE TABLE IF NOT EXISTS safe_t_seller_claims (
      store_id TEXT NOT NULL,order_id TEXT NOT NULL,claim_id TEXT NOT NULL,
      claim_state TEXT,report_hash TEXT NOT NULL,report_created_at TEXT NOT NULL,
      observed_at TEXT NOT NULL,PRIMARY KEY(store_id,order_id,claim_id));`);
}

/** Supplementary Seller Central report. Explicit store binding; identifiers only. */
export function importSellerSafeTClaims(db, { storeId, records, reportHash, reportCreatedAt, observedAt }) {
  const instant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
  if (!STORE.test(storeId ?? '') || storeId === 'all' || !/^[a-f0-9]{64}$/.test(reportHash ?? '')
    || !instant(reportCreatedAt) || !instant(observedAt) || !Array.isArray(records) || records.length > 100000
    || records.some(row => !row || !ORDER.test(row.orderId ?? '') || !CLAIM.test(row.claimId ?? '')
      || row.claimState != null && (typeof row.claimState !== 'string' || row.claimState.length > 100 || /[\x00-\x1f\x7f]/.test(row.claimState)))) {
    throw failure('INVALID_PARAMETERS');
  }
  ensureSafeTClaimsSchema(db);
  const rows = new Map(records.map(row => [JSON.stringify([row.orderId, row.claimId]), row]));
  db.exec('SAVEPOINT seller_safe_t_import');
  try {
    const insert = db.prepare(`INSERT INTO safe_t_seller_claims VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(store_id,order_id,claim_id) DO UPDATE SET
        claim_state=COALESCE(excluded.claim_state,safe_t_seller_claims.claim_state),
        report_hash=excluded.report_hash,report_created_at=excluded.report_created_at,observed_at=excluded.observed_at
      WHERE excluded.report_created_at>=safe_t_seller_claims.report_created_at`);
    for (const row of rows.values()) insert.run(storeId, row.orderId, row.claimId, row.claimState ?? null,
      reportHash, new Date(reportCreatedAt).toISOString(), new Date(observedAt).toISOString());
    db.exec('RELEASE SAVEPOINT seller_safe_t_import');
    return { claims: rows.size, orders: new Set([...rows.values()].map(row => row.orderId)).size };
  } catch (error) {
    db.exec('ROLLBACK TO SAVEPOINT seller_safe_t_import'); db.exec('RELEASE SAVEPOINT seller_safe_t_import'); throw error;
  }
}

/** Called inside the return report import transaction. A request is not a payment. */
export function importSafeTReportClaim(db, { storeId, record, reportId, reportType, reportCreatedAt, observedAt }) {
  if (reportType !== 'GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE' || !STORE.test(storeId) || storeId === 'all'
    || !ORDER.test(record.orderId ?? '') || !CLAIM.test(record.safeTClaimId ?? '')) return;
  db.prepare(`INSERT INTO safe_t_report_claims VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(store_id,order_id,claim_id) DO UPDATE SET
      claim_state=COALESCE(excluded.claim_state,safe_t_report_claims.claim_state),
      claim_created_at=COALESCE(excluded.claim_created_at,safe_t_report_claims.claim_created_at),
      report_id=excluded.report_id,report_created_at=excluded.report_created_at,observed_at=excluded.observed_at
    WHERE excluded.report_created_at>=safe_t_report_claims.report_created_at`)
    .run(storeId, record.orderId, record.safeTClaimId, record.safeTClaimState ?? null,
      record.safeTClaimCreatedAt ?? null, reportId, reportCreatedAt, observedAt);
}

export function safeTClaimMetadata(db, row) {
  const saved = db.prepare('SELECT claims_json,checked_at FROM safe_t_claim_queries WHERE store_id=? AND order_id=?')
    .get(row.store_id, row.order_id);
  const claimsById = new Map((saved ? JSON.parse(saved.claims_json) : []).map(claim =>
    [claim.claimId, { ...claim, sources: ['amazon-finances'] }]));
  const reported = db.prepare('SELECT * FROM safe_t_report_claims WHERE store_id=? AND order_id=? ORDER BY claim_id')
    .all(row.store_id, row.order_id);
  for (const record of reported) {
    const financial = claimsById.get(record.claim_id);
    claimsById.set(record.claim_id, { ...financial, claimId: record.claim_id,
      sources: [...(financial?.sources ?? []), 'amazon-return-report'],
      claimState: record.claim_state, claimCreatedAt: record.claim_created_at,
      reportId: record.report_id, reportType: 'GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE',
      reportCreatedAt: record.report_created_at,
      reportObservedAt: record.observed_at, observedAt: [financial?.observedAt, record.observed_at].filter(Boolean).sort().at(-1) });
  }
  const seller = db.prepare('SELECT * FROM safe_t_seller_claims WHERE store_id=? AND order_id=? ORDER BY claim_id')
    .all(row.store_id, row.order_id);
  for (const record of seller) {
    const existing = claimsById.get(record.claim_id);
    claimsById.set(record.claim_id, { ...existing, claimId: record.claim_id,
      sources: [...(existing?.sources ?? []), 'seller-central-report'],
      claimState: existing?.reportCreatedAt > record.report_created_at ? existing.claimState : record.claim_state ?? existing?.claimState,
      sellerReportHash: record.report_hash, sellerReportCreatedAt: record.report_created_at,
      observedAt: [existing?.observedAt, record.observed_at].filter(Boolean).sort().at(-1) });
  }
  const claims = [...claimsById.values()].sort((a, b) => a.claimId.localeCompare(b.claimId));
  const sources = new Set(claims.flatMap(claim => claim.sources));
  const manual = row.safe_t_id ?? '';
  return { safeTId: manual || claims.map(c => c.claimId).join(', '), manualSafeTId: manual,
    safeTIdSource: manual ? 'manual' : sources.size > 1 ? sources.has('seller-central-report') ? 'amazon-multiple-sources' : 'amazon-reports-and-finances' : [...sources][0] ?? null,
    automaticSafeTClaims: claims, safeTIdsCheckedAt: [saved?.checked_at, ...reported.map(record => record.observed_at), ...seller.map(record => record.observed_at)].filter(Boolean).sort().at(-1) ?? null };
}

/** Reads only exact order-scoped events for orders with known SAFE-T credits.
 * A complete query is cached for 24h; changed credits are checked immediately.
 * It enriches identifiers only, never money, manual edits or workflow state.
 */
export async function collectSafeTClaimIds({ db, client, config, now = () => new Date(), sleep = delay, signal, maxOrders = 100 }) {
  if (!STORE.test(config?.storeId ?? '') || config.storeId === 'all'
    || !Number.isInteger(maxOrders) || maxOrders < 1 || maxOrders > 100) throw failure('INVALID_PARAMETERS');
  ensureSafeTClaimsSchema(db);
  const checkedAt = new Date(now()).toISOString();
  const candidates = db.prepare('SELECT order_id,source_json FROM refund_management WHERE store_id=? ORDER BY order_id').all(config.storeId)
    .flatMap(row => {
      const source = JSON.parse(row.source_json);
      const credits = (source.payment?.credits ?? []).filter(c => c.type === 'safe_t');
      if (!ORDER.test(row.order_id) || source.financialEligibility?.included === false || !credits.length) return [];
      const hash = fingerprint(credits);
      const old = db.prepare('SELECT * FROM safe_t_claim_queries WHERE store_id=? AND order_id=?').get(config.storeId, row.order_id);
      if (old?.credit_fingerprint === hash && Date.parse(old.checked_at) > Date.parse(checkedAt) - 86400000) return [];
      return [{ orderId: row.order_id, hash, checkedAt: old?.checked_at ?? '' }];
    }).sort((a, b) => a.checkedAt.localeCompare(b.checkedAt) || a.orderId.localeCompare(b.orderId)).slice(0, maxOrders);
  const result = { selected: candidates.length, checked: 0, withIds: 0, failed: 0, interrupted: false, errorCodes: [] };
  let requested = false;
  for (const item of candidates) {
    if (signal?.aborted) { result.interrupted = true; break; }
    const claims = new Map();
    try {
      // Pace every page, as well as the first request for each subsequent order.
      if (requested) await sleep(2100, undefined, { signal });
      requested = true;
      let pages = 0;
      const iterator = client.listFinancialEventsByOrderId(item.orderId)[Symbol.asyncIterator]();
      try {
        while (true) {
          if (signal?.aborted) throw failure('ABORTED');
          if (pages) await sleep(2100, undefined, { signal });
          const next = await iterator.next();
          if (next.done) break;
          const page = next.value;
          if (++pages > 100 || page?.orderId !== item.orderId || !Array.isArray(page.safeTEvents)) throw failure('INVALID_RESPONSE');
          for (const event of page.safeTEvents) {
            if (!event || event.AmazonOrderId && event.AmazonOrderId !== item.orderId) throw failure('INVALID_RESPONSE');
            if (event.SAFETClaimId === undefined || event.SAFETClaimId === null || event.SAFETClaimId === '') continue;
            if (typeof event.SAFETClaimId !== 'string' || !CLAIM.test(event.SAFETClaimId)) throw failure('INVALID_RESPONSE');
            claims.set(event.SAFETClaimId, { claimId: event.SAFETClaimId,
              postedAt: Number.isFinite(Date.parse(event.PostedDate)) ? new Date(event.PostedDate).toISOString() : null,
              observedAt: checkedAt, operation: 'listFinancialEventsByOrderId',
              requestId: typeof page.requestId === 'string' && page.requestId.length <= 200 ? page.requestId : null });
          }
        }
      } finally { await iterator.return?.(); }
      if (!pages) throw failure('INVALID_RESPONSE');
      if (signal?.aborted) throw failure('ABORTED');
      // Retain previously observed IDs if Amazon omits older events later.
      const old = db.prepare('SELECT claims_json FROM safe_t_claim_queries WHERE store_id=? AND order_id=?').get(config.storeId, item.orderId);
      for (const claim of old ? JSON.parse(old.claims_json) : []) if (!claims.has(claim.claimId)) claims.set(claim.claimId, claim);
      db.prepare(`INSERT INTO safe_t_claim_queries VALUES(?,?,?,?,?) ON CONFLICT(store_id,order_id)
        DO UPDATE SET credit_fingerprint=excluded.credit_fingerprint,checked_at=excluded.checked_at,claims_json=excluded.claims_json`)
        .run(config.storeId, item.orderId, item.hash, checkedAt, JSON.stringify([...claims.values()].sort((a,b) => a.claimId.localeCompare(b.claimId))));
      result.checked++; if (claims.size) result.withIds++;
    } catch (error) {
      if (signal?.aborted) { result.interrupted = true; break; }
      result.failed++;
      const code = ['HTTP_ERROR','NETWORK_ERROR','TIMEOUT','RATE_LIMITED','PAGINATION_LIMIT','PAGINATION_CYCLE','INVALID_RESPONSE'].includes(error?.code) ? error.code : 'COLLECTION_PARTIAL';
      if (!result.errorCodes.includes(code)) result.errorCodes.push(code);
      if ([401,403].includes(error?.status)) break;
    }
  }
  return result;
}
