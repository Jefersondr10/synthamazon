import { costCents, costDecimal } from './product-costs.mjs';
import { syncOrderCosts } from './order-cost-ledger.mjs';
import { createHash } from 'node:crypto';
import { canonicalStoreSelection } from './store-filter.mjs';
import { classifiedSkuRows, groupSkuRows, normalizedAsin } from './product-sku-list.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const validText = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 512 && !/[\u0000-\u001f]/.test(value);
const productsFor = catalogue => [...catalogue.products.values()].map(product => ({id:product.id,sku:product.sku,name:product.name,
  unitCostCents:costDecimal(product.averageCost)===null ? null : costCents(costDecimal(product.averageCost))})).sort((a,b)=>a.name.localeCompare(b.name,'pt-BR'));

function persistLink(db, catalogue, storeId, sku, product, now) {
  const companyId=catalogue.snapshot.companyId;
  const local=db.prepare('SELECT product_id,version FROM product_cost_links WHERE store_id=? AND sku=? AND company_id=?').get(storeId,sku,companyId);
  if(local?.product_id===product.id) return false;
  db.prepare(`INSERT INTO product_cost_links VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(store_id,sku,company_id) DO UPDATE SET product_id=excluded.product_id,version=excluded.version,
    updated_at=excluded.updated_at,unit_cost=excluded.unit_cost`).run(storeId,sku,companyId,product.id,(local?.version || 0)+1,now,product.averageCost);
  return true;
}

export function validateProductCostGroup(input,saving=false) {
  const fields=['storeId','asin',...(saving?['companyId','productId','expectedRevision']:[])];
  if(!input || Array.isArray(input) || Object.keys(input).some(key=>!fields.includes(key)) || typeof input.storeId!=='string'
    || !normalizedAsin(input.asin) || saving && (!validText(input.companyId) || !validText(input.productId) || !/^[a-f0-9]{64}$/.test(input.expectedRevision || ''))) throw new TypeError('Invalid ASIN group.');
  return {...input,storeId:canonicalStoreSelection(input.storeId),asin:normalizedAsin(input.asin)};
}

function groupContext(db,reader,input,cache={}) {
  const {rows,catalogue}=classifiedSkuRows(db,reader,input.storeId,cache);
  if(!catalogue) fail('COST_SOURCE_UNAVAILABLE');
  const group=groupSkuRows(rows.filter(row=>normalizedAsin(row.asin)===input.asin))[0];
  if(!group) fail('CASE_NOT_FOUND');
  const expectedRevision=createHash('sha256').update(JSON.stringify([input.storeId,input.asin,catalogue.snapshot.companyId,
    group.members.map(row=>[row.storeId,row.sku,row.source,row.linkedProductId,row.version,row.status])])).digest('hex');
  return {catalogue,group,expectedRevision};
}

export function productCostGroup(db,reader,input,cache) {
  input=validateProductCostGroup(input);
  const {catalogue,group,expectedRevision}=groupContext(db,reader,input,cache);
  return {...input,...group,companyId:catalogue.snapshot.companyId,companyName:catalogue.snapshot.companyName,
    expectedRevision,stale:catalogue.metadata.stale,editable:group.editableCount>0,
    products:productsFor(catalogue)};
}

export function saveProductCostGroup(db,reader,input) {
  input=validateProductCostGroup(input,true);
  const now=new Date().toISOString();let updated=0,members;
  db.exec('BEGIN IMMEDIATE');
  try {
    // Fresh identities inside the transaction: a SKU arriving or moving to
    // another ASIN since the dialog opened must require reviewing the group.
    const {catalogue,group,expectedRevision}=groupContext(db,reader,input);
    if(catalogue.metadata.stale) fail('COST_SOURCE_UNAVAILABLE');
    if(input.companyId!==catalogue.snapshot.companyId || input.expectedRevision!==expectedRevision) fail('COST_LINK_CONFLICT');
    members=group.members.filter(row=>row.editable);
    if(!members.length) fail(group.members.some(row=>row.source==='erp')?'COST_LINK_EXTERNAL':'COST_STORE_UNLINKED');
    const product=catalogue.products.get(input.productId);
    if(!product) throw new TypeError('Unknown cost product.');
    for(const row of members) if(persistLink(db,catalogue,row.storeId,row.sku,product,now)) updated++;
    db.exec('COMMIT');
  } catch(error) {db.exec('ROLLBACK');throw error;}
  let captured=0,syncPending=false;
  const stores=[...new Set(members.map(row=>row.storeId))];
  for(const storeId of stores) {
    try {
      const result=syncOrderCosts(db,reader.read(),now,{storeId,skus:members.filter(row=>row.storeId===storeId).map(row=>row.sku)});
      captured+=result.captured;syncPending ||= !!result.skipped;
    } catch {syncPending=true;}
  }
  return {saved:true,updated,matched:members.length,unchanged:updated===0,captured,syncPending};
}
export function validateProductCostLink(input, saving = false) {
  const fields = ['storeId', 'orderId', 'sku', ...(saving ? ['productId', 'companyId', 'expectedVersion'] : [])];
  if (!input || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key))
    || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.storeId || '') || input.storeId === 'all'
    || input.orderId !== undefined && (typeof input.orderId !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(input.orderId)) || !validText(input.sku)
    || saving && (!validText(input.productId) || !validText(input.companyId)
      || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0)) throw new TypeError('Invalid product link.');
  return input;
}

