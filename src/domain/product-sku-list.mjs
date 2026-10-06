import { storeArgs, canonicalStoreSelection } from './store-filter.mjs';
import { costCents, costDecimal } from './product-costs.mjs';

const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const statuses = new Set(['all','unlinked','linked','missing-cost','unavailable','partial','conflict']);
export const normalizedAsin = value => typeof value === 'string' && /^[A-Z0-9]{10}$/.test(value.trim().toUpperCase()) ? value.trim().toUpperCase() : null;
export function validateProductSkuFilters(filters = {}) {
  if (!filters || Array.isArray(filters) || Object.keys(filters).some(key => !['storeId','query','mode','linkStatus','limit','offset','groupBy'].includes(key))) throw new TypeError('Invalid SKU filters.');
  const storeId = canonicalStoreSelection(filters.storeId || 'all'), query = filters.query || '', mode = filters.mode || 'ALL', linkStatus = filters.linkStatus || 'all';
  const limit = Number(filters.limit ?? 50), offset = Number(filters.offset ?? 0);
  if (typeof query !== 'string' || query.length > 200 || /[\u0000-\u001f]/.test(query) || !['ALL','FBA','DBA','MFN'].includes(mode)
    || !statuses.has(linkStatus) || !['sku','asin'].includes(filters.groupBy || 'sku') || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw new TypeError('Invalid SKU filters.');
  return { storeId, query, mode, linkStatus, limit, offset, ...(filters.groupBy ? {groupBy:filters.groupBy} : {}) };
}

function skuRows(db, storeId) {
  const args = storeArgs(storeId), entries = new Map();
  // Read just item identities, never financial projections or full order objects.
  const orders = db.prepare(`SELECT e.store_id AS storeId,e.source_id AS orderId,json_extract(i.value,'$.sku') AS sku,
    json_extract(i.value,'$.title') AS title,json_extract(i.value,'$.asin') AS asin,
    json_extract(e.payload_json,'$.createdAt') AS createdAt,json_extract(e.payload_json,'$.fulfillmentMode') AS channel
    FROM entities e,json_each(e.payload_json,'$.items') i
    WHERE e.source='orders' AND e.active=1 AND (? IS NULL OR e.store_id IN(SELECT value FROM json_each(?)))
    AND typeof(json_extract(i.value,'$.sku'))='text' AND length(trim(json_extract(i.value,'$.sku')))>0`);
  // The correlated json_each emits each order's items consecutively. Group the
  // small identities as they stream, avoiding SQLite GROUP BY temporary files
  // containing large order payloads on production's bounded /tmp filesystem.
  for (const row of orders.iterate(...args)) {
    const key=JSON.stringify([row.storeId,row.sku]);
    let entry=entries.get(key);
    if (!entry) {
      entry={storeId:row.storeId,sku:row.sku,title:row.title,asin:row.asin,lastOrderAt:row.createdAt,orderCount:0,channels:new Set(),inInventory:false,lastSeenOrder:null};
      entries.set(key,entry);
    }
    if (entry.lastSeenOrder!==row.orderId) {entry.orderCount++;entry.lastSeenOrder=row.orderId;}
    if ((row.createdAt || '') >= (entry.lastOrderAt || '')) {
      entry.lastOrderAt=row.createdAt;entry.title=row.title || entry.title;entry.asin=row.asin || entry.asin;
    }
    if (['FBA','DBA','MFN'].includes(row.channel)) entry.channels.add(row.channel);
  }
  const stock = db.prepare(`SELECT store_id AS storeId,json_extract(payload_json,'$.sellerSku') AS sku,
    json_extract(payload_json,'$.title') AS title,json_extract(payload_json,'$.asin') AS asin FROM entities
    WHERE source='fba-inventory' AND active=1 AND (? IS NULL OR store_id IN(SELECT value FROM json_each(?)))
    AND typeof(json_extract(payload_json,'$.sellerSku'))='text' AND length(trim(json_extract(payload_json,'$.sellerSku')))>0`).iterate(...args);
  for (const row of stock) {
    const key = JSON.stringify([row.storeId,row.sku]), old = entries.get(key);
    entries.set(key,{ ...old,...row,title:row.title || old?.title,asin:row.asin || old?.asin,
      lastOrderAt:old?.lastOrderAt || null,orderCount:old?.orderCount || 0,channels:new Set([...(old?.channels || []),'FBA']),inInventory:true });
  }
  return [...entries.values()].map(({lastSeenOrder,channels,...row})=>({...row,channels:[...channels]}));
}

export function classifiedSkuRows(db, reader, storeId, cache = {}) {
  const revision = `${db.prepare('PRAGMA data_version').get().data_version}:${db.prepare('SELECT total_changes() n').get().n}`;
  if (cache.revision !== revision) { cache.revision=revision;cache.rows=new Map(); }
  if (!cache.rows.has(storeId)) {
    if (cache.rows.size >= 8) cache.rows.clear();
    cache.rows.set(storeId,skuRows(db,storeId));
  }
  // Linking or changing an ERP cost refreshes classifications independently of
  // the cached SKU identities; only the requested page is sent to the browser.
  const catalogue = reader.read(), stores = new Map(db.prepare('SELECT store_id,name FROM stores').all().map(row=>[row.store_id,row.name]));
  const rows = [];
  for (const row of cache.rows.get(storeId)) {
    const available = !!catalogue?.stores.has(row.storeId), link = catalogue?.link(row.storeId,row.sku), product = catalogue?.resolve(row.storeId,row.sku);
    const unit = costDecimal(product?.averageCost), status = !available ? 'unavailable' : product ? 'linked' : 'unlinked';
    rows.push({ ...row,storeName:stores.get(row.storeId) || row.storeId,title:row.title || row.sku,status,
      source:link?.source || 'unavailable',productId:product?.id || null,productName:product?.name || null,productSku:product?.sku || null,
      linkedProductId:link?.productId || null,version:link?.version || 0,
      brokenLink:!!link?.productId && !product,unitCostCents:unit===null ? null : costCents(unit),canOpen:available,
      sourceUnavailable:!catalogue,editable:available && !catalogue.metadata.stale && link?.source!=='erp' });
  }
  return {rows,catalogue};
}

export function groupSkuRows(rows) {
  const groups=new Map();
  for (const row of rows) {
    const asin=normalizedAsin(row.asin), key=asin ? `asin:${asin}` : JSON.stringify(['sku',row.storeId,row.sku]);
    if (!groups.has(key)) groups.set(key,{groupId:key,asin,members:[]});
    groups.get(key).members.push(row);
  }
  return [...groups.values()].map(group=>{
    const members=group.members.sort((a,b)=>a.storeName.localeCompare(b.storeName,'pt-BR') || a.sku.localeCompare(b.sku,'pt-BR'));
    const products=new Set(members.map(row=>row.linkedProductId).filter(Boolean)), linked=members.filter(row=>row.status==='linked');
    const unavailable=members.filter(row=>row.status==='unavailable').length;
    const status=products.size>1 ? 'conflict' : unavailable===members.length ? 'unavailable' : linked.length===members.length ? 'linked' : linked.length ? 'partial' : 'unlinked';
    const product=products.size===1 ? linked[0] : null;
    const latest=[...members].sort((a,b)=>(b.lastOrderAt || '').localeCompare(a.lastOrderAt || ''))[0];
    return {...group,title:latest.title,lastOrderAt:latest.lastOrderAt,status,skuCount:members.length,
      linkedCount:linked.length,unlinkedCount:members.filter(row=>row.status==='unlinked').length,unavailableCount:unavailable,
      missingCostCount:linked.filter(row=>row.unitCostCents===null).length,editableCount:members.filter(row=>row.editable).length,
      channels:[...new Set(members.flatMap(row=>row.channels))],stores:[...new Map(members.map(row=>[row.storeId,{storeId:row.storeId,name:row.storeName}])).values()],
      productId:product?.productId || null,productName:product?.productName || null,productSku:product?.productSku || null,
      unitCostCents:product?.unitCostCents ?? null,canOpen:members.some(row=>row.canOpen),sourceUnavailable:members.every(row=>row.sourceUnavailable)};
  });
}

export function productSkuList(db, reader, input, cache = {}) {
  const filters=validateProductSkuFilters(input), {rows:skus,catalogue}=classifiedSkuRows(db,reader,filters.storeId,cache);
  const grouped=filters.groupBy==='asin', query=normalize(filters.query);
  const counts={all:0,unlinked:0,linked:0,'missing-cost':0,unavailable:0,...(grouped?{partial:0,conflict:0}:{})};
  // Match groups after forming them, keeping every in-scope SKU visible when
  // searching by one of its aliases or filtering by a fulfillment channel.
  const rows=(grouped?groupSkuRows(skus):skus).filter(row=>{
    const members=grouped?row.members:[row];
    if (filters.mode!=='ALL' && !row.channels.includes(filters.mode)) return false;
    if (query && !members.some(member=>normalize([member.sku,member.title,member.asin,member.productName,member.productSku].join(' ')).includes(query))) return false;
    const missingCost=grouped?row.missingCostCount>0:row.productId && row.unitCostCents===null;
    counts.all++;counts[row.status]++;if(missingCost)counts['missing-cost']++;
    if(grouped && row.unavailableCount && row.status!=='unavailable') counts.unavailable++;
    return filters.linkStatus==='all' || (filters.linkStatus==='missing-cost'?missingCost:grouped && filters.linkStatus==='unavailable'?row.unavailableCount>0:row.status===filters.linkStatus);
  });
  const priority={conflict:0,partial:1,unlinked:2,linked:3,unavailable:4};
  rows.sort((a,b)=>priority[a.status]-priority[b.status] || (b.lastOrderAt || '').localeCompare(a.lastOrderAt || '') || (a.groupId || `${a.sku}:${a.storeId}`).localeCompare(b.groupId || `${b.sku}:${b.storeId}`,'pt-BR'));
  const total=rows.length, offset=total ? Math.min(filters.offset,Math.floor((total-1)/filters.limit)*filters.limit) : 0;
  return { items:rows.slice(offset,offset+filters.limit),total,offset,limit:filters.limit,hasMore:offset+filters.limit<total,counts,
    source:{connected:!!catalogue,stale:catalogue?.metadata.stale || false,observedAt:catalogue?.metadata.observedAt || null},storeId:filters.storeId,groupBy:grouped?'asin':'sku' };
}
