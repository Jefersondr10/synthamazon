import { parseStoreSelection, canonicalStoreSelection, storeArgs } from './store-filter.mjs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { SnapshotStore } from '../storage.mjs';
import { normalizeOrders, normalizeTransactions, normalizeInventory } from './normalize.mjs';
import { ensureReturnSchema, returnsView, latestTrackingIndex, mergeTrackingPackages, hasReturnedOrder } from './returns.mjs';
import { saveReturnedManagement, validateReturnedAction, syncReturnedSafeTGranted } from './returned-management.mjs';
import { readMonitorStatus } from './monitor-status.mjs';
import { decorateOrderStatus } from './order-status.mjs';
import { ensureFinancialCaseSchema, buildFinancialCases, getFinancialCase, saveFinancialCaseReview, saveFinancialCaseReviews, reimbursementIndex, refundEventCount } from './financial-cases.mjs';
import { ensureCustomerReturnSchema, customerReturnsView } from './customer-returns.mjs';
import { platformExpenses } from './platform-expenses.mjs';
import { salesRevenue } from './sales-revenue.mjs';
import { ProductCostReader, inventoryCost, inventoryCostSummary, orderCost } from './product-costs.mjs';
import { ensureProductCostSchema, readOrderCosts } from './order-cost-ledger.mjs';
import { productCostLink, saveProductCostLink, productCostGroup, saveProductCostGroup } from './product-cost-links.mjs';
import { productSkuList } from './product-sku-list.mjs';
import { ensureReviewStatusSchema, reviewStatusSettings, saveReviewStatus, availableReviewStatuses, statusDefinition } from './review-statuses.mjs';
import { ensureLocalReviewSchema, getLocalReview as readLocalReview, getLocalReviewHistory, saveLocalReview as writeLocalReview } from './local-reviews.mjs';
import { projectLocalReviews, localReviewOptions } from './review-projection.mjs';
import { linkRefundReturns } from './refund-return-links.mjs';
import { buildSafeTCases } from './safe-t-cases.mjs';
import { validateTargetedOrderRun } from '../order-enrichment.mjs';
import { ensureRefundManagementSchema, syncRefundManagement, refundManagementView, refundManagementDetail } from './refund-management.mjs';
import { mutateRefundManagement, validateManagementAction } from './refund-management-actions.mjs';
import { orderFinancialEligibility, transactionFinancialEligibility } from './financial-eligibility.mjs';
import { validateRefundHistoryRun, refundHistoryRecords } from '../refund-history-enrichment.mjs';
import { ensureAccountBalanceSchema, accountBalanceView } from './account-balances.mjs';
import { inventoryForecast } from './inventory-forecast.mjs';
import { inventoryQuantities } from '../../public/inventory-quantities.js';
import { productSales } from './product-sales.mjs';
import { productPanel, panelRange } from './product-panel.mjs';
import { ensureSalesAlertSchema, syncSalesAlerts, salesAlertsView, saveSalesAlert } from './sales-alerts.mjs';

const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NORMALIZERS = { orders: normalizeOrders, transactions: normalizeTransactions, 'fba-inventory': normalizeInventory };
const iso = value => Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const hash = value => createHash('sha256').update(value).digest('hex');
const money = value => typeof value === 'string' && /^-?\d+$/.test(value) ? BigInt(value) : null;
const searchText = value => String(value ?? '').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('pt-BR');

function withProductCost(order, catalogue, db) {
  const { costTransactions = [], ...financial } = order.financial;
  const projected = { ...order, financial: { ...financial, saleRevenue: salesRevenue([order], effectiveTransactions(costTransactions).items) } };
  return { ...projected, cost: orderCost(projected, catalogue, readOrderCosts(db,order.storeId,order.orderId)) };
}

function requireStoreId(storeId) {
  if (typeof storeId !== 'string' || !SAFE_ID.test(storeId)) throw new TypeError('Invalid storeId.');
}

function entityId(source, item) {
  if (source === 'orders' && item.orderId) return item.orderId;
  if (source === 'transactions' && item.transactionId) return item.transactionId;
  if (source === 'fba-inventory' && (item.sellerSku || item.asin)) {
    return JSON.stringify([item.sellerSku ? 'sku' : 'asin', item.sellerSku ?? item.asin, item.fnSku ?? null, item.condition ?? null]);
  }
  throw new Error('Normalized record has no stable identifier.');
}

function recordHash(item) {
  const { observedAt, warnings, ...content } = item;
  return hash(JSON.stringify(content));
}

