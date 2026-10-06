import { DAY, dayStart, day, covers, orderHistoryWindows } from './sales-history.mjs';
const confirmed = new Set(['SHIPPED','PARTIALLY_SHIPPED','UNSHIPPED']);
const excluded = new Set(['CANCELED','CANCELLED','PENDING','PENDING_AVAILABILITY','UNFULFILLABLE']);
const identity = (store,sku) => JSON.stringify([store,sku]);
const monthStart = (date, delta = 0) => { const [y,m] = day(date).split('-').map(Number); return Date.UTC(y,m-1+delta,1,3); };
const empty = () => ({ units:0, orders:new Set(), channels:{FBA:0,DBA:0,MFN:0}, invalid:0, grossCents:0n, pricedUnits:0, unpricedUnits:0 });
const unitPrice = item => item.unitPriceCurrency==='BRL' && typeof item.unitPriceCents==='string' && /^\d+$/.test(item.unitPriceCents) ? BigInt(item.unitPriceCents) : null;
const revenue = (stats, complete) => ({grossCents:stats.pricedUnits>0?stats.grossCents.toString():null,unpricedUnits:stats.unpricedUnits,grossComplete:complete&&stats.unpricedUnits===0});
function customRange(from,to,today,current) {
  const parse = value => {
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new TypeError('Invalid sales date.');
    const time=Date.parse(`${value}T03:00:00Z`);
    if(!Number.isFinite(time)||day(time)!==value)throw new TypeError('Invalid sales date.');
    return time;
  };
  const start=parse(from), last=parse(to), days=(last-start)/DAY+1;
  if(start>last||last>today||days>3660)throw new TypeError('Invalid sales date range.');
  return {key:'custom',label:'Período personalizado',start,end:Math.min(last+DAY,current),displayEnd:last+DAY,days,ongoing:last===today,previousStart:start-days*DAY,previousEnd:start};
}

