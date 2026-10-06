import { createHash } from 'node:crypto';
import { costDecimal, orderCostItemKey } from './product-costs.mjs';

export function ensureProductCostSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS product_cost_links (
    store_id TEXT NOT NULL, sku TEXT NOT NULL, company_id TEXT NOT NULL, product_id TEXT NOT NULL,
    version INTEGER NOT NULL, updated_at TEXT NOT NULL, unit_cost TEXT,
    PRIMARY KEY(store_id,sku,company_id));
    CREATE TABLE IF NOT EXISTS product_cost_bindings (
    store_id TEXT NOT NULL, sku TEXT NOT NULL, product_id TEXT NOT NULL, company_id TEXT NOT NULL,
    bound_at TEXT NOT NULL, unit_cost TEXT NOT NULL, PRIMARY KEY(store_id,sku,product_id,company_id));
    CREATE TABLE IF NOT EXISTS order_product_costs (
      store_id TEXT NOT NULL, order_id TEXT NOT NULL, item_key TEXT NOT NULL, sku TEXT NOT NULL,
      company_id TEXT NOT NULL, product_id TEXT NOT NULL, product_name TEXT NOT NULL,
      unit_cost TEXT NOT NULL, basis TEXT NOT NULL, effective_at TEXT NOT NULL, captured_at TEXT NOT NULL,
      PRIMARY KEY(store_id,order_id,item_key));
    CREATE TABLE IF NOT EXISTS order_cost_scans (
      store_id TEXT NOT NULL, order_id TEXT NOT NULL, version_hash TEXT NOT NULL,
      cost_revision TEXT NOT NULL, complete INTEGER NOT NULL, PRIMARY KEY(store_id,order_id));`);
}

export function readOrderCosts(db, storeId, orderId) {
  return db.prepare('SELECT * FROM order_product_costs WHERE store_id=? AND order_id=?').all(storeId,orderId);
}

export function syncOrderCosts(db, catalogue, now = new Date().toISOString(), scope = {}) {
  ensureProductCostSchema(db);
  if (!catalogue || catalogue.metadata.stale) return { captured:0, scanned:0, skipped:'cost-source-unavailable' };
  const snapshot=catalogue.snapshot;
  const skuScope=scope.skus ? JSON.stringify(scope.skus) : scope.sku!==undefined ? JSON.stringify([scope.sku]) : null;
  const revision=createHash('sha256').update(JSON.stringify([snapshot.companyId,snapshot.products,snapshot.links,snapshot.costHistory,snapshot.localLinks])).digest('hex');
  const normalized = sku => String(sku).trim().toLowerCase();
  const addBinding=db.prepare('INSERT OR IGNORE INTO product_cost_bindings VALUES(?,?,?,?,?,?)');
  const binding=db.prepare('SELECT * FROM product_cost_bindings WHERE store_id=? AND sku=? AND product_id=? AND company_id=?');
  const existing=db.prepare('SELECT sku FROM order_product_costs WHERE store_id=? AND order_id=? AND item_key=?');
  const save=db.prepare('INSERT OR IGNORE INTO order_product_costs VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  const mark=db.prepare(`INSERT INTO order_cost_scans VALUES(?,?,?,?,?) ON CONFLICT(store_id,order_id)
    DO UPDATE SET version_hash=excluded.version_hash,cost_revision=excluded.cost_revision,complete=excluded.complete`);
  let captured=0,scanned=0;
  const bind=(storeId,sku,product)=>{
    if (!product || costDecimal(product.averageCost) === null) return;
    const link = catalogue.link?.(storeId,sku);
    const localInitial = link?.source === 'synthamazon' && costDecimal(link.initialUnitCost) !== null;
    addBinding.run(storeId,normalized(sku),product.id,snapshot.companyId,localInitial ? link.boundAt : snapshot.exportedAt,
      localInitial ? link.initialUnitCost : product.averageCost);
  };
  db.exec('BEGIN IMMEDIATE');
  try {
    // Activate SKU costs before their first sale, so a later import can use the
    // source's timestamped price history rather than the price on import day.
    for (const storeId of catalogue.stores) {
      for (const product of catalogue.products.values()) if (catalogue.resolve(storeId,product.sku)?.id===product.id) bind(storeId,product.sku,product);
      for (const link of catalogue.links) if (link.storeId===storeId) bind(storeId,link.sellerSku,catalogue.resolve(storeId,link.sellerSku));
    }
    db.exec('COMMIT');
    const rows=db.prepare(`SELECT e.source_id AS order_id,e.version_hash,json_extract(e.payload_json,'$.createdAt') AS created_at,
      json_extract(e.payload_json,'$.status') AS status,json_extract(e.payload_json,'$.items') AS items
      FROM entities e LEFT JOIN order_cost_scans s ON s.store_id=e.store_id AND s.order_id=e.source_id
      WHERE e.store_id=? AND e.source='orders' AND e.active=1
      AND e.source_id>? AND (s.order_id IS NULL OR s.version_hash<>e.version_hash OR (s.complete=0 AND s.cost_revision<>?))
      AND (? IS NULL OR EXISTS(SELECT 1 FROM json_each(e.payload_json,'$.items') i WHERE json_extract(i.value,'$.sku') IN(SELECT value FROM json_each(?))))
      ORDER BY e.source_id LIMIT 300`);
    for (const storeId of catalogue.stores) {
      if (scope.storeId && scope.storeId !== storeId) continue;
      let cursor='';
      for (;;) {
        const batch=rows.all(storeId,cursor,revision,skuScope,skuScope);
        if (!batch.length) break;
        cursor=batch.at(-1).order_id;
        db.exec('BEGIN IMMEDIATE');
        for (const row of batch) {
      const created=Date.parse(row.created_at);
      // Do not freeze a sale using a snapshot captured before the sale occurred.
      if (!Number.isFinite(created) || created>Date.parse(snapshot.exportedAt)) continue;
      const items=JSON.parse(row.items || '[]'); let complete=items.length>0; scanned++;
      const ineligible=['CANCELLED','CANCELED','PENDING','PENDING_AVAILABILITY'].includes(String(row.status || '').toUpperCase());
      for (const item of items) {
        const itemKey=orderCostItemKey(item), prior=existing.get(storeId,row.order_id,itemKey);
        if (prior) { if (prior.sku!==item.sku) complete=false; continue; }
        const product=catalogue.resolve(storeId,item.sku);
        if (ineligible || !product || !Number.isSafeInteger(item.quantityOrdered) || item.quantityOrdered<=0) { complete=false;continue; }
        bind(storeId,item.sku,product);
        const initial=binding.get(storeId,normalized(item.sku),product.id,snapshot.companyId);
        if (!initial) { complete=false;continue; }
        let unit=initial.unit_cost,effective=initial.bound_at,basis='initial';
        if (created>Date.parse(initial.bound_at)) {
          basis='sale-time';
          for (const change of catalogue.history.get(product.id) || []) {
            if (Date.parse(change.effectiveAt)>created) break;
            if (Date.parse(change.effectiveAt)<=Date.parse(initial.bound_at)) continue;
            unit=change.unitCost;effective=change.effectiveAt;
          }
        }
        if (costDecimal(unit) === null) { complete=false;continue; }
        captured+=Number(save.run(storeId,row.order_id,itemKey,item.sku,snapshot.companyId,product.id,product.name,unit,basis,effective,now).changes);
      }
      mark.run(storeId,row.order_id,row.version_hash,revision,complete?1:0);
    }
        db.exec('COMMIT');
      }
    }
    return {captured,scanned};
  } catch(error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
}