function boundary(value, end = false) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00-03:00`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new TypeError('Invalid date filter.');
    return new Date(parsed.getTime() + (end ? 86_400_000 : 0)).toISOString();
  }
  const parsed = iso(value);
  if (!parsed) throw new TypeError('Invalid date filter.');
  return parsed;
}

function inPeriod(value, filters) {
  const from = boundary(filters.from);
  const to = boundary(filters.to, true);
  if (from && to && from >= to) throw new TypeError('Invalid date range.');
  if (!from && !to) return true;
  const timestamp = iso(value);
  return Boolean(timestamp && (!from || timestamp >= from) && (!to || timestamp < to));
}

function orderStatusFilter(value) {
  if (value === undefined) return null;
  const invalid = () => Object.assign(new TypeError('Invalid order status filter.'), { code: 'INVALID_PARAMETERS' });
  if (typeof value !== 'string' || value.length > 2549) throw invalid();
  const values = value.split(',');
  if (values.length > 50 || values.some(code => !/^[A-Za-z_]{1,50}$/.test(code))) throw invalid();
  const selected = new Set(values.map(code => code.toUpperCase()));
  if (selected.size !== values.length || selected.has('ALL') && selected.size !== 1) throw invalid();
  return selected.has('ALL') ? null : selected;
}

function matchesOrder(order, filters, statuses) {
  const mode = String(filters.mode ?? 'all').toUpperCase();
  if (mode !== 'ALL' && String(order.fulfillmentMode ?? 'unknown').toUpperCase() !== mode) return false;
  if (statuses && !statuses.has(String(order.displayStatus?.code ?? order.status ?? 'unknown').toUpperCase())) return false;
  const query = searchText(filters.query);
  const searchable = searchText([order.orderId, ...(order.items ?? []).flatMap(item => [item.sku, item.asin, item.title]), ...(order.packages ?? []).map(item => item.trackingNumber)]
    .filter(Boolean).join(' '));
  return (!query || searchable.includes(query)) && inPeriod(order.createdAt, filters);
}

const isReleased = transaction => ['RELEASED', 'DEFERRED_RELEASED'].includes(String(transaction.status ?? '').toUpperCase());
const txKey = transaction => `${transaction.storeId}\u0000${transaction.transactionId}`;

function effectiveTransactions(transactions) {
  const byId = new Map(transactions.map(transaction => [txKey(transaction), transaction]));
  const superseded = new Set();
  for (const transaction of transactions) {
    if (isReleased(transaction)) {
      for (const id of transaction.deferredTransactionIds ?? []) {
        const deferred = byId.get(`${transaction.storeId}\u0000${id}`);
        if (deferred && ['DEFERRED', 'DEFERRED_RELEASED'].includes(deferred.status)) superseded.add(txKey(deferred));
      }
    }
    if (['DEFERRED', 'DEFERRED_RELEASED'].includes(transaction.status)) {
      for (const id of transaction.releaseTransactionIds ?? []) {
        const released = byId.get(`${transaction.storeId}\u0000${id}`);
        if (released && isReleased(released)) superseded.add(txKey(transaction));
      }
    }
  }
  return { items: transactions.filter(transaction => !superseded.has(txKey(transaction))), superseded };
}

function financeTotals(transactions) {
  const effective = effectiveTransactions(transactions);
  const currencies = new Map();
  let missingMoneyCount = 0;
  for (const transaction of effective.items) {
    const amount = money(transaction.totalCents);
    if (amount === null || !transaction.currency) { missingMoneyCount++; continue; }
    const currency = transaction.currency;
    const row = currencies.get(currency) ?? {
      currency, netCents: 0n, releasedCents: 0n, deferredCents: 0n, otherCents: 0n,
      shipmentCents: 0n, refundCents: 0n, otherChargesCents: 0n, transferCents: 0n,
      serviceFeeCents: 0n, adjustmentCents: 0n, transactionCount: 0,
    };
    const type = String(transaction.type ?? '').toLowerCase();
    if (type === 'transfer') row.transferCents += amount;
    else {
      row.netCents += amount;
      const status = String(transaction.status ?? '').toUpperCase();
      if (isReleased(transaction)) row.releasedCents += amount;
      else if (status === 'DEFERRED') row.deferredCents += amount;
      else row.otherCents += amount;
      if (transaction.countsAsSales === true) row.shipmentCents += amount;
      else if (type === 'refund') row.refundCents += amount;
      else if (type === 'servicefee') row.serviceFeeCents += amount;
      else row.adjustmentCents += amount;
      if (type !== 'refund' && !transaction.countsAsSales && amount < 0n) row.otherChargesCents += amount;
    }
    row.transactionCount++;
    currencies.set(currency, row);
  }
  return {
    byCurrency: [...currencies.values()].map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? value.toString() : value]))),
    transactionCount: transactions.length, effectiveTransactionCount: effective.items.length,
    supersededDeferredCount: effective.superseded.size, missingMoneyCount,
    cashReceivedCents: null, costCents: null, profitCents: null,
    costStatus: 'not-connected', reconciliationStatus: 'not-reconciled',
  };
}

function financeSeries(transactions) {
  const daily = new Map();
  const types = new Map();
  for (const transaction of effectiveTransactions(transactions).items) {
    const amount = money(transaction.totalCents);
    if (amount === null || !transaction.currency) continue;
    const type = transaction.type ?? 'Unknown';
    const typeKey = `${transaction.currency}\u0000${type}`;
    const typeRow = types.get(typeKey) ?? { type, currency: transaction.currency, totalCents: 0n, count: 0 };
    typeRow.totalCents += amount; typeRow.count++; types.set(typeKey, typeRow);
    if (!transaction.postedAt || type.toLowerCase() === 'transfer') continue;
    const date = new Date(Date.parse(transaction.postedAt) - 3 * 3600000).toISOString().slice(0, 10);
    const key = `${date}\u0000${transaction.currency}`;
    const row = daily.get(key) ?? { date, currency: transaction.currency, netCents: 0n, shipmentCents: 0n, refundCents: 0n, serviceFeeCents: 0n };
    row.netCents += amount;
    if (transaction.countsAsSales) row.shipmentCents += amount;
    else if (type.toLowerCase() === 'refund') row.refundCents += amount;
    else if (type.toLowerCase() === 'servicefee') row.serviceFeeCents += amount;
    daily.set(key, row);
  }
  const serialize = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? value.toString() : value]));
  return { daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date) || a.currency.localeCompare(b.currency)).map(serialize), byType: [...types.values()].map(serialize) };
}

function inventorySummary(items) {
  const fields = {
    totalQuantity: item => item.totalQuantity,
    usableQuantity: item => inventoryQuantities(item).usableQuantity,
    internalMovementQuantity: item => inventoryQuantities(item).internalMovement,
    fulfillableQuantity: item => item.inventoryDetails?.fulfillableQuantity,
    reservedQuantity: item => item.inventoryDetails?.reservedQuantity?.totalReservedQuantity,
    unfulfillableQuantity: item => item.inventoryDetails?.unfulfillableQuantity?.totalUnfulfillableQuantity,
    researchingQuantity: item => item.inventoryDetails?.researchingQuantity?.totalResearchingQuantity,
    inboundQuantity: item => {
      const values = ['inboundWorkingQuantity', 'inboundShippedQuantity', 'inboundReceivingQuantity'].map(key => item.inventoryDetails?.[key]);
      return values.every(Number.isSafeInteger) && Number.isSafeInteger(values.reduce((sum, value) => sum + value, 0)) ? values.reduce((sum, value) => sum + value, 0) : null;
    },
  };
  const summary = { unknownQuantities: 0, unknownByField: {} };
  for (const [key, getter] of Object.entries(fields)) {
    const values = items.map(getter);
    const unknown = values.filter(value => !Number.isSafeInteger(value)).length;
    summary.unknownByField[key] = unknown;
    summary.unknownQuantities += unknown;
    const sum = values.filter(Number.isSafeInteger).reduce((total, value) => total + BigInt(value), 0n);
    summary[key] = unknown || sum > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(sum);
  }
  return summary;
}

function pageItems(items, filters) {
  const offset = Math.max(0, Number.isSafeInteger(Number(filters.offset)) ? Number(filters.offset) : 0);
  const limit = Math.max(1, Math.min(500, Number.isSafeInteger(Number(filters.limit)) && Number(filters.limit) > 0 ? Number(filters.limit) : 100));
  return { items: items.slice(offset, offset + limit), total: items.length, offset, limit, hasMore: offset + limit < items.length };
}

/** Local read model. Raw API pages remain the immutable source of evidence. */
export class Repository {
  // One bounded store catalogue shared by filters and pagination. Both this
  // connection's writes and external imports invalidate it before reuse.
  #ordersCache = null;
  #salesOrdersCache = null;
  #productPanelCache = new Map();
  #inventoryCache = new Map();
  #productSkuCache = {};

  #ordersRevision() {
    return `${this.db.prepare('PRAGMA data_version').get().data_version}:${this.db.prepare('SELECT total_changes() AS count').get().count}`;
  }

  constructor({ dbPath, rootDir, stores = [] }) {
    if (typeof rootDir !== 'string' || !rootDir) throw new TypeError('rootDir is required.');
    this.rootDir = path.resolve(rootDir);
    const databasePath = dbPath ?? path.join(this.rootDir, 'synthamazon.sqlite');
    if (databasePath !== ':memory:') mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) { this.db.close(); throw new Error('Database version is newer than this application.'); }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stores (
        store_id TEXT PRIMARY KEY, name TEXT NOT NULL, marketplace_id TEXT
      );
      CREATE TABLE IF NOT EXISTS runs (
        store_id TEXT NOT NULL, run_id TEXT NOT NULL, manifest_hash TEXT NOT NULL,
        started_at TEXT, finished_at TEXT, status TEXT NOT NULL,
        PRIMARY KEY (store_id, run_id), FOREIGN KEY (store_id) REFERENCES stores(store_id)
      );
      CREATE TABLE IF NOT EXISTS coverage (
        store_id TEXT NOT NULL, run_id TEXT NOT NULL, source TEXT NOT NULL,
        status TEXT NOT NULL, date_basis TEXT, from_at TEXT, to_at TEXT,
        observed_at TEXT NOT NULL, records_observed INTEGER NOT NULL, pages_count INTEGER NOT NULL,
        PRIMARY KEY (store_id, run_id, source), FOREIGN KEY (store_id, run_id) REFERENCES runs(store_id, run_id)
      );
      CREATE TABLE IF NOT EXISTS entities (
        store_id TEXT NOT NULL, source TEXT NOT NULL, source_id TEXT NOT NULL,
        observed_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, version_hash TEXT NOT NULL,
        status TEXT, active INTEGER NOT NULL DEFAULT 1, payload_json TEXT NOT NULL,
        PRIMARY KEY (store_id, source, source_id), FOREIGN KEY (store_id) REFERENCES stores(store_id)
      );
      CREATE TABLE IF NOT EXISTS observations (
        store_id TEXT NOT NULL, source TEXT NOT NULL, source_id TEXT NOT NULL, run_id TEXT NOT NULL,
        observed_at TEXT NOT NULL, page_hash TEXT NOT NULL, version_hash TEXT NOT NULL, payload_json TEXT NOT NULL,
        PRIMARY KEY (store_id, source, source_id, run_id, version_hash),
        FOREIGN KEY (store_id, run_id) REFERENCES runs(store_id, run_id)
      );
      CREATE TABLE IF NOT EXISTS source_state (
        store_id TEXT NOT NULL, source TEXT NOT NULL, last_complete_at TEXT NOT NULL,
        PRIMARY KEY (store_id, source), FOREIGN KEY (store_id) REFERENCES stores(store_id)
      );
      CREATE INDEX IF NOT EXISTS idx_entities_source ON entities(store_id, source, active);
      CREATE INDEX IF NOT EXISTS idx_coverage_observed ON coverage(store_id, observed_at);
      PRAGMA user_version=1;
    `);
    for (const store of stores) this.registerStore(store);
    ensureReturnSchema(this.db);
    ensureFinancialCaseSchema(this.db);
    ensureCustomerReturnSchema(this.db);
    ensureReviewStatusSchema(this.db);
    ensureLocalReviewSchema(this.db);
    ensureRefundManagementSchema(this.db);
    ensureAccountBalanceSchema(this.db);
    ensureSalesAlertSchema(this.db);
    ensureProductCostSchema(this.db);
    this.productCosts = new ProductCostReader(this.rootDir, this.db);
  }

  productCostGroup(input) { return productCostGroup(this.db, this.productCosts, input, this.#productSkuCache); }
  saveProductCostGroup(input) { return saveProductCostGroup(this.db, this.productCosts, input); }
  productCostLink(input) { return productCostLink(this.db, this.productCosts, input); }
  productSkuList(input) { return productSkuList(this.db, this.productCosts, input, this.#productSkuCache); }
  saveProductCostLink(input) { return saveProductCostLink(this.db, this.productCosts, input); }

  registerStore({ storeId, name, displayName, marketplaceId }) {
    requireStoreId(storeId);
    this.db.prepare(`INSERT INTO stores(store_id,name,marketplace_id) VALUES(?,?,?)
      ON CONFLICT(store_id) DO UPDATE SET name=excluded.name,
      marketplace_id=COALESCE(excluded.marketplace_id,stores.marketplace_id)`)
      .run(storeId, name || displayName || storeId, marketplaceId ?? null);
  }

  async loadWorkspace({ storeId } = {}) {
    if (storeId !== undefined) requireStoreId(storeId);
    const result = { imported: 0, skipped: 0, errors: [] };
    let directories;
    try { directories = await readdir(this.rootDir, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return result; throw error; }
    const pending = [];
    for (const directory of directories) {
      if (!directory.isDirectory() || !SAFE_ID.test(directory.name) || storeId && directory.name !== storeId) continue;
      let files;
      try { files = await readdir(path.join(this.rootDir, directory.name, 'runs')); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      for (const filename of files) {
        if (!filename.endsWith('.json') || !UUID.test(filename.slice(0, -5))) continue;
        try {
          const manifest = JSON.parse(await readFile(path.join(this.rootDir, directory.name, 'runs', filename), 'utf8'));
          if (manifest.storeId !== directory.name || manifest.id?.toLowerCase() !== filename.slice(0, -5).toLowerCase()) throw new Error('Manifest identity mismatch.');
          pending.push(manifest);
        } catch { result.errors.push({ storeId: directory.name, runId: filename.slice(0, -5), code: 'INVALID_MANIFEST' }); }
      }
    }
    pending.sort((a, b) => String(a.finishedAt ?? a.startedAt).localeCompare(String(b.finishedAt ?? b.startedAt)));
    for (const manifest of pending) {
      try {
        const imported = await this.importRun(manifest);
        if (imported.imported) result.imported++; else result.skipped++;
      } catch { result.errors.push({ storeId: manifest.storeId, runId: manifest.id, code: 'IMPORT_FAILED' }); }
    }
    if (pending.length) this.syncRefundManagement(storeId ? { storeId } : {});
    return result;
  }

  async importRun(manifest) {
    if (!manifest || !UUID.test(manifest.id ?? '') || !Array.isArray(manifest.sources)) throw new TypeError('Invalid run manifest.');
    requireStoreId(manifest.storeId);
    const targetedRefunds = validateRefundHistoryRun(manifest);
    const targetedOrders = targetedRefunds ? false : validateTargetedOrderRun(manifest);
    const manifestHash = hash(JSON.stringify(manifest));
    const previousRun = this.db.prepare('SELECT manifest_hash FROM runs WHERE store_id=? AND run_id=?').get(manifest.storeId, manifest.id);
    if (previousRun) {
      if (previousRun.manifest_hash !== manifestHash) throw new Error('Run manifest changed after import.');
      return { imported: false, runId: manifest.id };
    }
    const snapshotStore = new SnapshotStore({ rootDir: this.rootDir, storeId: manifest.storeId });
    const staged = [];
    const seenSources = new Set();
    for (const source of manifest.sources) {
      if (!Object.hasOwn(NORMALIZERS, source.source) || seenSources.has(source.source) || !Array.isArray(source.pages)) throw new TypeError('Invalid run source.');
      if (!targetedOrders && source.operation === 'getOrder') throw new TypeError('Missing targeted import marker.');
      seenSources.add(source.source);
      const partitionedOrders = source.source === 'orders' && source.requestedFulfilledBy !== undefined;
      if (partitionedOrders && (!Array.isArray(source.requestedFulfilledBy)
        || source.requestedFulfilledBy.length !== 2
        || !['AMAZON', 'MERCHANT'].every(value => source.requestedFulfilledBy.includes(value)))) {
        throw new TypeError('Invalid order fulfillment partitions.');
      }
      const cancellationQueries = source.requestedFulfillmentStatuses !== undefined;
      if (cancellationQueries && (!partitionedOrders || !Array.isArray(source.requestedFulfillmentStatuses)
        || source.requestedFulfillmentStatuses.length !== 1 || source.requestedFulfillmentStatuses[0] !== 'CANCELLED')) {
        throw new TypeError('Invalid cancellation query provenance.');
      }
      const observedAt = iso(source.finishedAt) ?? iso(manifest.finishedAt) ?? iso(source.startedAt) ?? iso(manifest.startedAt);
      if (!observedAt) throw new TypeError('Run has no valid observation timestamp.');
      const records = [];
      const partitionLastPages = new Map();
      for (const page of source.pages) {
        const pageObservedAt = iso(page.observedAt) ?? observedAt;
        let fulfilledByQuery;
        let fulfillmentStatusesQuery;
        if (partitionedOrders) {
          const filters = page.requestFilters;
          if (!filters || Object.keys(filters).some(key => !['fulfilledBy', 'fulfillmentStatuses'].includes(key)) || !Array.isArray(filters.fulfilledBy)
            || filters.fulfilledBy.length !== 1 || !['AMAZON', 'MERCHANT'].includes(filters.fulfilledBy[0])) {
            throw new TypeError('Missing order query provenance.');
          }
          fulfilledByQuery = filters.fulfilledBy;
          if (filters.fulfillmentStatuses !== undefined) {
            if (!cancellationQueries || !Array.isArray(filters.fulfillmentStatuses) || filters.fulfillmentStatuses.length !== 1 || filters.fulfillmentStatuses[0] !== 'CANCELLED') {
              throw new TypeError('Invalid cancellation page provenance.');
            }
            fulfillmentStatusesQuery = filters.fulfillmentStatuses;
          }
          partitionLastPages.set(`${fulfilledByQuery[0]}:${fulfillmentStatusesQuery ? 'CANCELLED' : 'BASE'}`, page.hasNextPage);
        } else if (page.requestFilters !== undefined) {
          throw new TypeError('Unexpected query provenance.');
        }
        const rawBody = await snapshotStore.readPage({ source: source.source, hash: page.hash });
        let normalized = NORMALIZERS[source.source](rawBody, { storeId: manifest.storeId, observedAt: pageObservedAt,
          ...(targetedOrders ? { envelope: 'individual', expectedOrderId: page.requestedOrderId } : {}),
          ...(fulfilledByQuery ? { fulfilledByQuery } : {}), ...(fulfillmentStatusesQuery ? { fulfillmentStatusesQuery } : {}) });
        if (targetedOrders && (normalized.length !== 1 || normalized[0].marketplaceId
          && normalized[0].marketplaceId !== manifest.marketplaceId)) throw new TypeError('Targeted order identity mismatch.');
        if (targetedRefunds) {
          if (normalized.length !== page.records) throw new TypeError('Targeted transaction count mismatch.');
          normalized = refundHistoryRecords(normalized, manifest.importMode);
          if (normalized.some(item => item.orderIds.length !== 1 || item.orderIds[0] !== source.requestedOrderId
            || item.marketplaceId && item.marketplaceId !== manifest.marketplaceId)) throw new TypeError('Targeted refund identity mismatch.');
        }
        for (const item of normalized) {
          if (item.storeId !== manifest.storeId) throw new Error('Normalized store mismatch.');
          records.push({ item, id: entityId(source.source, item), pageHash: page.hash, observedAt: pageObservedAt, versionHash: recordHash(item) });
        }
      }
      const expectedPartitions = ['AMAZON', 'MERCHANT'].flatMap(value => [`${value}:BASE`, ...(cancellationQueries ? [`${value}:CANCELLED`] : [])]);
      const allPartitionsComplete = !partitionedOrders || expectedPartitions.every(value => partitionLastPages.has(value) && partitionLastPages.get(value) === false);
      const complete = !targetedOrders && !targetedRefunds && source.status === 'api-pages-complete' && source.pages.length > 0 && source.pages.at(-1).hasNextPage === false && allPartitionsComplete;
      staged.push({ source, records, observedAt, complete });
    }
    let insertedOrders = 0, skippedExistingOrders = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.db.prepare('SELECT 1 FROM stores WHERE store_id=?').get(manifest.storeId)) this.registerStore({ storeId: manifest.storeId, marketplaceId: manifest.marketplaceId });
      this.db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?)').run(manifest.storeId, manifest.id, manifestHash, iso(manifest.startedAt), iso(manifest.finishedAt), manifest.status ?? 'unknown');
      for (const { source, records, observedAt, complete } of staged) {
        this.db.prepare('INSERT INTO coverage VALUES(?,?,?,?,?,?,?,?,?,?)').run(
          manifest.storeId, manifest.id, source.source, complete ? 'api-pages-complete' : source.status === 'api-pages-complete' ? 'partial' : source.status ?? 'unknown',
          source.dateBasis ?? null, source.requestedWindow?.from ?? null, source.requestedWindow?.to ?? null,
          observedAt, records.length, source.pages.length,
        );
        const lastCompleteAt = this.db.prepare('SELECT last_complete_at FROM source_state WHERE store_id=? AND source=?').get(manifest.storeId, source.source)?.last_complete_at;
        for (const record of records) {
          // Recheck under the write lock: the monitor may have imported this
          // order while its individual response was being fetched or staged.
          if (targetedOrders && this.db.prepare("SELECT 1 FROM entities WHERE store_id=? AND source='orders' AND source_id=?").get(manifest.storeId, record.id)) {
            skippedExistingOrders++; continue;
          }
          this.#observe(manifest, source.source, record, lastCompleteAt);
          if (targetedOrders) insertedOrders++;
        }
        if (complete && (!lastCompleteAt || observedAt >= lastCompleteAt)) {
          if (source.source === 'fba-inventory') {
            const seen = new Set(records.map(record => record.id));
            for (const current of this.db.prepare('SELECT source_id, observed_at FROM entities WHERE store_id=? AND source=?').all(manifest.storeId, source.source)) {
              if (current.observed_at <= observedAt) this.db.prepare('UPDATE entities SET active=? WHERE store_id=? AND source=? AND source_id=?').run(seen.has(current.source_id) ? 1 : 0, manifest.storeId, source.source, current.source_id);
            }
          }
          this.db.prepare(`INSERT INTO source_state VALUES(?,?,?) ON CONFLICT(store_id,source) DO UPDATE SET last_complete_at=excluded.last_complete_at`).run(manifest.storeId, source.source, observedAt);
        }
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { imported: true, runId: manifest.id, ...(targetedOrders ? { insertedOrders, skippedExistingOrders } : {}) };
  }

  #observe(manifest, source, record, lastCompleteAt) {
    const { item, id, pageHash, observedAt, versionHash } = record;
    let latestItem = item;
    let payload = JSON.stringify(item);
    let latestHash = versionHash;
    this.db.prepare('INSERT OR IGNORE INTO observations VALUES(?,?,?,?,?,?,?,?)')
      .run(manifest.storeId, source, id, manifest.id, observedAt, pageHash, versionHash, payload);
    const current = this.db.prepare('SELECT * FROM entities WHERE store_id=? AND source=? AND source_id=?').get(manifest.storeId, source, id);
    if (current) {
      if (observedAt > current.last_seen_at) this.db.prepare('UPDATE entities SET last_seen_at=? WHERE store_id=? AND source=? AND source_id=?').run(observedAt, manifest.storeId, source, id);
      // Do not let an older observation overwrite a newer state. At equal
      // timestamps a released financial record wins over a deferred snapshot.
      if (observedAt < current.observed_at || (observedAt === current.observed_at && source === 'transactions' && isReleased(current) && !isReleased(item))) return;
      // Missing status on an unfiltered response is not evidence that a known
      // cancellation or pending payment has ended. Preserve its provenance.
      if (source === 'orders' && !item.status && ['CANCELLED','PENDING','PENDING_AVAILABILITY'].includes(String(current.status ?? '').trim().toUpperCase()) && !item.warnings?.some(warning => warning.code === 'CONFLICTING_STATUS_FILTER')) {
        const previous = JSON.parse(current.payload_json);
        latestItem = { ...item, status: previous.status, statusEvidence: previous.statusEvidence };
        payload = JSON.stringify(latestItem);
        latestHash = recordHash(latestItem);
      }
    }
    const active = source !== 'fba-inventory' || !lastCompleteAt || observedAt >= lastCompleteAt ? 1 : (current?.active ?? 0);
    this.db.prepare(`INSERT INTO entities VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(store_id,source,source_id) DO UPDATE SET observed_at=excluded.observed_at,
      last_seen_at=MAX(entities.last_seen_at,excluded.last_seen_at),version_hash=excluded.version_hash,
      status=excluded.status,active=excluded.active,payload_json=excluded.payload_json`)
      .run(manifest.storeId, source, id, observedAt, observedAt, latestHash, latestItem.status ?? null, active, payload);
  }

  #records(source, filters = {}, active = true) {
    const storeId = canonicalStoreSelection(filters.storeId);
    parseStoreSelection(storeId);
    const trackingIndex = source === 'orders' ? latestTrackingIndex(this.db, storeId) : null;
    const stores = parseStoreSelection(storeId) || this.listStores().map(store => store.storeId).sort();
    const rows = this.db.prepare(`SELECT payload_json FROM entities WHERE store_id=? AND source=?${active ? ' AND active=1' : ''}`);
    const result = [];
    for (const id of stores) for (const row of rows.iterate(id,source)) {
      const item = JSON.parse(row.payload_json);
      if (source !== 'orders') { result.push(item); continue; }
      item.financialEligibility = orderFinancialEligibility(item);
      const tracking = trackingIndex.get(JSON.stringify([item.storeId, item.orderId]));
      if (!tracking || tracking.observedAt <= item.observedAt) { result.push(decorateOrderStatus(item)); continue; }
      const packages = mergeTrackingPackages(item.packages ?? [], tracking.packages);
      result.push(decorateOrderStatus({ ...item, packages, trackingObservedAt: tracking.observedAt }));
    }
    return result;
  }

  #coverage(filters = {}) {
    const storeId = canonicalStoreSelection(filters.storeId);
    parseStoreSelection(storeId);
    return this.db.prepare(`SELECT store_id AS storeId,run_id AS runId,source,status,date_basis AS dateBasis,
      from_at AS "from",to_at AS "to",observed_at AS observedAt,records_observed AS recordsObserved,pages_count AS pagesCount
      FROM coverage WHERE (? IS NULL OR store_id IN (SELECT value FROM json_each(?))) ORDER BY observed_at DESC`).all(...storeArgs(storeId)).map(row => ({ ...row }));
  }

  listStores() {
    return this.db.prepare('SELECT store_id AS storeId,name,marketplace_id AS marketplaceId FROM stores ORDER BY name').all().map(row => ({ ...row }));
  }

  getBootstrap({ storeId, synchronize = true } = {}) {
    if (storeId !== undefined) requireStoreId(storeId);
    if (synchronize) this.syncRefundManagement(storeId ? { storeId } : {});
    const coverage = this.#coverage({ storeId });
    return { stores: this.listStores().filter(store => !storeId || store.storeId === storeId), coverage, reviewStatuses: this.reviewStatusSettings(),
      latestSync: coverage.find(source => source.status === 'api-pages-complete')?.observedAt ?? null,
      latestAttemptAt: coverage[0]?.observedAt ?? null };
  }

  #orderFinancial(order, linked, eligibility) {
    const allocated = linked.filter(transaction => new Set(transaction.orderIds).size === 1);
    const included = allocated.filter(transaction => !eligibility.excludedKeys.has(JSON.stringify([transaction.storeId,transaction.transactionId])));
    return { ...financeTotals(orderFinancialEligibility(order).included ? included : []), financialEligibility: orderFinancialEligibility(order),
      // Retain references for the visible page; never recalculate revenue for
      // the entire order history merely to show twenty product costs.
      costTransactions: included.filter(item => item.type === 'Shipment' || item.type === 'ServiceFee'),
      excludedPendingTransactionCount: linked.filter(transaction => eligibility.excludedKeys.has(JSON.stringify([transaction.storeId,transaction.transactionId]))).length,
      linkedTransactionCount: linked.length, unallocatedTransactionCount: linked.length - allocated.length };
  }

  #orderCatalogue(filters) {
    const key = canonicalStoreSelection(filters.storeId);
    parseStoreSelection(key);
    const revision = this.#ordersRevision();
    if (this.#ordersCache?.key === key && this.#ordersCache.revision === revision) return this.#ordersCache.data;
    const transactions = this.#records('transactions', filters);
    const allOrders = this.#records('orders', filters), eligibility = transactionFinancialEligibility(transactions, allOrders);
    const linkedByOrder = new Map();
    for (const transaction of transactions) {
      for (const orderId of new Set(transaction.orderIds ?? [])) {
        const identity = JSON.stringify([transaction.storeId, orderId]);
        const linked = linkedByOrder.get(identity) ?? [];
        linked.push(transaction); linkedByOrder.set(identity, linked);
      }
    }
    const financialOrders = allOrders.map(order => ({ ...order,
      financial: this.#orderFinancial(order, linkedByOrder.get(JSON.stringify([order.storeId, order.orderId])) ?? [], eligibility) }));
    const projection = projectLocalReviews(this.db, 'orders', financialOrders, row => row.orderId);
    const data = { items: projection.items.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))
      || a.orderId.localeCompare(b.orderId) || a.storeId.localeCompare(b.storeId)), reviewStatuses: projection.reviewStatuses,
      coverage: this.#coverage(filters) };
    // Do not cache a list built while an external collector was committing.
    if (revision === this.#ordersRevision()) this.#ordersCache = { key, revision, data };
    else this.#ordersCache = null;
    return data;
  }

  orders(filters = {}) {
    const statuses = orderStatusFilter(filters.status);
    const net = filters.net ?? 'all', reviewStatus = filters.reviewStatus ?? 'all';
    if (!['all', 'positive', 'receivable'].includes(net)) throw new TypeError('Invalid order net filter.');
    if (typeof reviewStatus !== 'string' || reviewStatus !== 'all' && !statusDefinition(this.db, reviewStatus)) {
      throw Object.assign(new TypeError('Invalid review filter.'), { code: 'INVALID_PARAMETERS' });
    }
    const catalogue = this.#orderCatalogue(filters);
    const scoped = catalogue.items.filter(order => matchesOrder(order, filters, null)
      && (net === 'all' || order.financial.byCurrency.some(row => money(row[net === 'receivable' ? 'deferredCents' : 'netCents']) > 0n)));
    const reviewed = scoped.filter(order => reviewStatus === 'all' || order.review.status === reviewStatus);
    const statusCounts = new Map();
    for (const order of reviewed) {
      const { code, label } = order.displayStatus;
      const option = statusCounts.get(code) ?? { code, label, count: 0 };
      option.count++; statusCounts.set(code, option);
    }
    const statusOptions = [...statusCounts.values()].sort((a, b) => a.code === 'UNKNOWN' ? 1 : b.code === 'UNKNOWN' ? -1 : a.label.localeCompare(b.label, 'pt-BR'));
    const matchesStatus = order => !statuses || statuses.has(String(order.displayStatus?.code ?? 'UNKNOWN').toUpperCase());
    const reviewStatusOptions = localReviewOptions(scoped.filter(matchesStatus));
    const page = pageItems(reviewed.filter(matchesStatus), filters), catalogueCosts = this.productCosts.read();
    return structuredClone({ ...page, items: page.items.map(order => withProductCost(order, catalogueCosts, this.db)), statusOptions, reviewStatusOptions,
      reviewStatuses: catalogue.reviewStatuses, coverage: catalogue.coverage, financialDateBasis: 'all-known-postings-for-selected-orders' });
  }

  reviewStatusSettings() { return reviewStatusSettings(this.db); }

  saveReviewStatus(input) {
    const status = saveReviewStatus(this.db, input);
    return { status, settings: this.reviewStatusSettings() };
  }

  #requireLocalReviewEntity({ menu, storeId, entityId }) {
    // Validate the identity before any lookup, including the specific store.
    readLocalReview(this.db, { menu, storeId, entityId });
    const exists = menu === 'customer-returns'
      ? this.db.prepare('SELECT payload_json FROM customer_return_records WHERE store_id=? AND return_id=?').get(storeId, entityId)
      : menu === 'orders'
        ? this.db.prepare("SELECT 1 FROM entities WHERE store_id=? AND source='orders' AND source_id=?").get(storeId, entityId)
        : hasReturnedOrder(this.db, storeId, entityId);
    if (!exists) throw Object.assign(new Error('Caso não encontrado.'), { code: 'CASE_NOT_FOUND' });
    return { orderId: menu === 'customer-returns' ? JSON.parse(exists.payload_json).orderId ?? null : entityId };
  }

  localReview(input) {
    const reference = this.#requireLocalReviewEntity(input);
    return { menu: input.menu, storeId: input.storeId, entityId: input.entityId, ...reference,
      review: readLocalReview(this.db, input), reviewHistory: getLocalReviewHistory(this.db, input),
      reviewStatuses: availableReviewStatuses(this.db, input.menu) };
  }

  saveLocalReview(input) {
    this.#requireLocalReviewEntity(input);
    return writeLocalReview(this.db, input);
  }

  saveReturnedManagement(input) {
    validateReturnedAction(input);
    for (const item of input.items) this.#requireLocalReviewEntity({ menu: 'returns', storeId: item.storeId, entityId: item.orderId });
    return saveReturnedManagement(this.db, input);
  }

  financialCases(kind, filters = {}) {
    const result = buildFinancialCases({ db: this.db, kind, transactions: this.#records('transactions', filters), orders: this.#records('orders', filters), filters });
    return { ...result, ...(kind === 'refunds' ? { items: linkRefundReturns(this.db, result.items) } : {}), coverage: this.#coverage(filters) };
  }

  #safeTEvidence(storeId, now = new Date()) {
    const scope = { storeId };
    const orders = this.#records('orders', scope), transactions = this.#records('transactions', scope);
    const allPages = read => {
      const items = []; let offset = 0, page;
      do { page = read(offset); items.push(...page.items); offset += page.limit; } while (page.hasMore);
      return items;
    };
    // Build complete evidence first. Filters and pagination apply only after
    // every source has been joined by store and order, never by a global order ID.
    const refundCases = allPages(offset => buildFinancialCases({ db: this.db, kind: 'refunds', transactions, orders,
      filters: { ...scope, limit: 500, offset } }));
    const returnedToSeller = allPages(offset => returnsView({ db: this.db, filters: { ...scope, limit: 500, offset }, now }));
    const selection = canonicalStoreSelection(storeId);
    const customerReturns = this.db.prepare(`SELECT store_id,return_id,observed_at,payload_json FROM customer_return_records
      WHERE (? IS NULL OR store_id IN (SELECT value FROM json_each(?)))`).all(...storeArgs(selection)).map(row => ({ ...JSON.parse(row.payload_json),
        storeId: row.store_id, returnId: row.return_id, observedAt: row.observed_at }));
    return { orders, transactions, refundCases, customerReturns, returnedToSeller };
  }

  safeTCases(filters = {}) {
    return { ...buildSafeTCases({ ...this.#safeTEvidence(filters.storeId), filters }), coverage: this.#coverage({ storeId: filters.storeId }) };
  }

  syncRefundManagement({ storeId = 'all', now = new Date() } = {}) {
    parseStoreSelection(storeId);
    const storeIds = parseStoreSelection(storeId) || this.listStores().map(item => item.storeId);
    const rows = [];
    // Reuse the same complete source evidence throughout this synchronous run.
    // Rebuilding it for every SAFE-T page multiplies full-history work by the
    // number of pages and needlessly repeats it after management writes.
    const evidence = this.#safeTEvidence(storeId, now);
    let offset = 0, page;
    do {
      page = buildSafeTCases({ ...evidence, filters: { storeId, limit: 500, offset } });
      rows.push(...page.items.filter(item => item.refund?.source === 'financial-transactions'));
      offset += page.limit;
    } while (page.hasMore);
    const result = syncRefundManagement({ db: this.db, rows, storeIds, now, creditIndex: reimbursementIndex(evidence.transactions),
      financialCaseIndex: new Map(evidence.refundCases.map(item => [JSON.stringify([item.storeId,item.caseId]),item])) });
    syncReturnedSafeTGranted(this.db, evidence.returnedToSeller, now);
    return result;
  }

  refundManagement(filters = {}) { return refundManagementView(this.db, filters); }
  refundManagementDetail(storeId, managementId) { return refundManagementDetail(this.db, storeId, managementId); }
  saveRefundManagement(input) {
    const checked = validateManagementAction(input);
    // Confirm exactly the imported evidence reviewed by the user. The collector
    // reconciles new credits and increments row versions; the atomic mutation
    // rejects stale versions and later credits reopen a finalized case.
    return mutateRefundManagement({ db: this.db, input: checked });
  }

  #financialCase(kind, storeId, caseId) {
    requireStoreId(storeId);
    return getFinancialCase({ db: this.db, kind, caseId, transactions: this.#records('transactions', { storeId }), orders: this.#records('orders', { storeId }), filters: { storeId } });
  }

  financialCaseDetail(kind, storeId, caseId) {
    const item = this.#financialCase(kind, storeId, caseId);
    return item && kind === 'refunds' ? linkRefundReturns(this.db, [item])[0] : item;
  }

  saveFinancialReview(input) {
    if (!this.#financialCase(input.kind, input.storeId, input.caseId)) throw Object.assign(new Error('Caso não encontrado.'), { code: 'CASE_NOT_FOUND' });
    return saveFinancialCaseReview({ db: this.db, ...input });
  }

  saveFinancialReviews(input) {
    if (input?.kind !== 'refunds' || !Array.isArray(input.items) || input.items.length < 1 || input.items.length > 100) throw Object.assign(new Error('Lote inválido.'), { code: 'INVALID_REVIEW' });
    for (const item of input.items) {
      if (!item || !this.#financialCase('refunds', item.storeId, item.caseId)) throw Object.assign(new Error('Caso não encontrado.'), { code: 'CASE_NOT_FOUND' });
    }
    return saveFinancialCaseReviews({ db: this.db, ...input });
  }

  customerReturns(filters = {}, returnId) {
    const transactions = this.#records('transactions', filters), orders = this.#records('orders', filters);
    const refundCases = [];
    let offset = 0, page;
    do {
      page = buildFinancialCases({ db: this.db, kind: 'refunds', transactions, orders, filters: { storeId: filters.storeId, limit: 500, offset } });
      refundCases.push(...page.items); offset += page.limit;
    } while (page.hasMore);
    return customerReturnsView({ db: this.db, orders, refundCases, filters, returnId });
  }

  orderDetail(storeId, orderId) {
    requireStoreId(storeId);
    const orders = this.#records('orders', { storeId });
    const order = orders.find(item => item.orderId === orderId);
    if (!order) return null;
    const allTransactions = this.#records('transactions', { storeId });
    const eligibility = transactionFinancialEligibility(allTransactions, orders);
    const transactions = allTransactions.filter(item => item.orderIds?.includes(orderId))
      .sort((a, b) => String(a.postedAt ?? '').localeCompare(String(b.postedAt ?? '')))
      .map(item => ({ ...item, allocation: new Set(item.orderIds).size === 1 ? 'order' : 'multiple-orders-unallocated',
        financialEligibility: eligibility.excludedKeys.has(JSON.stringify([item.storeId,item.transactionId]))
          ? { included:false,reason:'payment-pending' } : { included:true,reason:null } }));
    const effective = effectiveTransactions(transactions);
    for (const item of transactions) item.supersededByRelease = effective.superseded.has(txKey(item));
    const detail = { ...order, review: readLocalReview(this.db, { menu: 'orders', storeId, entityId: orderId }),
      financial: this.#orderFinancial(order, transactions, eligibility), transactions, coverage: this.#coverage({ storeId }) };
    return withProductCost(detail, this.productCosts.read(), this.db);
  }

  async returns(filters = {}) {
    const result = returnsView({ db: this.db, filters });
    const storeIds = parseStoreSelection(filters.storeId) || this.listStores().map(store => store.storeId);
    return { ...result, monitor: await readMonitorStatus({ rootDir: this.rootDir, storeIds }) };
  }

  syncSalesAlerts(filters = {}, now = new Date()) {
    const storeId=canonicalStoreSelection(filters.storeId);
    parseStoreSelection(storeId);
    const storeIds=parseStoreSelection(storeId) || this.listStores().map(s=>s.storeId);
    const since=new Date(Number(new Date(now))-62*86400000).toISOString();
    const orders=this.db.prepare("SELECT payload_json FROM entities WHERE source='orders' AND active=1 AND ((CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.createdAt') END)>=? OR (CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.createdAt') END) IS NULL) AND (? IS NULL OR store_id IN (SELECT value FROM json_each(?)))").all(since,...storeArgs(storeId)).map(row=>JSON.parse(row.payload_json));
    return syncSalesAlerts(this.db,{orders,inventory:this.#records('fba-inventory',filters),coverage:this.#coverage(filters),storeIds,now});
  }

  salesAlerts(filters = {}) { return salesAlertsView(this.db,filters); }
  saveSalesAlert(input) { return saveSalesAlert(this.db,input); }

  #salesOrders(filters = {}) {
    const storeId = canonicalStoreSelection(filters.storeId);
    parseStoreSelection(storeId);
    const storeIds = parseStoreSelection(storeId) || this.listStores().map(store => store.storeId);
    const revision = this.#ordersRevision();
    if (this.#salesOrdersCache?.storeId !== storeId || this.#salesOrdersCache.revision !== revision) {
      const orders = [];
      for (const row of this.db.prepare("SELECT payload_json FROM entities WHERE source='orders' AND active=1 AND (? IS NULL OR store_id IN (SELECT value FROM json_each(?)))").iterate(...storeArgs(storeId))) {
        const {storeId,orderId,createdAt,status,fulfillmentMode,items} = JSON.parse(row.payload_json);
        orders.push({storeId,orderId,createdAt,status,fulfillmentMode,items});
      }
      this.#salesOrdersCache = {storeId, revision, orders};
    }
    return {orders:this.#salesOrdersCache.orders, storeIds};
  }

  productSales(filters = {}) {
    const {orders,storeIds} = this.#salesOrders(filters);
    return productSales({orders,coverage:this.#coverage({storeId:filters.storeId}),storeIds,channels:filters.channels?.split(','),from:filters.from,to:filters.to});
  }

  productPanel(filters = {}) {
    const storeId = canonicalStoreSelection(filters.storeId);
    const now = new Date(), range = panelRange({...filters,now});
    const revision = this.#ordersRevision(), key = JSON.stringify([storeId,filters.channels,range.from,range.to]);
    const cached = this.#productPanelCache.get(key);
    if (cached?.revision === revision && cached.expiresAt > Number(now)) return cached.data;
    const {orders,storeIds} = this.#salesOrders({storeId});
    const returns = this.db.prepare('SELECT store_id,return_id,payload_json FROM customer_return_records WHERE (? IS NULL OR store_id IN (SELECT value FROM json_each(?)))')
      .iterate(...storeArgs(storeId));
    function* records() { for (const row of returns) yield {...JSON.parse(row.payload_json),storeId:row.store_id,returnId:row.return_id}; }
    const returnJobs = this.db.prepare('SELECT store_id AS storeId,report_type AS reportType,status,from_at AS "from",to_at AS "to",warning_count AS warningCount FROM customer_return_report_jobs WHERE (? IS NULL OR store_id IN (SELECT value FROM json_each(?)))').all(...storeArgs(storeId));
    const data = productPanel({orders,storeIds,returns:records(),returnJobs,coverage:this.#coverage({storeId}),channels:filters.channels?.split(','),from:range.from,to:range.to,now});
    if (revision === this.#ordersRevision()) {
      for (const [id,value] of this.#productPanelCache) if(value.revision !== revision || value.expiresAt <= Number(now))this.#productPanelCache.delete(id);
      if (this.#productPanelCache.size >= 8) this.#productPanelCache.delete(this.#productPanelCache.keys().next().value);
      this.#productPanelCache.set(key,{revision,expiresAt:Number(now)+60_000,data});
    }
    return data;
  }

  inventory(filters = {}) {
    const storeId = canonicalStoreSelection(filters.storeId);
    parseStoreSelection(storeId);
    const revision = this.#ordersRevision(), now = Date.now();
    const cacheKey = JSON.stringify([storeId, filters.forecast === 'true']);
    let snapshot = this.#inventoryCache.get(cacheKey);
    if (!snapshot || snapshot.revision !== revision || snapshot.expiresAt <= now) {
      snapshot = { revision, expiresAt: now + 60_000, ...this.#inventorySnapshot(storeId, filters.forecast === 'true') };
      // Imports invalidate every scope, including commits by the collector.
      // Never retain a calculation spanning an external database change.
      if (this.#ordersRevision() === revision) {
        for (const [key, cached] of this.#inventoryCache) {
          if (cached.revision !== revision || cached.expiresAt <= now) this.#inventoryCache.delete(key);
        }
        this.#inventoryCache.delete(cacheKey);
        this.#inventoryCache.set(cacheKey, snapshot);
        if (this.#inventoryCache.size > 8) this.#inventoryCache.delete(this.#inventoryCache.keys().next().value);
      }
    }
    const query = searchText(filters.query);
    const catalogueCosts = this.productCosts.read();
    const items = snapshot.items.filter(item => !query || searchText([item.sellerSku, item.asin, item.fnSku, item.title].filter(Boolean).join(' ')).includes(query))
      .map(item => ({ ...item, cost: inventoryCost(item, catalogueCosts) }));
    const summary = inventorySummary(items);
    if (!snapshot.hasCompleteSnapshot) {
      for (const key of Object.keys(summary.unknownByField)) {
        summary[key] = null;
        summary.unknownByField[key] += Math.max(1, snapshot.missingStoreIds.length);
      }
      summary.unknownQuantities = Object.values(summary.unknownByField).reduce((sum, count) => sum + count, 0);
    }
    const { revision: ignoredRevision, expiresAt: ignoredExpiry, items: ignoredItems, ...metadata } = snapshot;
    return structuredClone({ ...pageItems(items, filters), ...metadata, summary,
      costSummary: inventoryCostSummary(items, catalogueCosts, snapshot.hasCompleteSnapshot) });
  }

  #inventorySnapshot(storeId, includeForecast) {
    const selectedStoreIds = parseStoreSelection(storeId) || this.listStores().map(store => store.storeId);
    // An exact store/source lookup uses the existing index. An all-store OR
    // predicate made SQLite scan unrelated financial and order payloads.
    const stockRows = this.db.prepare("SELECT payload_json FROM entities WHERE store_id=? AND source='fba-inventory' AND active=1");
    let items = selectedStoreIds.flatMap(id => stockRows.all(id).map(row => JSON.parse(row.payload_json)))
      .sort((a, b) => String(a.sellerSku).localeCompare(String(b.sellerSku)));
    const observationDates = [...new Set(items.map(item => item.observedAt).filter(Boolean))].sort();
    const coverageRows = this.db.prepare(`SELECT store_id AS storeId,run_id AS runId,source,status,date_basis AS dateBasis,
      from_at AS "from",to_at AS "to",observed_at AS observedAt,records_observed AS recordsObserved,pages_count AS pagesCount
      FROM coverage WHERE store_id=? AND source IN ('orders','fba-inventory')`);
    const allCoverage = selectedStoreIds.flatMap(id => coverageRows.all(id)).sort((a,b) => b.observedAt.localeCompare(a.observedAt));
    const coverage = allCoverage.filter(item => item.source === 'fba-inventory');
    let forecast = null;
    if (includeForecast) {
      // Stream only compact FBA sales fields for stores that actually have stock
      // records. Full order payloads and other fulfillment channels stay in SQLite.
      const salesRows = this.db.prepare(`SELECT store_id AS storeId,
        json_extract(payload_json,'$.createdAt') AS createdAt,json_extract(payload_json,'$.status') AS status,
        json_extract(payload_json,'$.items') AS items FROM entities
        WHERE store_id=? AND source='orders' AND active=1 AND json_extract(payload_json,'$.fulfillmentMode')='FBA'`);
      function* sales() {
        for (const id of new Set(items.map(item => item.storeId))) {
          for (const row of salesRows.iterate(id)) yield { storeId: row.storeId, createdAt: row.createdAt, status: row.status, fulfillmentMode: 'FBA', items: JSON.parse(row.items || '[]') };
        }
      }
      const result = inventoryForecast({ items, orders: sales(), coverage: allCoverage });
      items = result.items; forecast = { generatedAt: result.generatedAt, periods: result.periods };
    }
    const storeStates = selectedStoreIds.map(storeId => {
      const attempts = coverage.filter(source => source.storeId === storeId);
      const complete = attempts.find(source => source.status === 'api-pages-complete');
      const usable = attempts.find(source => source.pagesCount > 0);
      return { storeId, hasCompleteSnapshot: Boolean(complete),
        state: !usable ? 'missing' : attempts[0].status === 'failed' ? 'stale' : attempts[0].status === 'api-pages-complete' ? 'complete' : 'partial' };
    });
    const missingStoreIds = storeStates.filter(store => !store.hasCompleteSnapshot).map(store => store.storeId);
    const hasCompleteSnapshot = storeStates.length > 0 && !missingStoreIds.length;
    const state = !storeStates.length || storeStates.every(store => store.state === 'missing') ? 'missing'
      : missingStoreIds.length ? 'incomplete' : storeStates.some(store => store.state === 'partial') ? 'partial'
      : storeStates.some(store => store.state === 'stale') ? 'stale' : 'complete';
    return { items, state, hasCompleteSnapshot, missingStoreIds, coverage, ...(forecast ? { forecast } : {}), dateBasis: 'current-observed-snapshot',
      observationRange: { from: observationDates[0] ?? null, to: observationDates.at(-1) ?? null }, mixedObservationTimes: observationDates.length > 1 };
  }

  #dashboardScope(filters = {}) {
    const statuses = orderStatusFilter(filters.status);
    const allOrders = this.#records('orders', filters);
    const orders = allOrders.filter(order => matchesOrder(order, filters, statuses));
    const scopedOrders = new Set(allOrders.filter(order => matchesOrder(order, { ...filters, from: null, to: null }, statuses)).map(order => `${order.storeId}\u0000${order.orderId}`));
    const transactionScopeNeeded = (filters.mode && filters.mode !== 'all') || (filters.query && String(filters.query).trim()) || statuses !== null;
    const eligibility = transactionFinancialEligibility(this.#records('transactions', filters), allOrders);
    const periodTransactions = effectiveTransactions(eligibility.included).items.filter(transaction => inPeriod(transaction.postedAt, filters));
    const excludedPeriodTransactions = effectiveTransactions(eligibility.excluded).items.filter(transaction => inPeriod(transaction.postedAt, filters));
    let unallocatedFilteredTransactionCount = 0;
    const matchesFinancialScope = (transaction, countUnallocated = false) => {
      if (!transactionScopeNeeded) return true;
      const orderIds = [...new Set(transaction.orderIds ?? [])];
      const matched = orderIds.filter(orderId => scopedOrders.has(`${transaction.storeId}\u0000${orderId}`));
      if (countUnallocated && matched.length && matched.length !== orderIds.length) unallocatedFilteredTransactionCount++;
      return orderIds.length > 0 && matched.length === orderIds.length;
    };
    const transactions = periodTransactions.filter(transaction => matchesFinancialScope(transaction, true));
    const excludedTransactions = excludedPeriodTransactions.filter(transaction => matchesFinancialScope(transaction));
    return { orders, allOrders, transactions, excludedTransactions, eligibility, unallocatedFilteredTransactionCount };
  }

  dashboard(filters = {}) {
    const { orders, allOrders, transactions, excludedTransactions, eligibility, unallocatedFilteredTransactionCount } = this.#dashboardScope(filters);
    const sales = new Map();
    const nonCancelledOrders = orders.filter(order => !['CANCELLED', 'CANCELED'].includes(String(order.status ?? '').trim().toUpperCase()));
    const financialOrders = nonCancelledOrders.filter(order => orderFinancialEligibility(order).included);
    let ordersWithoutAmount = 0;
    for (const order of financialOrders) {
      const amount = money(order.grandTotalCents);
      if (amount === null || !order.currency) { ordersWithoutAmount++; continue; }
      const row = sales.get(order.currency) ?? { currency: order.currency, grandTotalCents: 0n, orderCount: 0 };
      row.grandTotalCents += amount;
      row.orderCount++;
      sales.set(order.currency, row);
    }
    const knownOrders = new Set(allOrders.map(order => `${order.storeId}\u0000${order.orderId}`));
    const financial = financeTotals(transactions);
    const refunds = transactions.filter(transaction => transaction.type === 'Refund');
    return {
      counts: { orders: orders.length, transactions: transactions.length, inventorySkus: this.#records('fba-inventory', filters).length, ordersWithoutAmount,
        refunds: refundEventCount(refunds), refundedOrders: new Set(refunds.flatMap(transaction => (transaction.orderIds || []).map(id => JSON.stringify([transaction.storeId, id])))).size,
        ordersWithoutTotal: ordersWithoutAmount, ordersWithoutCosts: financialOrders.length, cancelledOrders: orders.length - nonCancelledOrders.length, unallocatedFilteredTransactionCount,
        excludedPendingOrders: orders.filter(order => !orderFinancialEligibility(order).included).length,
        excludedPendingTransactions: excludedTransactions.length,
        mixedPendingTransactions: excludedTransactions.filter(transaction => eligibility.mixedKeys.has(JSON.stringify([transaction.storeId,transaction.transactionId]))).length,
        transactionsWithoutKnownOrder: transactions.filter(item => !item.orderIds?.some(orderId => knownOrders.has(`${item.storeId}\u0000${orderId}`))).length },
      salesByCurrency: [...sales.values()].map(row => ({ ...row, grandTotalCents: row.grandTotalCents.toString(), grossCents: row.grandTotalCents.toString(), knownOrderCount: row.orderCount })),
      salesRevenue: salesRevenue(financialOrders, effectiveTransactions(eligibility.included).items),
      financeByCurrency: financial.byCurrency, financial, platformExpenses: platformExpenses(transactions),
      accountBalance: accountBalanceView(this.db, parseStoreSelection(filters.storeId) || this.listStores().map(store => store.storeId)),
      ...financeSeries(transactions),
      dateBasis: { sales: 'order-created-at', financial: 'transaction-posted-at', inventory: 'current-observed-snapshot' },
      temporalModel: 'latest-known-state-by-posted-date',
      coverage: this.#coverage(filters), costCents: null, profitCents: null, cashReceivedCents: null,
    };
  }

  dashboardTransactions(filters = {}) {
    const bucket = filters.bucket ?? 'net';
    if (!['type', 'net', 'released', 'deferred'].includes(bucket)
      || (bucket === 'type' && (typeof filters.type !== 'string' || !filters.type))
      || (bucket !== 'type' && filters.type !== undefined)
      || (filters.currency !== undefined && !/^[A-Z]{3}$/.test(filters.currency))) throw new TypeError('Invalid composition filter.');
    const { transactions, allOrders } = this.#dashboardScope(filters);
    const selected = transactions.filter(transaction => {
      if (money(transaction.totalCents) === null || !transaction.currency) return false;
      if (filters.currency && transaction.currency !== filters.currency) return false;
      if (bucket === 'type') return (transaction.type ?? 'Unknown') === filters.type;
      if (String(transaction.type ?? '').toLowerCase() === 'transfer') return false;
      if (bucket === 'released') return isReleased(transaction);
      if (bucket === 'deferred') return String(transaction.status ?? '').toUpperCase() === 'DEFERRED';
      return true;
    }).sort((a, b) => String(b.postedAt ?? '').localeCompare(String(a.postedAt ?? ''))
      || a.storeId.localeCompare(b.storeId) || a.transactionId.localeCompare(b.transactionId));
    const totals = new Map();
    for (const transaction of selected) {
      const total = totals.get(transaction.currency) ?? { currency: transaction.currency, totalCents: 0n, count: 0 };
      total.totalCents += money(transaction.totalCents); total.count++;
      totals.set(transaction.currency, total);
    }
    const knownOrders = new Set(allOrders.map(order => `${order.storeId}\u0000${order.orderId}`));
    const page = pageItems(selected, filters);
    return { ...page, items: page.items.map(transaction => ({ ...transaction,
      linkedOrders: [...new Set(transaction.orderIds ?? [])].map(orderId => ({ orderId,
        available: knownOrders.has(`${transaction.storeId}\u0000${orderId}`) })),
    })), totals: [...totals.values()].map(row => ({ ...row, totalCents: row.totalCents.toString() })),
    dateBasis: 'transaction-posted-at', bucket };
  }

  getEntityHistory(storeId, source, sourceId) {
    requireStoreId(storeId);
    if (!Object.hasOwn(NORMALIZERS, source)) throw new TypeError('Invalid source.');
    return this.db.prepare(`SELECT run_id AS runId,observed_at AS observedAt,page_hash AS pageHash,version_hash AS versionHash,payload_json AS payload
      FROM observations WHERE store_id=? AND source=? AND source_id=? ORDER BY observed_at,run_id`).all(storeId, source, sourceId).map(row => ({ ...row, payload: JSON.parse(row.payload) }));
  }

  getData(filters = {}) { return filters.view === 'sales' ? this.orders(filters) : filters.view === 'inventory' ? this.inventory(filters) : this.dashboard(filters); }
  getSummary(filters = {}) { return this.dashboard(filters); }
  getOrders(filters = {}) { return this.orders(filters); }
  getOrderDetail(storeId, orderId) { return this.orderDetail(storeId, orderId); }
  getInventory(filters = {}) { return this.inventory(filters); }
  close() { this.db.close(); }
}
