import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { Repository } from '../domain/repository.mjs';

const mutations = new Set(['saveProductCostGroup','saveProductCostLink','loadWorkspace','syncRefundManagement','saveFinancialReview','saveFinancialReviews','saveLocalReview','saveRefundManagement','saveReturnedManagement','saveReviewStatus','saveSalesAlert']);
const methods = new Set(['productCostGroup','productSkuList','productCostLink','syncSalesAlerts','salesAlerts',...mutations,'customerReturns','dashboard','dashboardTransactions','financialCaseDetail','financialCases','getBootstrap','inventory','localReview','orderDetail','orders','productPanel','productSales','refundManagement','refundManagementDetail','returns','reviewStatusSettings','safeTCases']);
const unavailable = () => Object.assign(new Error('Repository unavailable.'), {code:'REPOSITORY_UNAVAILABLE'});
const quickReads = new Set(['productCostLink','getBootstrap','reviewStatusSettings','localReview','salesAlerts']);

// Dedicated connections keep synchronous SQLite/projections off the HTTP loop.
// Writes have their own lane, so an unrelated large report cannot delay a save.
export async function createRepositoryWorkers(options, {maxPending = 64, workerFactory = (url, config) => new Worker(url, config)} = {}) {
  const lanes = [];
  let closed = false;
  async function lane(name) {
    const worker = workerFactory(new URL(import.meta.url), {workerData:options, name});
    const pending = new Map();
    const inFlightReads = new Map();
    let nextId = 0, dead = false, readyResolve, readyReject;
    const ready = new Promise((resolve,reject) => {readyResolve=resolve;readyReject=reject;});
    const fail = () => {
      dead = true; readyReject(unavailable());
      for (const call of pending.values()) call.reject(unavailable());
      pending.clear();
    };
    worker.on('error',fail); worker.on('exit',fail);
    worker.on('message',message => {
      if (message.ready) {readyResolve();return;}
      const call = pending.get(message.id); if (!call) return;
      pending.delete(message.id);
      if (message.error) {
        const error = message.error.name==='TypeError' ? new TypeError(message.error.message) : new Error(message.error.message);
        if (message.error.code) error.code=message.error.code;
        call.reject(error);
      } else call.resolve(message.value);
    });
    const entry = {
      call(method,args) {
        if (closed || dead) return Promise.reject(unavailable());
        const key = !mutations.has(method) && method !== 'syncSalesAlerts' ? JSON.stringify([method,args]) : null;
        if (key && inFlightReads.has(key)) return inFlightReads.get(key);
        if (pending.size >= maxPending) return Promise.reject(Object.assign(new Error('Repository busy.'),{code:'REPOSITORY_BUSY'}));
        const request = new Promise((resolve,reject) => {
          const id=++nextId;pending.set(id,{resolve,reject});
          try {worker.postMessage({id,method,args});} catch(error) {pending.delete(id);reject(error);}
        });
        if (!key) return request;
        const shared = request.finally(() => inFlightReads.delete(key));
        inFlightReads.set(key,shared);
        return shared;
      },
      async close() {await worker.terminate();}
    };
    lanes.push(entry); await ready; return entry;
  }
  try {
    // Start connections serially. Initial navigation and physical stock must
    // never queue behind a financial projection or a demand calculation.
    const reads=await lane('reports'),writes=await lane('writes'),analytics=await lane('alerts');
    const quick=await lane('navigation'),inventory=await lane('inventory');
    const api = Object.fromEntries([...methods].map(method => [method,(...args)=>{
      const target = method==='syncSalesAlerts' ? analytics : mutations.has(method) ? writes
        : quickReads.has(method) || method==='inventory' && args[0]?.forecast!=='true' ? quick
        : method==='inventory' ? inventory : reads;
      return target.call(method,args);
    }]));
    api.close = async () => {closed=true;await Promise.all(lanes.map(item=>item.close()));};
    return api;
  } catch(error) {closed=true;await Promise.all(lanes.map(item=>item.close()));throw error;}
}

if (!isMainThread) {
  const repository = new Repository(workerData);
  let queue = Promise.resolve();
  parentPort.on('message',message => {
    queue=queue.then(async () => {
      try {
        if (!methods.has(message.method)) throw new TypeError('Invalid repository method.');
        const value = message.method==='getBootstrap' ? await repository.getBootstrap({...message.args[0],synchronize:false}) : await repository[message.method](...message.args);
        parentPort.postMessage({id:message.id,value});
      } catch(error) {
        parentPort.postMessage({id:message.id,error:{name:error.name,code:error.code,message:error.message}});
      }
    });
  });
  parentPort.postMessage({ready:true});
}
