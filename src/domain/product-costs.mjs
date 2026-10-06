import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { inventoryQuantities } from '../../public/inventory-quantities.js';

const scale = 10_000_000_000n;
const key = (...parts) => JSON.stringify(parts);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const units = value => Number.isSafeInteger(value) && value >= 0;
export const costDecimal = value => {
  if (typeof value !== 'string' || !/^\d{1,20}(?:\.\d{1,10})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * scale + BigInt(fraction.padEnd(10, '0'));
};
export const costCents = value => ((value * 100n + scale / 2n) / scale).toString();
const normalizeSku = value => typeof value === 'string' ? value.trim().toLowerCase() : '';

// The private exporter supplies only one explicitly configured company and stores.
// No order or stock movement is written by this integration.
export function costCatalogue(snapshot, now = Date.now(), localLinks = []) {
  if (!snapshot || snapshot.version !== 1 || !text(snapshot.companyId) || !text(snapshot.companyName)
    || !Number.isFinite(Date.parse(snapshot.exportedAt)) || Date.parse(snapshot.exportedAt) > now + 60_000
    || !Array.isArray(snapshot.storeIds) || !snapshot.storeIds.every(text)
    || !Array.isArray(snapshot.products) || snapshot.products.length > 50_000
    || !Array.isArray(snapshot.links) || !Array.isArray(snapshot.costHistory)) throw new TypeError('Invalid cost snapshot.');
  const stores = new Set(snapshot.storeIds), products = new Map(), bySku = new Map(), links = new Map(), history = new Map();
  for (const product of snapshot.products) {
    if (!text(product.id) || !text(product.sku) || !text(product.name) || products.has(product.id)
      || product.averageCost !== null && costDecimal(product.averageCost) === null) throw new TypeError('Invalid cost product.');
    products.set(product.id, product);
    const sku = normalizeSku(product.sku), matches = bySku.get(sku) || [];
    matches.push(product); bySku.set(sku, matches);
  }
  for (const link of snapshot.links) {
    const identity = key(link.storeId, link.sellerSku);
    if (!stores.has(link.storeId) || !text(link.sellerSku) || links.has(identity)
      || link.productId !== null && !text(link.productId)) throw new TypeError('Invalid cost link.');
    links.set(identity, link.productId);
  }
  const effectiveLinks = new Map(snapshot.links.map(link => [key(link.storeId, link.sellerSku), { ...link, source: 'erp' }]));
  for (const link of localLinks) {
    const identity = key(link.storeId, link.sellerSku);
    if (link.companyId !== snapshot.companyId || !stores.has(link.storeId) || !text(link.sellerSku)) continue;
    // Existing ERP/FBA links remain authoritative, even if the source product
    // has been removed. Never silently replace them with a local match.
    if (links.get(identity)) continue;
    links.set(identity, link.productId);
    effectiveLinks.set(identity, { ...link, source: 'synthamazon' });
  }
  for (const entry of snapshot.costHistory) {
    if (!text(entry.productId) || !Number.isSafeInteger(entry.version) || !Number.isFinite(Date.parse(entry.effectiveAt))
      || entry.unitCost !== null && costDecimal(entry.unitCost) === null) throw new TypeError('Invalid cost history.');
    const group = history.get(entry.productId) || [];
    group.push(entry); history.set(entry.productId, group);
  }
  for (const entries of history.values()) entries.sort((a,b) => Date.parse(a.effectiveAt)-Date.parse(b.effectiveAt) || a.version-b.version);
  const metadata = { source: 'Estoque Origem', companyName: snapshot.companyName, observedAt: snapshot.exportedAt,
    stale: now - Date.parse(snapshot.exportedAt) > 15 * 60_000, connected: true };
  const resolve = (storeId, sku) => {
    if (!stores.has(storeId)) return null;
    const productId = links.get(key(storeId, sku));
    if (productId) return products.get(productId) || null;
    const matches = bySku.get(normalizeSku(sku)) || [];
    return matches.length === 1 ? matches[0] : null;
  };
  return { metadata, stores, history, snapshot: { ...snapshot, localLinks }, products, links: [...effectiveLinks.values()], resolve,
    link(storeId, sku) {
      if (!stores.has(storeId)) return { source: 'unavailable', productId: null };
      const explicit = effectiveLinks.get(key(storeId, sku));
      if (explicit?.productId) return explicit;
      const product = resolve(storeId, sku);
      return { source: product ? 'sku' : 'none', productId: product?.id || null };
    } };
}

export class ProductCostReader {
  constructor(rootDir, db = null) { this.path = path.join(rootDir, 'erp-costs.json'); this.db = db; }
  read(now = Date.now()) {
    try {
      const stat = statSync(this.path);
      if (!stat.isFile() || stat.size > 20_000_000) throw new Error('Invalid cost file.');
      const localLinks = this.db ? this.db.prepare(`SELECT store_id AS storeId, sku AS sellerSku, company_id AS companyId,
        product_id AS productId, version, updated_at AS boundAt, unit_cost AS initialUnitCost
        FROM product_cost_links ORDER BY store_id,sku,company_id`).all() : [];
      const revision = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${JSON.stringify(localLinks)}`;
      if (this.revision !== revision) {
        this.snapshot = JSON.parse(readFileSync(this.path, 'utf8'));
        this.catalogue = costCatalogue(this.snapshot, now, localLinks); this.revision = revision;
      }
      this.catalogue.metadata.stale = now - Date.parse(this.snapshot.exportedAt) > 15 * 60_000;
      return this.catalogue;
    } catch { this.revision = null; this.snapshot = null; this.catalogue = null; return null; }
  }
}

const source = catalogue => catalogue?.metadata || { source: 'Estoque Origem', connected: false, observedAt: null, stale: false };
export function inventoryCost(item, catalogue) {
  const product = catalogue?.resolve(item.storeId, item.sellerSku), unit = costDecimal(product?.averageCost);
  const quantity = inventoryQuantities(item).usableQuantity;
  return { ...source(catalogue), currency: 'BRL', basis: 'current-average', productName: product?.name || null,
    unitCostCents: unit === null ? null : costCents(unit), unitCost: product?.averageCost ?? null,
    totalCents: quantity === 0 ? '0' : unit === null || quantity === null ? null : costCents(unit * BigInt(quantity)),
    quantity, reason: !catalogue?.stores.has(item.storeId) ? 'store-unlinked' : !product ? 'product-unlinked' : unit === null ? 'cost-missing' : null };
}
export function inventoryCostSummary(items, catalogue, completeSnapshot = true) {
  const missing = items.filter(item => item.cost.totalCents === null).length;
  const known = items.reduce((sum, item) => sum + BigInt(item.cost.totalCents || '0'), 0n).toString();
  return { ...source(catalogue), currency: 'BRL', totalCents: !missing && completeSnapshot ? known : null,
    knownTotalCents: known, missingCount: missing, itemCount: items.length, stockComplete: completeSnapshot, basis: 'current-average' };
}

export const orderCostItemKey = item => typeof item.orderItemId === 'string' && item.orderItemId ? `item:${item.orderItemId}` : `sku:${item.sku || ''}`;

export function orderCost(order, catalogue, saved = []) {
  const frozen = new Map(saved.map(row => [row.item_key, row]));
  let running = 0n, rounded = 0n;
  const items = (order.items || []).map(item => {
    const row = frozen.get(orderCostItemKey(item)), valid = row && row.sku === item.sku;
    const unit = valid ? costDecimal(row.unit_cost) : null, quantity = item.quantityOrdered;
    let totalCents = null;
    if (unit !== null && units(quantity)) {
      running += unit * BigInt(quantity);
      const cumulative = BigInt(costCents(running)); totalCents = (cumulative-rounded).toString(); rounded=cumulative;
    }
    return { sku:item.sku ?? null, quantity, productName:valid ? row.product_name : null,
      linkAvailable: !!item.sku && !!catalogue?.stores.has(order.storeId),
      unitCostCents:unit === null ? null : costCents(unit), totalCents,
      basis:valid ? row.basis : null, fixed:!!valid, capturedAt:valid ? row.captured_at : null,
      reason:!catalogue?.stores.has(order.storeId) ? 'store-unlinked' : !catalogue.resolve(order.storeId,item.sku) ? 'product-unlinked' : 'awaiting-capture' };
  });
  const complete=items.length>0 && items.every(item=>item.totalCents!==null);
  const totalCents=complete ? items.reduce((sum,item)=>sum+BigInt(item.totalCents),0n).toString() : null;
  const initial=items.some(item=>item.basis==='initial');
  const revenue = order.financial?.saleRevenue;
  const net = revenue?.netByCurrency?.length === 1 && revenue.netByCurrency[0].currency === 'BRL'
    && revenue.netOrderCount === 1 && !revenue.missingNetOrderCount && !revenue.unclassifiedFeeCount
    ? revenue.netByCurrency[0].netCents : null;
  const eligible = !['CANCELLED', 'CANCELED', 'PENDING', 'PENDING_AVAILABILITY'].includes(String(order.status || '').toUpperCase());
  return { ...source(catalogue), currency:'BRL',items,totalCents,fixed:complete,basis:initial?'initial':'sale-time',
    missingCount:items.filter(item=>item.totalCents===null).length,reason:items.find(item=>item.totalCents===null)?.reason || null,
    saleNetCents:eligible?net:null,
    resultCents:eligible && totalCents!==null && net!==null ? (BigInt(net)-BigInt(totalCents)).toString():null };
}