export function productSales({orders,coverage,storeIds,channels=['DBA','MFN'],from,to,now=new Date()}) {
  if (!Array.isArray(channels) || !channels.length || channels.length>3 || new Set(channels).size!==channels.length || channels.some(channel=>!['FBA','DBA','MFN'].includes(channel))) throw new TypeError('Invalid sales channels.');
  const selectedChannels = ['FBA','DBA','MFN'].filter(channel=>channels.includes(channel));
  const current=Number(new Date(now));
  if (!Number.isFinite(current)) throw new TypeError('Invalid analysis date.');
  const today=dayStart(current), histories=new Map(storeIds.map(id=>[id,orderHistoryWindows(coverage,id)]));
  const latest=[...histories.values()].filter(w=>w.length).map(w=>Math.min(today,dayStart(Math.max(...w.map(r=>r[1])))));
  const end=latest.length?Math.min(...latest):today;
  const currentMonth=monthStart(today), priorMonth=monthStart(today,-1), earlierMonth=monthStart(today,-2);
  const ranges=[{key:'7',label:'7 dias',start:end-7*DAY,end,previousStart:end-14*DAY,previousEnd:end-7*DAY},
    {key:'30',label:'30 dias',start:end-30*DAY,end,previousStart:end-60*DAY,previousEnd:end-30*DAY},
    {key:'month',label:'Mês atual',start:currentMonth,end:current,displayEnd:today+DAY,days:(today-currentMonth)/DAY+1,ongoing:true,previousStart:priorMonth,previousEnd:Math.min(currentMonth,priorMonth+today-currentMonth+DAY)},
    {key:'previousMonth',label:'Mês anterior',start:priorMonth,end:currentMonth,previousStart:earlierMonth,previousEnd:priorMonth},
    {key:'today',label:'Dia atual',start:today,end:current,displayEnd:today+DAY,days:1,ongoing:true,previousStart:today-DAY,previousEnd:today},
    {key:'yesterday',label:'Dia anterior',start:today-DAY,end:today,previousStart:today-2*DAY,previousEnd:today-DAY}];
  if(from!==undefined||to!==undefined)ranges.push(customRange(from,to,today,current));
  const catalog=new Map(), scope=new Set(storeIds);
  const periods=Object.fromEntries(ranges.map(range=>[range.key,{...range, current:empty(),previous:empty(), daily:new Map(),items:new Map()}]));
  for (const order of orders) {
    if (!scope.has(order.storeId) || !selectedChannels.includes(order.fulfillmentMode)) continue;
    const status=String(order.status||'').toUpperCase(); if(excluded.has(status)) continue;
    const time=typeof order.createdAt==='string'?Date.parse(order.createdAt):NaN;
    const orderKey=identity(order.storeId,order.orderId);
    for (const range of Object.values(periods)) {
      const sides=!Number.isFinite(time)?['current','previous']:time>=range.start&&time<range.end?['current']:time>=range.previousStart&&time<range.previousEnd?['previous']:[];
      if (!sides.length) continue;
      if (!confirmed.has(status) || !Number.isFinite(time) || !order.items?.length) { for(const side of sides)range[side].invalid++; continue; }
      for(const item of order.items) {
        if (!item.sku || !Number.isSafeInteger(item.quantityOrdered) || item.quantityOrdered<0) { for(const side of sides)range[side].invalid++; continue; }
        const key=identity(order.storeId,item.sku);
        if(!catalog.has(key))catalog.set(key,{storeId:order.storeId,sku:item.sku,asin:item.asin||null,title:item.title||item.sku});
        let product=range.items.get(key); if(!product){product={current:empty(),previous:empty()};range.items.set(key,product);}
        for(const side of sides){
          const units=item.quantityOrdered, price=unitPrice(item);
          for(const target of [range[side],product[side]]) {
            target.units+=units; if(units>0)target.orders.add(orderKey); target.channels[order.fulfillmentMode]+=units;
            if(price===null) target.unpricedUnits+=units;
            else {target.grossCents+=price*BigInt(units);target.pricedUnits+=units;}
          }
          if(side==='current') {const date=day(time);range.daily.set(date,(range.daily.get(date)||0)+units);}
        }
      }
    }
  }
  const complete=(from,to) => storeIds.length>0 && [...histories.values()].every(w=>covers(w,from,to));
  const views=Object.values(periods).map(range=>{
    const days=range.days??(range.end-range.start)/DAY, previousDays=(range.previousEnd-range.previousStart)/DAY;
    const currentComplete=!range.ongoing&&complete(range.start,range.end)&&!range.current.invalid;
    const missingStoreIds=storeIds.filter(id=>!covers(histories.get(id),range.start,range.end));
    const previousComplete=complete(range.previousStart,range.previousEnd)&&!range.previous.invalid;
    const items=[...range.items].map(([id,product])=>({id,...catalog.get(id),units:product.current.units,orders:product.current.orders.size,
      channels:product.current.channels,...revenue(product.current,currentComplete),averageDaily:currentComplete&&days>0?product.current.units/days:null,
      previousUnits:product.previous.units,previousAverageDaily:previousComplete&&previousDays>0?product.previous.units/previousDays:null,
      changePercent:currentComplete&&previousComplete&&product.previous.units>0?(product.current.units-product.previous.units)/product.previous.units*100:null})).sort((a,b)=>b.units-a.units||a.sku.localeCompare(b.sku)||a.storeId.localeCompare(b.storeId));
    return {key:range.key,label:range.label,from:day(range.start),to:days>0?day((range.displayEnd??range.end)-DAY):null,days,ongoing:Boolean(range.ongoing),
      previous:{from:day(range.previousStart),to:previousDays>0?day(range.previousEnd-DAY):null,days:previousDays,units:range.previous.units,complete:previousComplete},
      complete:currentComplete,missingStoreIds,invalidRecords:range.current.invalid,summary:{units:range.current.units,orders:range.current.orders.size,
        products:items.filter(i=>i.units>0).length,averageDaily:currentComplete&&days>0?range.current.units/days:null,channels:range.current.channels,...revenue(range.current,currentComplete),
        changePercent:currentComplete&&previousComplete&&range.previous.units>0?(range.current.units-range.previous.units)/range.previous.units*100:null},
      daily:Array.from({length:days},(_,i)=>{const date=day(range.start+i*DAY);return{date,units:range.daily.get(date)||0};}),items};
  });
  return {generatedAt:new Date(current).toISOString(),today:day(today),asOf:day(end-DAY),lagDays:(today-end)/DAY,storeIds,channels:selectedChannels,views};
}
