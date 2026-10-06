import { canonicalStoreSelection, storeArgs } from './store-filter.mjs';
import { salesAlertSignals } from './sales-alert-signals.mjs';
import { DAY } from './sales-history.mjs';

export function ensureSalesAlertSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS sales_alerts (
    id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES stores(store_id), sku TEXT NOT NULL, channel TEXT NOT NULL,
    type TEXT NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL, episode INTEGER NOT NULL,
    detected_at TEXT NOT NULL, updated_at TEXT NOT NULL, notified_at TEXT NOT NULL, seen_at TEXT, snooze_until TEXT,
    acknowledged_json TEXT, payload_json TEXT NOT NULL, change_reason TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sales_alert_scope ON sales_alerts(store_id,state,notified_at);
  CREATE TABLE IF NOT EXISTS sales_alert_analysis (store_id TEXT PRIMARY KEY REFERENCES stores(store_id), checked_at TEXT NOT NULL, as_of TEXT NOT NULL, ready INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS idx_recent_sales_orders ON entities(CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.createdAt') END) WHERE source='orders' AND active=1;`);
}
const metrics = item => ({type:item.type,averageDaily:item.averageDaily,changePercent:item.changePercent,impactWeekly:item.impactWeekly,daysWithoutSales:item.daysWithoutSales});
function materialChange(previous,next,notifiedAt,now) {
  if (previous.type!==next.type) return true;
  if (Date.parse(now)-Date.parse(notifiedAt)<7*DAY) return false;
  if(next.type==='drop')return next.changePercent<=previous.changePercent-20&&next.averageDaily<=previous.averageDaily*.7&&next.impactWeekly>=previous.impactWeekly+3;
  if(next.type==='surge')return next.changePercent>=previous.changePercent+50&&next.averageDaily>=previous.averageDaily*1.5&&next.impactWeekly>=previous.impactWeekly+5;
  // An unchanged stopped product never becomes a new alert on every refresh.
  return false;
}
export function syncSalesAlerts(db,input) {
  const result=salesAlertSignals(input),now=result.generatedAt,products=new Map(result.products.map(p=>[p.id,p]));
  const ready=new Set(result.stores.filter(s=>s.ready).map(s=>s.storeId));
  const rows=[];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const store of result.stores) db.prepare(`INSERT INTO sales_alert_analysis VALUES(?,?,?,?) ON CONFLICT(store_id) DO UPDATE SET checked_at=excluded.checked_at,as_of=excluded.as_of,ready=excluded.ready`).run(store.storeId,now,result.asOf,store.ready?1:0);
    for (const old of db.prepare('SELECT * FROM sales_alerts').all()) {
      if(!ready.has(old.store_id))continue;
      const product=products.get(old.id);products.delete(old.id);
      if(!product||product.resolved) {
        if(old.state!=='resolved') db.prepare("UPDATE sales_alerts SET state='resolved',version=version+1,updated_at=?,snooze_until=NULL,change_reason=? WHERE id=?").run(now,!product?'inactive':product.resolution,old.id);
        continue;
      }
      if(!product.type)continue; // unstable signals are not a recovery or a new notification
      const acknowledged=JSON.parse(old.acknowledged_json||'null');
      let state=old.state,reason=old.change_reason,episode=old.episode,notified=old.notified_at,version=old.version,snooze=old.snooze_until;
      if(state==='resolved') {state='new';reason='recurrence';episode++;notified=now;version++;}
      else if(state==='snoozed') {if(snooze<=now){state='new';reason='reminder';notified=now;version++;snooze=null;}}
      else if(state==='seen'&&acknowledged&&materialChange(acknowledged,product,old.seen_at||old.notified_at,now)) {state='new';reason='changed';notified=now;version++;}
      db.prepare(`UPDATE sales_alerts SET type=?,state=?,version=?,episode=?,updated_at=?,notified_at=?,snooze_until=?,payload_json=?,change_reason=? WHERE id=?`)
        .run(product.type,state,version,episode,now,notified,snooze,JSON.stringify(product),reason,old.id);
    }
    for(const product of products.values()) {
      if(!product.type)continue;
      db.prepare('INSERT INTO sales_alerts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(product.id,product.storeId,product.sku,product.channel,product.type,'new',1,1,now,now,now,null,null,null,JSON.stringify(product),'detected');
      rows.push(product.id);
    }
    db.exec('COMMIT');
  } catch(error){db.exec('ROLLBACK');throw error;}
  return {created:rows.length,asOf:result.asOf,stores:result.stores};
}
export function validateSalesAlertAction(input) {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['id','storeId','action','days','expectedVersion'].includes(k))
    || typeof input.id!=='string' || !/^[a-f0-9]{64}$/.test(input.id) || typeof input.storeId!=='string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.storeId) || input.storeId==='all'
    || !['seen','snooze','new'].includes(input.action) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion<1
    || (input.action==='snooze'?![7,15,30].includes(input.days):input.days!==undefined)) throw new TypeError('Invalid sales alert action.');
  return input;
}
const deserialize = row => ({...JSON.parse(row.payload_json),id:row.id,type:row.type,state:row.state,version:row.version,episode:row.episode,detectedAt:row.detected_at,updatedAt:row.updated_at,notifiedAt:row.notified_at,seenAt:row.seen_at,snoozeUntil:row.snooze_until,acknowledged:JSON.parse(row.acknowledged_json||'null'),changeReason:row.change_reason});
export function saveSalesAlert(db,action,now=new Date()) {
  validateSalesAlertAction(action);
  const at=new Date(now).toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const old=db.prepare('SELECT * FROM sales_alerts WHERE id=? AND store_id=?').get(action.id,action.storeId);
    if(!old)throw Object.assign(new Error('Alert not found.'),{code:'CASE_NOT_FOUND'});
    if(old.version!==action.expectedVersion||old.state==='resolved')throw Object.assign(new Error('Alert changed.'),{code:'REVIEW_CONFLICT'});
    const state=action.action==='snooze'?'snoozed':action.action;
    const snooze=state==='snoozed'?new Date(Date.parse(at)+action.days*DAY).toISOString():null;
    db.prepare('UPDATE sales_alerts SET state=?,version=version+1,seen_at=?,snooze_until=?,acknowledged_json=?,updated_at=? WHERE id=?')
      .run(state,at,snooze,JSON.stringify(metrics(JSON.parse(old.payload_json))),at,old.id);
    const result=deserialize(db.prepare('SELECT * FROM sales_alerts WHERE id=?').get(old.id));
    db.exec('COMMIT');return result;
  }catch(error){db.exec('ROLLBACK');throw error;}
}
export function salesAlertsView(db,filters={}) {
  const store=canonicalStoreSelection(filters.storeId);
  const channel=filters.mode&&filters.mode!=='all'?filters.mode:null,type=filters.type&&filters.type!=='all'?filters.type:null;
  const query=String(filters.query||'').trim().toLocaleLowerCase('pt-BR'),state=filters.status||'new';
  const all=db.prepare('SELECT * FROM sales_alerts WHERE (? IS NULL OR store_id IN (SELECT value FROM json_each(?))) AND (? IS NULL OR channel=?) AND (? IS NULL OR type=?) ORDER BY notified_at DESC').all(...storeArgs(store),channel,channel,type,type).map(deserialize)
    .filter(item=>!query||[item.title,item.sku,item.asin].join(' ').toLocaleLowerCase('pt-BR').includes(query));
  const counts={new:0,seen:0,snoozed:0,resolved:0};for(const item of all)counts[item.state]++;
  const rows=all.filter(item=>item.state===state).sort((a,b)=>({stopped:0,drop:1,surge:2}[a.type]-{stopped:0,drop:1,surge:2}[b.type])||b.impactWeekly-a.impactWeekly||b.notifiedAt.localeCompare(a.notifiedAt));
  const offset=Number(filters.offset)||0,limit=Math.min(100,Number(filters.limit)||24);
  const analysis=db.prepare('SELECT store_id AS storeId,checked_at AS checkedAt,as_of AS asOf,ready FROM sales_alert_analysis WHERE (? IS NULL OR store_id IN (SELECT value FROM json_each(?)))').all(...storeArgs(store));
  return {items:rows.slice(offset,offset+limit),counts,total:rows.length,offset,limit,hasMore:offset+limit<rows.length,analysis};
}
