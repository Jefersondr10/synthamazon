import { returnsView } from './returns.mjs';

const key = (storeId, orderId) => JSON.stringify([storeId, orderId]);
const orderIds = item => [...new Set((item.orderIds ?? []).filter(value => typeof value === 'string' && value))];

/** Links identify existing operational records; they do not allocate refunds. */
export function linkRefundReturns(db, cases) {
  const wanted = new Set(), stores = new Set();
  for (const item of cases) {
    for (const orderId of orderIds(item)) {
      wanted.add(key(item.storeId, orderId)); stores.add(item.storeId);
    }
  }
  const customer = new Map(), returned = new Map();
  const records = db.prepare('SELECT return_id,payload_json FROM customer_return_records WHERE store_id=?');
  for (const storeId of stores) {
    for (const record of records.all(storeId)) {
      const { orderId } = JSON.parse(record.payload_json), identity = key(storeId, orderId);
      if (!wanted.has(identity)) continue;
      const links = customer.get(identity) ?? new Map();
      links.set(record.return_id, { returnId: record.return_id, orderId });
      customer.set(identity, links);
    }
    // Reuse the menu's full historical evidence, including later status changes.
    // Its public projection is paginated; consume every page, never just 500 rows.
    let offset = 0, page;
    do {
      page = returnsView({ db, filters: { storeId, limit: 500, offset } });
      for (const row of page.items) {
        const identity = key(row.storeId, row.orderId);
        if (wanted.has(identity)) returned.set(identity, { orderId: row.orderId,
          detectedAt: row.detectedAt, returnStatusChanged: row.returnStatusChanged });
      }
      offset += page.limit;
    } while (page.hasMore);
  }
  return cases.map(item => {
    const customerReturns = new Map(), returnedToSeller = new Map();
    for (const orderId of orderIds(item)) {
      const identity = key(item.storeId, orderId);
      for (const [returnId, link] of customer.get(identity) ?? []) customerReturns.set(returnId, link);
      if (returned.has(identity)) returnedToSeller.set(orderId, returned.get(identity));
    }
    return { ...item, returnLinks: {
      customerReturns: [...customerReturns.values()].sort((a, b) => a.orderId.localeCompare(b.orderId) || a.returnId.localeCompare(b.returnId)),
      returnedToSeller: [...returnedToSeller.values()].sort((a, b) => a.orderId.localeCompare(b.orderId)),
    } };
  });
}