function context(db, reader, input) {
  const catalogue = reader.read();
  if (!catalogue) fail('COST_SOURCE_UNAVAILABLE');
  if (!catalogue.stores.has(input.storeId)) fail('COST_STORE_UNLINKED');
  let item;
  if (input.orderId !== undefined) {
    const row = db.prepare(`SELECT payload_json FROM entities WHERE store_id=? AND source='orders' AND source_id=? AND active=1`).get(input.storeId, input.orderId);
    item = row ? JSON.parse(row.payload_json).items?.find(item => item.sku === input.sku) : null;
  } else {
    item = db.prepare(`SELECT json_extract(payload_json,'$.title') AS title FROM entities
      WHERE store_id=? AND source='fba-inventory' AND active=1 AND json_extract(payload_json,'$.sellerSku')=? LIMIT 1`).get(input.storeId,input.sku);
    item ||= db.prepare(`SELECT json_extract(i.value,'$.title') AS title FROM entities e,json_each(e.payload_json,'$.items') i
      WHERE e.store_id=? AND e.source='orders' AND e.active=1 AND json_extract(i.value,'$.sku')=? LIMIT 1`).get(input.storeId,input.sku);
  }
  if (!item) fail('CASE_NOT_FOUND');
  const local = db.prepare('SELECT * FROM product_cost_links WHERE store_id=? AND sku=? AND company_id=?').get(input.storeId, input.sku, catalogue.snapshot.companyId);
  return { catalogue, item, local, link: catalogue.link(input.storeId, input.sku) };
}

export function productCostLink(db, reader, input) {
  validateProductCostLink(input);
  const { catalogue, item, local, link } = context(db, reader, input);
  return {
    ...input, title: item.title || input.sku,
    storeName: db.prepare('SELECT name FROM stores WHERE store_id=?').get(input.storeId)?.name || input.storeId,
    companyId: catalogue.snapshot.companyId, companyName: catalogue.snapshot.companyName,
    observedAt: catalogue.metadata.observedAt, stale: catalogue.metadata.stale,
    source: link.source, productId: link.productId, version: local?.version || 0, editable: link.source !== 'erp' && !catalogue.metadata.stale,
    products: productsFor(catalogue),
  };
}

export function saveProductCostLink(db, reader, input) {
  validateProductCostLink(input, true);
  let unchanged = false;
  db.exec('BEGIN IMMEDIATE');
  try {
    const { catalogue, local, link } = context(db, reader, input);
    if (catalogue.metadata.stale) fail('COST_SOURCE_UNAVAILABLE');
    if (input.companyId !== catalogue.snapshot.companyId || input.expectedVersion !== (local?.version || 0)) fail('COST_LINK_CONFLICT');
    if (link.source === 'erp') fail('COST_LINK_EXTERNAL');
    const product = catalogue.products.get(input.productId);
    if (!product) throw new TypeError('Unknown cost product.');
    unchanged = !persistLink(db,catalogue,input.storeId,input.sku,product,new Date().toISOString());
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  // Only backfill orders with this SKU here. The scheduled sync handles the
  // remainder without making a link editor wait for the full sales history.
  let sync;
  try { sync = syncOrderCosts(db, reader.read(), new Date().toISOString(), { storeId: input.storeId, sku: input.sku }); }
  catch { sync = { captured: 0, skipped: 'retry-on-scheduled-sync' }; }
  return { saved: true, unchanged, captured: sync.captured, syncPending: !!sync.skipped };
}
