import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Conservative, per-operation pacing for the initial background import. */
export function pacedHistoryClient(client, { now = Date.now, sleep = delay, onWait = () => {}, signal } = {}) {
  const queues = new Map(), next = new Map();
  const pace = async key => {
    const interval = key === 'searchOrders' ? 200_000 : 2_500;
    const reservation = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const wait = Math.max(0, (next.get(key) ?? 0) - now());
      if (wait) { onWait({ operation: key, waitSeconds: Math.ceil(wait / 1000) }); await sleep(wait, undefined, { signal }); }
      signal?.throwIfAborted();
      next.set(key, now() + interval);
    });
    queues.set(key, reservation);
    await reservation;
  };
  const paginated = new Set(['searchOrders','listTransactions','getInventorySummaries','listFinancialEventGroups','listFinancialEventsByOrderId']);
  return new Proxy(client, { get(target, name) {
    const value = Reflect.get(target, name);
    if (typeof value !== 'function') return value;
    const key = String(name).startsWith('listFinancial') || name === 'listTransactions' ? 'finances' : String(name).includes('Report') ? 'reports' : String(name);
    if (paginated.has(name)) return async function* (...args) {
      const pages = value.apply(target, args);
      try {
        for (;;) {
          await pace(key);
          const page = await pages.next();
          if (page.done) return;
          yield page.value;
          if (!page.value.nextToken) return;
        }
      } finally { await pages.return(); }
    };
    return async (...args) => { await pace(key); return value.apply(target, args); };
  } });
}

/** Cache exact searches in their own store directory; resume from the last cursor. */
export function resumableOrderClient(client, { store, now = () => new Date(), onPage = () => {} }) {
  const search = async function* (parameters) {
    const identity = JSON.stringify({ storeId: store.storeId, parameters });
    const key = createHash('sha256').update(identity).digest('hex');
    const directory = path.join(store.storeDir, 'history-searches');
    const filename = path.join(directory, `${key}.json`);
    let checkpoint = { identity, pages: [], complete: false };
    try {
      checkpoint = JSON.parse(await readFile(filename, 'utf8'));
      if (checkpoint.identity !== identity || !Array.isArray(checkpoint.pages) || checkpoint.pages.length > 1000) throw new Error('INVALID_CHECKPOINT');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let paginationToken;
    const cursors = new Set();
    const acceptCursor = cursor => {
      if (!cursor) return;
      if (typeof cursor !== 'string' || cursor.length > 16_384 || cursors.has(cursor)) throw Object.assign(new Error(), {code:'PAGINATION_CYCLE'});
      cursors.add(cursor);
    };
    for (const saved of checkpoint.pages) {
      const rawBody = await store.readPage({ source: 'orders', hash: saved.hash });
      const body = JSON.parse(rawBody);
      if (!Array.isArray(body.orders)) throw new Error('INVALID_CHECKPOINT');
      paginationToken = body.pagination?.nextToken;
      acceptCursor(paginationToken);
      yield { orders: body.orders, rawBody, nextToken: paginationToken, requestId: saved.requestId, observedAt: saved.observedAt };
    }
    if (checkpoint.complete) return;
    // No cursor means a fully saved final page, even if interruption preceded marking completion.
    if (checkpoint.pages.length && !paginationToken) return;
    for await (const page of client.searchOrders({ ...parameters, ...(paginationToken ? { paginationToken } : {}) })) {
      acceptCursor(page.nextToken);
      const saved = await store.savePage({ source: 'orders', body: page.rawBody });
      const observedAt = now().toISOString();
      checkpoint.pages.push({ hash: saved.hash, requestId: page.requestId, observedAt });
      checkpoint.complete = !page.nextToken;
      await mkdir(directory, { recursive: true });
      const temporary = `${filename}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(checkpoint), { mode: 0o600, flag: 'wx' });
      await rename(temporary, filename);
      onPage({ operation: 'searchOrders', pagesSaved: checkpoint.pages.length, complete: checkpoint.complete });
      yield { ...page, observedAt };
    }
  };
  return new Proxy(client, { get(target, key) {
    if (key === 'searchOrders') return search;
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
